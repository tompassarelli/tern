import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const config = JSON.parse(process.env.FAKE_LINEAR_APP_SERVER ?? "{}");
const logPath = process.env.FAKE_LINEAR_REQUEST_LOG;
const reapedPath = process.env.FAKE_LINEAR_REAPED;
const startupPath = process.env.FAKE_LINEAR_STARTUP_LOG;

if (startupPath) writeFileSync(startupPath, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    CHATGPT_BASE_URL: process.env.CHATGPT_BASE_URL,
    OPENAI_PROJECT: process.env.OPENAI_PROJECT,
  },
}));

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendResult(request, result) {
  const response = { id: request.id, result };
  if (config.afterResponse?.method === request.method) {
    if (config.afterResponse.type === "malformed") {
      process.stdout.write(`${JSON.stringify(response)}\nnot-json\n`);
      return;
    }
    if (config.afterResponse.type === "lateError") {
      process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify({
        id: request.id,
        error: { code: -32000, message: "late duplicate response" },
      })}\n`);
      return;
    }
    if (config.afterResponse.type === "invalidUtf8") {
      process.stdout.write(`${JSON.stringify(response)}\n`);
      process.stdout.write(Buffer.from([
        0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a,
      ]));
      return;
    }
    if (config.afterResponse.type === "partialEof") {
      process.stdout.write(`${JSON.stringify(response)}\n{"method":"thread/started"`);
      setImmediate(() => process.exit(0));
      return;
    }
    if (["exitBeforeEndPartial", "exitBeforeEndPartialLong"].includes(config.afterResponse.type)) {
      process.stdout.write(`${JSON.stringify(response)}\n{"method":"thread/started"`);
      const delay = config.afterResponse.type === "exitBeforeEndPartialLong" ? 500 : 75;
      spawn(process.execPath, ["-e", `setTimeout(() => {}, ${delay})`], {
        stdio: ["ignore", 1, "ignore"],
      }).unref();
      process.exit(0);
    }
    if (config.afterResponse.type === "splitUtf8") {
      const encoded = Buffer.from(`${JSON.stringify(response)}\n`);
      const scalar = Buffer.from("é");
      const scalarAt = encoded.indexOf(scalar);
      if (scalarAt < 0) throw new Error("splitUtf8 response lacks the expected scalar");
      process.stdout.write(encoded.subarray(0, scalarAt + 1));
      setImmediate(() => process.stdout.write(encoded.subarray(scalarAt + 1)));
      return;
    }
  }
  send(response);
}

process.on("SIGTERM", () => {
  if (reapedPath) writeFileSync(reapedPath, "SIGTERM");
  process.exit(0);
});

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  log(request);
  if (request.method === config.action?.method) {
    if (config.action.type === "never") return;
    if (config.action.type === "exit") {
      if (typeof config.action.stderr === "string") process.stderr.write(config.action.stderr);
      return process.exit(17);
    }
    if (config.action.type === "malformed") return process.stdout.write("not-json\n");
    if (config.action.type === "serverRequest") {
      send({ id: "server-request-1", method: "mcpServer/elicitation/request", params: { message: "do not answer" } });
      return;
    }
  }
  if (config.notifications) send({
    method: typeof config.notifications === "string"
      ? config.notifications : "mcpServer/startupStatus/updated",
    params: { state: "ready" },
  });
  if (request.method === "initialize") return sendResult(request, { userAgent: "fake-linear" });
  if (request.method === "initialized" && request.id === undefined) return;
  if (request.method === "thread/start") return sendResult(request, { thread: { id: "ephemeral-thread" } });
  if (request.method === "mcpServerStatus/list") {
    if (config.inventoryInfinite) {
      const prior = typeof request.params?.cursor === "string"
        ? Number(request.params.cursor.replace("inventory-", "")) : 0;
      return sendResult(request, { data: [], nextCursor: `inventory-${prior + 1}` });
    }
    if (config.inventoryLoop)
      return sendResult(request, { data: [], nextCursor: "inventory-loop" });
    const data = Number.isSafeInteger(config.inventoryServerCount) && config.inventoryServerCount >= 0
      ? Array.from({ length: config.inventoryServerCount }, (_, index) => ({
        ...(config.servers?.[0] ?? {}),
        name: `inventory-server-${index}`,
      }))
      : config.servers ?? [];
    return sendResult(request, { data, nextCursor: null });
  }
  if (request.method === "mcpServer/tool/call") {
    if (config.rpcToolError) return send({ id: request.id, error: {
      code: -32000,
      message: typeof config.rpcToolError === "string" ? config.rpcToolError : "fake RPC failure",
    } });
    const result = config.results?.[request.params.tool] ?? { content: [{ type: "text", text: "{}" }] };
    return sendResult(request, result);
  }
  send({ id: request.id, error: { code: -32601, message: `unexpected method ${request.method}` } });
});
