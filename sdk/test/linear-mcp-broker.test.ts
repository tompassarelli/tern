import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerMcpBroker } from "../src/integrations/linear/app-server-broker";
import { openLinearGateway } from "../src/integrations/linear/gateway";

const fixture = resolve(import.meta.dir, "fixtures/fake-linear-app-server.mjs");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function toolSchemas() {
  return {
    get_issue: {
      name: "get_issue",
      inputSchema: {
        type: "object", properties: { id: { type: "string" }, includeRelations: { type: "boolean" } },
        required: ["id"], additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    save_issue: {
      name: "save_issue",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, team: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  };
}

function linearServer(name = "linear-mcp-test") {
  return { name, authStatus: "oAuth", tools: toolSchemas() };
}

function harness(config: Record<string, unknown>, timeoutMs = 500, onNotification?: (method: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "north-linear-broker-"));
  temporary.push(directory);
  const log = join(directory, "requests.jsonl");
  const reaped = join(directory, "reaped");
  const broker = new AppServerMcpBroker({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs,
    env: {
      ...process.env,
      FAKE_LINEAR_APP_SERVER: JSON.stringify(config),
      FAKE_LINEAR_REQUEST_LOG: log,
      FAKE_LINEAR_REAPED: reaped,
    },
    onNotification: (method) => onNotification?.(method),
  });
  return { broker, log, reaped };
}

function requests(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("uses stable app-server MCP calls without starting a model turn", async () => {
  const notifications: string[] = [];
  const { broker, log, reaped } = harness({
    notifications: true,
    servers: [linearServer()],
    results: {
      get_issue: {
        structuredContent: { issue: { id: "MSA-123", title: "From structured content" } },
        content: [{ type: "text", text: JSON.stringify({ ignored: true }) }],
      },
      save_issue: { content: [{ type: "text", text: JSON.stringify({ issue: { id: "MSA-123", title: "Updated" } }) }] },
    },
  }, 500, (method) => notifications.push(method));
  const gateway = await openLinearGateway(broker, { cwd: "/tmp" });
  expect(await gateway.readIssue({ id: "MSA-123" })).toEqual({ issue: { id: "MSA-123", title: "From structured content" } });
  expect(await gateway.writeIssue({ id: "MSA-123", title: "Updated" })).toEqual({ issue: { id: "MSA-123", title: "Updated" } });
  await gateway.close();

  const seen = requests(log);
  expect(seen.map(({ method }) => method)).toEqual([
    "initialize", "initialized", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call", "mcpServer/tool/call",
  ]);
  expect(seen.some(({ method }) => method === "turn/start")).toBe(false);
  expect(seen[0].params.capabilities).toBeUndefined();
  expect(JSON.stringify(seen[0].params)).not.toContain("experimentalApi");
  expect(seen[0].params.clientInfo).toEqual({ name: "north", title: "North", version: "1" });
  expect(seen[1].id).toBeUndefined();
  expect(seen[1].params).toEqual({});
  expect(seen[2].params).toEqual({ cwd: "/tmp", ephemeral: true });
  expect(seen[4].params).toEqual({
    threadId: "ephemeral-thread", server: "linear-mcp-test", tool: "get_issue", arguments: { id: "MSA-123" },
  });
  expect(notifications.length).toBeGreaterThan(0);
  expect(readFileSync(reaped, "utf8")).toBe("SIGTERM");
});

test("requires an unambiguous capability match unless a server is explicit", async () => {
  const { broker } = harness({ servers: [linearServer("linear-a"), linearServer("linear-b")] });
  await expect(openLinearGateway(broker)).rejects.toThrow("Expected exactly one Linear MCP server");

  const explicitHarness = harness({ servers: [linearServer("linear-a"), linearServer("linear-b")] });
  const explicit = await openLinearGateway(explicitHarness.broker, { server: "linear-b" });
  expect(explicit.server).toBe("linear-b");
  await explicit.close();
});

test("fails closed on OAuth and tool schema/annotation drift", async () => {
  const unauthenticated = linearServer();
  unauthenticated.authStatus = "notLoggedIn";
  await expect(openLinearGateway(harness({ servers: [unauthenticated] }).broker)).rejects.toThrow("not OAuth-ready");

  const drifted = linearServer();
  drifted.tools.save_issue.annotations.destructiveHint = false;
  await expect(openLinearGateway(harness({ servers: [drifted] }).broker)).rejects.toThrow("explicit write annotations");

  const readDrifted = linearServer();
  readDrifted.tools.get_issue.annotations.idempotentHint = false;
  await expect(openLinearGateway(harness({ servers: [readDrifted] }).broker)).rejects.toThrow("safe read annotations");

  const gateway = await openLinearGateway(harness({ servers: [linearServer()] }).broker);
  await expect(gateway.readIssue({ id: 123 })).rejects.toThrow("wrong type");
  await expect(gateway.writeIssue({ id: "MSA-123", surprise: true })).rejects.toThrow("not accepted by the live schema");
  await gateway.close();
});

test("rejects malformed output and bounded timeouts", async () => {
  await expect(openLinearGateway(harness({ action: { method: "initialize", type: "malformed" } }).broker))
    .rejects.toThrow("malformed JSONL");
  await expect(openLinearGateway(harness({ action: { method: "initialize", type: "never" } }, 30).broker))
    .rejects.toThrow("timed out after 30ms");
});

test("reports child death before handshake completes", async () => {
  await expect(openLinearGateway(harness({ action: { method: "initialize", type: "exit" } }).broker))
    .rejects.toThrow("exited (17)");
});

test("does not retry MCP tool errors", async () => {
  const first = harness({
    servers: [linearServer()],
    results: { get_issue: { isError: true, content: [{ type: "text", text: "sanitized fake tool failure" }] } },
  });
  const gateway = await openLinearGateway(first.broker);
  await expect(gateway.readIssue({ id: "MSA-123" })).rejects.toThrow("sanitized fake tool failure");
  await gateway.close();
  expect(requests(first.log).filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(1);

  const second = harness({ servers: [linearServer()], rpcToolError: true });
  const rpcGateway = await openLinearGateway(second.broker);
  await expect(rpcGateway.readIssue({ id: "MSA-123" })).rejects.toThrow("sanitized fake RPC failure");
  await rpcGateway.close();
  expect(requests(second.log).filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(1);
});

test("rejects server requests and MCP elicitation instead of answering them", async () => {
  const { broker } = harness({
    servers: [linearServer()],
    action: { method: "mcpServer/tool/call", type: "serverRequest" },
  });
  const gateway = await openLinearGateway(broker);
  await expect(gateway.readIssue({ id: "MSA-123" })).rejects.toThrow("unsupported server request mcpServer/elicitation/request");
  await gateway.close();
});
