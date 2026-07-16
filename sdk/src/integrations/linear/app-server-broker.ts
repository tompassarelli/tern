import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  McpBroker, McpBrokerOpenOptions, McpBrokerSession, McpServerInventory,
  McpToolCall, McpToolDefinition, McpToolResult,
} from "./mcp-broker";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 4096;

type RpcId = number | string;
type SpawnProcess = typeof spawn;

export interface AppServerBrokerOptions {
  command?: string;
  /** Arguments inserted before `app-server --stdio`; useful for wrappers and tests. */
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDetail(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(-512);
}

function errorMessage(error: unknown): string {
  if (!record(error)) return "invalid error response";
  return typeof error.message === "string" ? safeDetail(error.message) : "unspecified error";
}

function toolDefinition(name: string, value: unknown): McpToolDefinition {
  if (!record(value) || typeof value.name !== "string" || value.name !== name || !("inputSchema" in value))
    throw new Error(`Codex app-server returned an invalid schema for MCP tool ${name}`);
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
  private buffer = "";
  private stderr = "";
  private terminalError?: Error;
  private closed = false;

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private timeoutMs: number,
    private onNotification?: (method: string, params: unknown) => void,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => this.fail(new Error(`could not start Codex app-server: ${safeDetail(error.message)}`)));
    child.on("exit", (code, signal) => {
      if (!this.closed && !this.terminalError)
        this.fail(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})${this.stderr.trim() ? `: ${safeDetail(this.stderr)}` : ""}`));
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
    if (!this.closed && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  private rejectServerRequest(id: RpcId, method: string): void {
    const response = { id, error: { code: -32601, message: "North's model-free MCP broker does not accept server requests" } };
    this.child.stdin.write(`${JSON.stringify(response)}\n`, () => {});
    this.fail(new Error(`Codex app-server sent unsupported server request ${safeDetail(method)}; request rejected`));
  }

  private onLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch {
      this.fail(new Error("Codex app-server emitted malformed JSONL output"));
      return;
    }
    if (!record(message)) {
      this.fail(new Error("Codex app-server emitted a non-object JSONL message"));
      return;
    }
    if (typeof message.method === "string") {
      if (typeof message.id === "number" || typeof message.id === "string") {
        this.rejectServerRequest(message.id, message.method);
        return;
      }
      this.onNotification?.(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) pending.reject(new Error(`Codex app-server ${pending.method} failed: ${errorMessage(message.error)}`));
    else if ("result" in message) pending.resolve(message.result);
    else pending.reject(new Error(`Codex app-server ${pending.method} returned neither result nor error`));
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      this.fail(new Error("Codex app-server JSONL response exceeded 1 MiB"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      if (this.terminalError) return;
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.terminalError) throw this.terminalError;
    if (this.closed) throw new Error("Codex app-server broker is closed");
    const id = ++this.nextId;
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
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.fail(new Error(`Codex app-server ${method} write failed: ${safeDetail(error.message)}`));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closed) throw new Error("Codex app-server broker is closed");
    const notification = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(notification)}\n`, (error) => {
      if (error) this.fail(new Error(`Codex app-server ${method} notification failed: ${safeDetail(error.message)}`));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server broker closed"));
    }
    this.pending.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.child.kill("SIGTERM");
    const graceful = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    if (!graceful && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await closed;
    }
  }
}

class AppServerSession implements McpBrokerSession {
  constructor(private rpc: JsonlRpcClient, private threadId: string) {}

  async listServers(): Promise<readonly McpServerInventory[]> {
    const servers: McpServerInventory[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
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
        const tools: Record<string, McpToolDefinition> = {};
        for (const [name, value] of Object.entries(raw.tools)) tools[name] = toolDefinition(name, value);
        servers.push({ name: raw.name, authStatus: raw.authStatus, tools });
      }
      if (response.nextCursor == null) return servers;
      if (typeof response.nextCursor !== "string" || !response.nextCursor || seenCursors.has(response.nextCursor))
        throw new Error("Codex app-server returned an invalid MCP inventory cursor");
      cursor = response.nextCursor;
      seenCursors.add(cursor);
    }
  }

  async callTool(call: McpToolCall): Promise<McpToolResult> {
    if (call.access !== "read" && call.access !== "write") throw new Error("MCP tool call must declare read or write access");
    const response = await this.rpc.request("mcpServer/tool/call", {
      threadId: this.threadId,
      server: call.server,
      tool: call.tool,
      arguments: call.arguments,
    });
    if (!record(response) || !Array.isArray(response.content))
      throw new Error("Codex app-server returned an invalid MCP tool result");
    return {
      content: response.content,
      ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent } : {}),
      isError: response.isError === true,
    };
  }

  close(): Promise<void> { return this.rpc.close(); }
}

function awaitSpawn(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Codex app-server spawn timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    child.once("spawn", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`could not start Codex app-server: ${safeDetail(error.message)}`)); });
  });
}

/** Codex subscription-backed MCP transport. It never starts a model turn. */
export class AppServerMcpBroker implements McpBroker {
  constructor(private options: AppServerBrokerOptions = {}) {}

  async open(options: McpBrokerOpenOptions = {}): Promise<McpBrokerSession> {
    const command = this.options.command ?? process.env.NORTH_CODEX_BIN ?? "codex";
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = (this.options.spawnProcess ?? spawn)(
      command,
      [...(this.options.commandArgs ?? []), "app-server", "--stdio"],
      { cwd: options.cwd ?? process.cwd(), env: this.options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const rpc = new JsonlRpcClient(child, timeoutMs, this.options.onNotification);
    try {
      await awaitSpawn(child, timeoutMs);
      // Deliberately omit experimentalApi and every elicitation capability.
      await rpc.request("initialize", { clientInfo: { name: "north", title: "North", version: "1" } });
      rpc.notify("initialized", {});
      const started = await rpc.request("thread/start", { cwd: options.cwd ?? process.cwd(), ephemeral: true });
      if (!record(started) || !record(started.thread) || typeof started.thread.id !== "string" || !started.thread.id)
        throw new Error("Codex app-server returned an invalid ephemeral thread");
      return new AppServerSession(rpc, started.thread.id);
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }
}
