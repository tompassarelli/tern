import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerMcpBroker, StrictJsonlFrames } from "../src/integrations/linear/app-server-broker";
import { runLinearCommand } from "../src/integrations/linear/cli";
import { openLinearGateway } from "../src/integrations/linear/gateway";

const fixture = resolve(import.meta.dir, "fixtures/fake-linear-app-server.mjs");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function toolSchemas() {
  return {
    list_issues: {
      name: "list_issues",
      inputSchema: {
        type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
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
    list_comments: {
      name: "list_comments",
      inputSchema: {
        type: "object", properties: { issueId: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    save_comment: {
      name: "save_comment",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, issueId: { type: "string" }, body: { type: "string" } },
        required: ["body"], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  };
}

function linearServer(name = "linear-mcp-test") {
  return { name, authStatus: "oAuth", tools: toolSchemas() };
}

function harness(
  config: Record<string, unknown>, timeoutMs = 500,
  onNotification?: (method: string) => void, extraEnv: NodeJS.ProcessEnv = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "north-linear-broker-"));
  temporary.push(directory);
  const log = join(directory, "requests.jsonl");
  const reaped = join(directory, "reaped");
  const startup = join(directory, "startup.json");
  const broker = new AppServerMcpBroker({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs,
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_LINEAR_APP_SERVER: JSON.stringify(config),
      FAKE_LINEAR_REQUEST_LOG: log,
      FAKE_LINEAR_REAPED: reaped,
      FAKE_LINEAR_STARTUP_LOG: startup,
    },
    onNotification: (method) => onNotification?.(method),
  });
  return { broker, log, reaped, startup };
}

function requests(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("strict JSONL framing preserves split UTF-8 scalars without an aggregate-buffer false positive", () => {
  const split = new StrictJsonlFrames();
  const encoded = Buffer.from('{"value":"café"}\n');
  const scalar = Buffer.from("é");
  const scalarAt = encoded.indexOf(scalar);
  expect(scalarAt).toBeGreaterThan(0);
  expect(split.push(encoded.subarray(0, scalarAt + 1))).toEqual([]);
  expect(split.push(encoded.subarray(scalarAt + 1))).toEqual(['{"value":"café"}']);
  split.finish();

  const many = new StrictJsonlFrames();
  const line = `${JSON.stringify({ value: "x".repeat(10_000) })}\n`;
  const aggregate = Buffer.from(line.repeat(128));
  expect(aggregate.length).toBeGreaterThan(1024 * 1024);
  expect(many.push(aggregate)).toHaveLength(128);
  many.finish();
});

test("strict JSONL framing rejects invalid UTF-8, oversized lines, and partial EOF", () => {
  const invalid = new StrictJsonlFrames();
  expect(() => invalid.push(Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a])))
    .toThrow("invalid UTF-8 JSONL output");

  const oversized = new StrictJsonlFrames();
  expect(() => oversized.push(Buffer.alloc(1024 * 1024 + 1, 0x78)))
    .toThrow("JSONL response exceeded 1 MiB");

  const partial = new StrictJsonlFrames();
  expect(partial.push(Buffer.from('{"id":1'))).toEqual([]);
  expect(() => partial.finish()).toThrow("partial JSONL frame");
});

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
  expect(gateway.transportReceipt()).toEqual({
    transport: "codex-app-server",
    policy: "codex-app-server-linear-v1",
    linearServer: "linear-mcp-test",
    ephemeralThread: true,
    outgoingMethods: {
      initialize: 1,
      initialized: 1,
      "mcpServer/tool/call": 2,
      "mcpServerStatus/list": 1,
      "thread/start": 1,
    },
    incomingNotifications: { "mcpServer/startupStatus/updated": 6 },
    mcpCalls: [
      { server: "linear-mcp-test", tool: "get_issue", access: "read", count: 1 },
      { server: "linear-mcp-test", tool: "save_issue", access: "write", count: 1 },
    ],
    modelTurnsStarted: 0,
    usageEvents: 0,
    tokenTotalStatus: "exact-zero-protocol",
  });

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

test("command results carry a deterministic zero-model transport receipt", async () => {
  const { broker } = harness({
    servers: [linearServer()],
    results: {
      get_issue: {
        structuredContent: {
          issue: {
            id: "MSA-123",
            title: "Receipt proof",
            description: "",
            url: "https://linear.app/msa/issue/MSA-123/receipt-proof",
            createdAt: "2026-07-18T00:00:00.000Z",
          },
        },
        content: [],
      },
    },
  });
  const result = await runLinearCommand(["get", "MSA-123"], {
    openGateway: ({ server }) => openLinearGateway(broker, { server }),
  }) as { transportReceipt: Record<string, unknown> };
  expect(result.transportReceipt).toEqual({
    transport: "codex-app-server",
    policy: "codex-app-server-linear-v1",
    linearServer: "linear-mcp-test",
    ephemeralThread: true,
    outgoingMethods: {
      initialize: 1,
      initialized: 1,
      "mcpServer/tool/call": 1,
      "mcpServerStatus/list": 1,
      "thread/start": 1,
    },
    incomingNotifications: {},
    mcpCalls: [
      { server: "linear-mcp-test", tool: "get_issue", access: "read", count: 1 },
    ],
    modelTurnsStarted: 0,
    usageEvents: 0,
    tokenTotalStatus: "exact-zero-protocol",
  });
});

test("a late malformed app-server message invalidates the command receipt", async () => {
  const { broker } = harness({
    servers: [linearServer()],
    afterResponse: { method: "mcpServer/tool/call", type: "malformed" },
    results: {
      get_issue: {
        structuredContent: {
          issue: {
            id: "MSA-123",
            title: "Receipt must not escape",
            description: "",
            url: "https://linear.app/msa/issue/MSA-123/no-receipt",
            createdAt: "2026-07-18T00:00:00.000Z",
          },
        },
        content: [],
      },
    },
  });
  await expect(runLinearCommand(["get", "MSA-123"], {
    openGateway: ({ server }) => openLinearGateway(broker, { server }),
  })).rejects.toThrow("malformed JSONL output");
});

test("a late duplicate app-server error response invalidates the command receipt", async () => {
  const { broker } = harness({
    servers: [linearServer()],
    afterResponse: { method: "mcpServer/tool/call", type: "lateError" },
    results: {
      get_issue: {
        structuredContent: {
          issue: {
            id: "MSA-123",
            title: "Late error must win",
            description: "",
            url: "https://linear.app/msa/issue/MSA-123/late-error",
            createdAt: "2026-07-18T00:00:00.000Z",
          },
        },
        content: [],
      },
    },
  });
  await expect(runLinearCommand(["get", "MSA-123"], {
    openGateway: ({ server }) => openLinearGateway(broker, { server }),
  })).rejects.toThrow("response for an unknown request");
});

test("split UTF-8 app-server output survives transport framing", async () => {
  const { broker } = harness({
    servers: [linearServer()],
    afterResponse: { method: "mcpServer/tool/call", type: "splitUtf8" },
    results: {
      get_issue: {
        structuredContent: {
          issue: {
            id: "MSA-123",
            title: "Café receipt",
            description: "",
            url: "https://linear.app/msa/issue/MSA-123/split-utf8",
            createdAt: "2026-07-18T00:00:00.000Z",
          },
        },
        content: [],
      },
    },
  });
  const result = await runLinearCommand(["get", "MSA-123"], {
    openGateway: ({ server }) => openLinearGateway(broker, { server }),
  }) as { issue: { title: string } };
  expect(result.issue.title).toBe("Café receipt");
});

for (const [type, message] of [
  ["invalidUtf8", "invalid UTF-8 JSONL output"],
  ["partialEof", "partial JSONL frame"],
  ["exitBeforeEndPartial", "partial JSONL frame"],
  ["exitBeforeEndPartialLong", "partial JSONL frame"],
] as const) {
  test(`${type} after a valid response invalidates the command receipt`, async () => {
    const { broker } = harness({
      servers: [linearServer()],
      afterResponse: { method: "mcpServer/tool/call", type },
      results: {
        get_issue: {
          structuredContent: {
            issue: {
              id: "MSA-123",
              title: "Receipt must fail closed",
              description: "",
              url: "https://linear.app/msa/issue/MSA-123/invalid-transport",
              createdAt: "2026-07-18T00:00:00.000Z",
            },
          },
          content: [],
        },
      },
    });
    await expect(runLinearCommand(["get", "MSA-123"], {
      openGateway: ({ server }) => openLinearGateway(broker, { server }),
    })).rejects.toThrow(message);
  });
}

for (const notification of [
  "turn/started",
  "response/started",
  "agent-run",
  "auth/token/refreshed",
  "thread/tokenUsage/updated",
]) {
  test(`fails closed on non-policy app-server notification ${notification}`, async () => {
    await expect(openLinearGateway(harness({
      notifications: notification,
      servers: [linearServer()],
    }).broker)).rejects.toThrow(
      `notification ${notification} is not allowed by codex-app-server-linear-v1`,
    );
  });
}

for (const notification of ["remoteControl/status/changed", "thread/started"]) {
  test(`allows reviewed benign notification ${notification} without weakening the receipt`, async () => {
    const gateway = await openLinearGateway(harness({
      notifications: notification,
      servers: [linearServer()],
    }).broker);
    await gateway.close();
    expect(gateway.transportReceipt()).toMatchObject({
      policy: "codex-app-server-linear-v1",
      incomingNotifications: { [notification]: 4 },
      modelTurnsStarted: 0,
      usageEvents: 0,
      tokenTotalStatus: "exact-zero-protocol",
    });
  });
}

test("forces ChatGPT file auth and strips hostile API transport environment", async () => {
  const canary = "must-not-reach-codex-child";
  const { broker, startup } = harness({ servers: [linearServer()] }, 500, undefined, {
    OPENAI_API_KEY: canary,
    OPENAI_BASE_URL: `https://${canary}.invalid`,
    CHATGPT_BASE_URL: `https://${canary}.invalid/chatgpt`,
    OPENAI_PROJECT: canary,
    CODEX_HOME: `/tmp/${canary}/codex`,
    CODEX_SQLITE_HOME: `/tmp/${canary}/sqlite`,
  });
  const gateway = await openLinearGateway(broker);
  await gateway.close();

  const started = JSON.parse(readFileSync(startup, "utf8")) as {
    argv: string[]; env: Record<string, string | undefined>;
  };
  expect(started.argv).toContain('cli_auth_credentials_store="file"');
  expect(started.argv).toContain('forced_login_method="chatgpt"');
  expect(started.argv).toContain('model_provider="openai"');
  expect(started.argv.slice(-2)).toEqual(["app-server", "--stdio"]);
  expect(started.env.OPENAI_API_KEY).toBeUndefined();
  expect(started.env.OPENAI_BASE_URL).toBeUndefined();
  expect(started.env.CHATGPT_BASE_URL).toBeUndefined();
  expect(started.env.OPENAI_PROJECT).toBeUndefined();
  expect(started.env.CODEX_HOME).not.toContain(canary);
  expect(started.env.CODEX_SQLITE_HOME).not.toContain(canary);
  expect(JSON.stringify(started)).not.toContain(canary);
});

test("requires an unambiguous capability match unless a server is explicit", async () => {
  const { broker } = harness({ servers: [linearServer("linear-a"), linearServer("linear-b")] });
  await expect(openLinearGateway(broker)).rejects.toThrow("Expected exactly one Linear MCP server");

  const explicitHarness = harness({ servers: [linearServer("linear-a"), linearServer("linear-b")] });
  const explicit = await openLinearGateway(explicitHarness.broker, { server: "linear-b" });
  expect(explicit.server).toBe("linear-b");
  await explicit.close();
});

test("MCP inventory traversal rejects cursor loops and explicit page/item ceilings", async () => {
  await expect(openLinearGateway(harness({ inventoryInfinite: true }).broker))
    .rejects.toThrow("MCP inventory exceeded 20 pages");
  await expect(openLinearGateway(harness({ inventoryLoop: true }).broker))
    .rejects.toThrow("invalid MCP inventory cursor");
  await expect(openLinearGateway(harness({
    servers: [linearServer()],
    inventoryServerCount: 101,
  }).broker)).rejects.toThrow("more than 100 MCP servers");
});

test("runtime allowlist rejects an advertised extra tool despite TypeScript erasure", async () => {
  const server = linearServer();
  (server.tools as Record<string, any>).ask_model = {
    name: "ask_model",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  const { broker, log } = harness({ servers: [server] });
  const gateway = await openLinearGateway(broker);
  await expect(gateway.call({
    access: "read",
    method: "ask_model",
    arguments: {},
  } as any)).rejects.toThrow("outside North's runtime allowlist");
  await gateway.close();
  expect(requests(log).filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(0);
  expect(gateway.transportReceipt().mcpCalls).toEqual([]);
});

test("accepts save_issue without the unused team field", async () => {
  const server = linearServer();
  delete (server.tools.save_issue.inputSchema.properties as Record<string, unknown>).team;
  const gateway = await openLinearGateway(harness({ servers: [server] }).broker);
  expect(gateway.server).toBe("linear-mcp-test");
  await gateway.close();
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
  const canary = "canary-secret raw app-server stderr";
  try {
    await openLinearGateway(harness({ action: { method: "initialize", type: "exit", stderr: canary } }).broker);
    throw new Error("expected app-server transport failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Codex app-server transport exited unexpectedly");
    expect(String(error)).not.toContain(canary);
  }
});

test("does not retry MCP tool errors", async () => {
  const first = harness({
    servers: [linearServer()],
    results: { get_issue: { isError: true, content: [{ type: "text", text: "sanitized fake tool failure" }] } },
  });
  const gateway = await openLinearGateway(first.broker);
  try {
    await gateway.readIssue({ id: "MSA-123" });
    throw new Error("expected MCP tool failure");
  } catch (error) {
    expect((error as Error).message).toBe("Linear MCP tool failed");
    expect(String(error)).not.toContain("sanitized fake tool failure");
  }
  await gateway.close();
  expect(requests(first.log).filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(1);

  const second = harness({ servers: [linearServer()], rpcToolError: "canary-secret raw RPC failure" });
  const rpcGateway = await openLinearGateway(second.broker);
  try {
    await rpcGateway.readIssue({ id: "MSA-123" });
    throw new Error("expected app-server RPC failure");
  } catch (error) {
    expect((error as Error).message).toBe("Codex app-server mcpServer/tool/call failed");
    expect(String(error)).not.toContain("canary-secret");
  }
  await rpcGateway.close();
  expect(requests(second.log).filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(1);
});

test("rejects server requests and MCP elicitation instead of answering them", async () => {
  const { broker } = harness({
    servers: [linearServer()],
    action: { method: "mcpServer/tool/call", type: "serverRequest" },
  });
  const gateway = await openLinearGateway(broker);
  await expect(gateway.readIssue({ id: "MSA-123" })).rejects.toThrow("unsupported server request; request rejected");
  await gateway.close();
});
