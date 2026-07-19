import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { codexConfigArguments, providerEnvironmentForTarget } from "../../accounts";
import type { RoutingTarget } from "../../providers/types";
import type {
  McpBroker, McpBrokerOpenOptions, McpBrokerSession, McpServerInventory,
  McpToolCall, McpToolDefinition, McpToolResult, ModelFreeBrokerTransportReceipt,
  PreparedMcpToolCall,
} from "./mcp-broker";
import { normalizeLinearOpaqueToken } from "./normalize";
import { parseStrictJson, StrictJsonlFrames } from "../../strict-json";

export { StrictJsonlFrames } from "../../strict-json";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_INVENTORY_PAGES = 20;
const MAX_MCP_SERVERS = 100;
const MODEL_FREE_PROTOCOL_POLICY = "codex-app-server-linear-v1";
const SAFE_OUTGOING_METHODS = new Map<string, "request" | "notification">([
  ["initialize", "request"],
  ["initialized", "notification"],
  ["thread/start", "request"],
  ["mcpServerStatus/list", "request"],
  ["mcpServer/tool/call", "request"],
]);
const SAFE_INCOMING_NOTIFICATIONS = new Set([
  "mcpServer/startupStatus/updated",
  "remoteControl/status/changed",
  "thread/started",
]);

type RpcId = number | string;
type SpawnProcess = typeof spawn;

export interface AppServerBrokerOptions {
  command?: string;
  /** Arguments inserted before `app-server --stdio`; useful for wrappers and tests. */
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Account whose ChatGPT subscription owns the model-free MCP transport. */
  target?: RoutingTarget;
  timeoutMs?: number;
  spawnProcess?: SpawnProcess;
  onNotification?: (method: string, params: unknown) => void;
}

interface PendingRequest {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function increment(counter: Map<string, number>, method: string): void {
  counter.set(method, (counter.get(method) ?? 0) + 1);
}

function sortedCounter(counter: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries([...counter].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function assertSafeOutgoingMethod(method: string, kind: "request" | "notification"): void {
  if (SAFE_OUTGOING_METHODS.get(method) !== kind) {
    throw new Error(`North's ${MODEL_FREE_PROTOCOL_POLICY} broker refuses provider ${kind} ${method}`);
  }
}

function encodeOutgoingJsonl(value: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("Codex app-server request is not JSON-serializable"); }
  if (encoded === undefined)
    throw new Error("Codex app-server request is not JSON-serializable");
  if (Buffer.byteLength(encoded, "utf8") > MAX_LINE_BYTES)
    throw new Error("Codex app-server JSONL request exceeded 1 MiB");
  return `${encoded}\n`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolDefinition(name: string, value: unknown): McpToolDefinition {
  normalizeLinearOpaqueToken("MCP tool name", name, 256);
  if (!record(value) || typeof value.name !== "string" || value.name !== name || !("inputSchema" in value))
    throw new Error("Codex app-server returned an invalid MCP tool schema");
  return {
    name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    inputSchema: value.inputSchema,
    ...("outputSchema" in value ? { outputSchema: value.outputSchema } : {}),
    ...(record(value.annotations) ? { annotations: value.annotations } : {}),
  };
}

class JsonlRpcClient {
  private nextId = 0;
  private pending = new Map<RpcId, PendingRequest>();
  private frames = new StrictJsonlFrames({
    label: "Codex app-server",
    maxLineBytes: MAX_LINE_BYTES,
  });
  private terminalError?: Error;
  private closePromise?: Promise<void>;
  private closingByClient = false;
  private closed = false;
  private childExited = false;
  private childClosed = false;
  private stdoutEnded = false;
  private childClose: Promise<void>;
  private resolveChildClose!: () => void;
  private outgoingMethods = new Map<string, number>();
  private incomingNotifications = new Map<string, number>();

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private timeoutMs: number,
    private onNotification?: (method: string, params: unknown) => void,
  ) {
    this.childClose = new Promise((resolve) => { this.resolveChildClose = resolve; });
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stdout.on("end", () => this.onStdoutEnd());
    child.stdout.on("error", () => {
      if (!this.closingByClient && !this.closed)
        this.fail(new Error("Codex app-server stdout failed"));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => { /* drain only; provider diagnostics may contain secrets */ });
    child.stderr.on("error", () => { /* diagnostics are non-authoritative; prevent an unhandled stream error */ });
    child.stdin.on("error", () => {
      if (!this.closingByClient && !this.closed)
        this.fail(new Error("Codex app-server stdin failed"));
    });
    child.on("error", () => this.fail(new Error("could not start Codex app-server")));
    child.on("exit", () => this.onChildExit());
    child.on("close", () => {
      this.childExited = true;
      if (!this.stdoutEnded) this.onStdoutEnd();
      this.childClosed = true;
      this.resolveChildClose();
    });
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closed && !this.closingByClient
        && this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill("SIGTERM"); }
      catch { /* the original terminal error remains authoritative */ }
    }
  }

  private rejectServerRequest(id: RpcId, _method: string): void {
    const response = { id, error: { code: -32601, message: "North's model-free MCP broker does not accept server requests" } };
    this.child.stdin.write(`${JSON.stringify(response)}\n`, () => {});
    this.fail(new Error("Codex app-server sent an unsupported server request; request rejected"));
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = parseStrictJson(line, "Codex app-server JSONL response", {
        maxBytes: MAX_LINE_BYTES,
      });
    }
    catch (error) {
      this.fail(error instanceof Error && error.message.includes("duplicate object keys")
        ? error
        : new Error("Codex app-server emitted malformed JSONL output"));
      return;
    }
    if (!record(message)) {
      this.fail(new Error("Codex app-server emitted a non-object JSONL message"));
      return;
    }
    if (typeof message.method === "string") {
      if ("id" in message) {
        const requestId = message.id;
        if (typeof requestId !== "number" && typeof requestId !== "string") {
          this.fail(new Error("Codex app-server emitted a malformed server request identifier"));
          return;
        }
        if (typeof requestId === "string")
          normalizeLinearOpaqueToken("app-server request id", requestId, 256);
        this.rejectServerRequest(requestId, message.method);
        return;
      }
      increment(this.incomingNotifications, message.method);
      if (!SAFE_INCOMING_NOTIFICATIONS.has(message.method)) {
        this.fail(new Error(
          `Codex app-server notification ${message.method} is not allowed by ${MODEL_FREE_PROTOCOL_POLICY}`,
        ));
        return;
      }
      this.onNotification?.(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") {
      this.fail(new Error("Codex app-server emitted an unrecognized JSONL message"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.fail(new Error("Codex app-server emitted a response for an unknown request"));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const hasError = "error" in message;
    const hasResult = "result" in message;
    if (hasError === hasResult) {
      const error = new Error(`Codex app-server ${pending.method} returned an invalid response envelope`);
      pending.reject(error);
      this.fail(error);
    } else if (hasError) pending.reject(new Error(`Codex app-server ${pending.method} failed`));
    else pending.resolve(message.result);
  }

  private onStdout(chunk: Buffer): void {
    try {
      for (const line of this.frames.push(chunk)) {
        this.onLine(line);
        if (this.terminalError) return;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Codex app-server emitted invalid JSONL output"));
    }
  }

  private onStdoutEnd(): void {
    if (this.stdoutEnded) return;
    this.stdoutEnded = true;
    try { this.frames.finish(); }
    catch (error) {
      this.fail(error instanceof Error ? error : new Error("Codex app-server closed with a partial JSONL frame"));
      return;
    }
    if (this.childExited && !this.closingByClient && !this.terminalError)
      this.fail(new Error("Codex app-server transport exited unexpectedly"));
  }

  private onChildExit(): void {
    this.childExited = true;
    // Node may emit `exit` before it has drained the child's stdout. Defer the
    // generic death classification so a buffered invalid/partial frame remains
    // the authoritative terminal error when `end` arrives.
    if (this.stdoutEnded && !this.closingByClient && !this.terminalError)
      this.fail(new Error("Codex app-server transport exited unexpectedly"));
  }

  private failUndrainedStdout(): void {
    if (this.stdoutEnded || this.terminalError) return;
    try { this.frames.finish(); }
    catch (error) {
      this.fail(error instanceof Error ? error : new Error("Codex app-server closed with a partial JSONL frame"));
      return;
    }
    this.fail(new Error("Codex app-server stdout did not close after transport exit"));
  }

  prepareRequest(method: string, params: unknown): { dispatch(): Promise<unknown> } {
    if (this.terminalError) throw this.terminalError;
    if (this.closePromise || this.closed) throw new Error("Codex app-server broker is closed");
    assertSafeOutgoingMethod(method, "request");
    const id = ++this.nextId;
    const line = encodeOutgoingJsonl({ id, method, params });
    let dispatched = false;
    return {
      dispatch: () => {
        if (dispatched)
          throw new Error(`Codex app-server ${method} prepared call was already dispatched`);
        dispatched = true;
        if (this.terminalError) throw this.terminalError;
        if (this.closePromise || this.closed) throw new Error("Codex app-server broker is closed");
        increment(this.outgoingMethods, method);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            const error = new Error(`Codex app-server ${method} timed out after ${this.timeoutMs}ms`);
            pending.reject(error);
            this.fail(error);
          }, this.timeoutMs);
          timer.unref?.();
          this.pending.set(id, { method, timer, resolve, reject });
          this.child.stdin.write(line, (error) => {
            if (!error) return;
            this.fail(new Error(`Codex app-server ${method} write failed`));
          });
        });
      },
    };
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.prepareRequest(method, params).dispatch();
  }

  notify(method: string, params?: unknown): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closePromise || this.closed) throw new Error("Codex app-server broker is closed");
    assertSafeOutgoingMethod(method, "notification");
    const notification = params === undefined ? { method } : { method, params };
    const line = encodeOutgoingJsonl(notification);
    increment(this.outgoingMethods, method);
    this.child.stdin.write(line, (error) => {
      if (error) this.fail(new Error(`Codex app-server ${method} notification failed`));
    });
  }

  transportReceipt(
    ephemeralThread: boolean,
    mcpCalls: ModelFreeBrokerTransportReceipt["mcpCalls"],
  ): ModelFreeBrokerTransportReceipt {
    if (this.terminalError) throw this.terminalError;
    return {
      transport: "codex-app-server",
      policy: MODEL_FREE_PROTOCOL_POLICY,
      ephemeralThread,
      outgoingMethods: sortedCounter(this.outgoingMethods),
      incomingNotifications: sortedCounter(this.incomingNotifications),
      mcpCalls,
      modelTurnsStarted: 0,
      usageEvents: 0,
      tokenTotalStatus: "exact-zero-protocol",
    };
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    if (this.closed) {
      if (this.terminalError) throw this.terminalError;
      return;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server broker closed"));
    }
    this.pending.clear();

    const waitForClose = async (): Promise<boolean> => {
      if (this.childClosed) return true;
      return Promise.race([
        this.childClose.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
    };

    let live = !this.childExited
      && this.child.exitCode === null
      && this.child.signalCode === null;
    if (!this.terminalError && live) {
      // A response and the provider's own exit can be queued in adjacent I/O
      // callbacks. Give that already-initiated exit one bounded turn to become
      // observable before deciding that North owns shutdown.
      await Promise.race([
        this.childClose,
        new Promise<void>((resolve) => setTimeout(resolve, 10)),
      ]);
      live = !this.childExited
        && this.child.exitCode === null
        && this.child.signalCode === null;
    }
    if (!this.terminalError && live) {
      let signalled = false;
      try { signalled = this.child.kill("SIGTERM"); }
      catch { signalled = false; }
      // `kill(true)` is the only evidence that shutdown was initiated by this
      // client. Merely entering close() must not launder a provider self-exit
      // into a valid transport receipt.
      if (signalled) this.closingByClient = true;
    }

    let drained = await waitForClose();
    if (!drained && this.child.exitCode === null && this.child.signalCode === null) {
      // A terminal protocol failure may already have sent SIGTERM from fail().
      // Escalate it too, without relabeling that failure cleanup as a
      // client-initiated successful shutdown.
      try { this.child.kill("SIGKILL"); }
      catch { /* classified below if the close event still never arrives */ }
      drained = await waitForClose();
    }
    if (!drained && !this.terminalError) {
      if (!this.stdoutEnded) this.failUndrainedStdout();
      else this.fail(new Error("Codex app-server transport did not close after termination"));
    }
    if (!this.closingByClient && !this.terminalError)
      this.fail(new Error("Codex app-server transport exited unexpectedly"));
    this.closed = true;
    if (this.terminalError) throw this.terminalError;
  }
}

class AppServerSession implements McpBrokerSession {
  private mcpCalls = new Map<string, {
    server: string;
    tool: string;
    access: McpToolCall["access"];
    count: number;
  }>();

  constructor(private rpc: JsonlRpcClient, private threadId: string) {}

  async listServers(): Promise<readonly McpServerInventory[]> {
    const servers: McpServerInventory[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 1; pageNumber <= MAX_INVENTORY_PAGES; pageNumber++) {
      const response = await this.rpc.request("mcpServerStatus/list", {
        threadId: this.threadId,
        detail: "toolsAndAuthOnly",
        ...(cursor ? { cursor } : {}),
      });
      if (!record(response) || !Array.isArray(response.data))
        throw new Error("Codex app-server returned an invalid MCP server inventory");
      for (const raw of response.data) {
        if (!record(raw) || typeof raw.name !== "string" || typeof raw.authStatus !== "string" || !record(raw.tools))
          throw new Error("Codex app-server returned an invalid MCP server entry");
        const name = normalizeLinearOpaqueToken("MCP server name", raw.name, 256);
        const authStatus = normalizeLinearOpaqueToken("MCP auth status", raw.authStatus, 128);
        const tools: Record<string, McpToolDefinition> = {};
        for (const [name, value] of Object.entries(raw.tools)) tools[name] = toolDefinition(name, value);
        servers.push({ name, authStatus, tools });
        if (servers.length > MAX_MCP_SERVERS)
          throw new Error(`Codex app-server returned more than ${MAX_MCP_SERVERS} MCP servers`);
      }
      if (response.nextCursor == null) return servers;
      let nextCursor: string;
      try {
        nextCursor = normalizeLinearOpaqueToken(
          "MCP inventory cursor",
          response.nextCursor as string,
          4096,
        );
      } catch {
        throw new Error("Codex app-server returned an invalid MCP inventory cursor");
      }
      if (seenCursors.has(nextCursor))
        throw new Error("Codex app-server returned an invalid MCP inventory cursor");
      cursor = nextCursor;
      seenCursors.add(cursor);
      if (pageNumber === MAX_INVENTORY_PAGES)
        throw new Error(`Codex app-server MCP inventory exceeded ${MAX_INVENTORY_PAGES} pages`);
    }
    throw new Error(`Codex app-server MCP inventory exceeded ${MAX_INVENTORY_PAGES} pages`);
  }

  prepareTool(call: McpToolCall): PreparedMcpToolCall {
    if (call.access !== "read" && call.access !== "write") throw new Error("MCP tool call must declare read or write access");
    const callKey = JSON.stringify([call.server, call.tool, call.access]);
    const prepared = this.rpc.prepareRequest("mcpServer/tool/call", {
      threadId: this.threadId,
      server: call.server,
      tool: call.tool,
      arguments: call.arguments,
    });
    return {
      dispatch: async () => {
        const prior = this.mcpCalls.get(callKey);
        this.mcpCalls.set(callKey, {
          server: call.server,
          tool: call.tool,
          access: call.access,
          count: (prior?.count ?? 0) + 1,
        });
        const response = await prepared.dispatch();
        if (!record(response) || !Array.isArray(response.content))
          throw new Error("Codex app-server returned an invalid MCP tool result");
        if (response.isError !== undefined && typeof response.isError !== "boolean")
          throw new Error("Codex app-server returned a non-boolean MCP isError value");
        return {
          content: response.content,
          ...(response.structuredContent !== undefined
            ? { structuredContent: response.structuredContent } : {}),
          isError: response.isError ?? false,
        };
      },
    };
  }

  callTool(call: McpToolCall): Promise<McpToolResult> {
    return this.prepareTool(call).dispatch();
  }

  transportReceipt(): ModelFreeBrokerTransportReceipt {
    const mcpCalls = [...this.mcpCalls.values()].sort((left, right) => {
      const leftKey = JSON.stringify([left.server, left.tool, left.access]);
      const rightKey = JSON.stringify([right.server, right.tool, right.access]);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    return this.rpc.transportReceipt(true, mcpCalls);
  }

  close(): Promise<void> { return this.rpc.close(); }
}

function awaitSpawn(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Codex app-server spawn timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    child.once("spawn", () => { clearTimeout(timer); resolve(); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("could not start Codex app-server")); });
  });
}

/** Codex subscription-backed MCP transport. It never starts a model turn. */
export class AppServerMcpBroker implements McpBroker {
  constructor(private options: AppServerBrokerOptions = {}) {}

  async open(options: McpBrokerOpenOptions = {}): Promise<McpBrokerSession> {
    const env = providerEnvironmentForTarget("openai", this.options.target, {
      env: this.options.env ?? process.env,
    });
    const command = this.options.command ?? env.NORTH_CODEX_BIN ?? "codex";
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = (this.options.spawnProcess ?? spawn)(
      command,
      [...(this.options.commandArgs ?? []), ...codexConfigArguments(env), "app-server", "--stdio"],
      { cwd: options.cwd ?? process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const rpc = new JsonlRpcClient(child, timeoutMs, this.options.onNotification);
    try {
      await awaitSpawn(child, timeoutMs);
      // Deliberately omit experimentalApi and every elicitation capability.
      await rpc.request("initialize", { clientInfo: { name: "north", title: "North", version: "1" } });
      rpc.notify("initialized", {});
      const started = await rpc.request("thread/start", { cwd: options.cwd ?? process.cwd(), ephemeral: true });
      if (!record(started) || !record(started.thread) || typeof started.thread.id !== "string")
        throw new Error("Codex app-server returned an invalid ephemeral thread");
      return new AppServerSession(
        rpc,
        normalizeLinearOpaqueToken("ephemeral thread id", started.thread.id, 512),
      );
    } catch (error) {
      try { await rpc.close(); }
      catch { /* preserve the handshake/capability failure */ }
      throw error;
    }
  }
}
