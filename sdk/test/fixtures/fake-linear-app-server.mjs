import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const config = JSON.parse(process.env.FAKE_LINEAR_APP_SERVER ?? "{}");
const logPath = process.env.FAKE_LINEAR_REQUEST_LOG;
const reapedPath = process.env.FAKE_LINEAR_REAPED;

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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
    if (config.action.type === "exit") return process.exit(17);
    if (config.action.type === "malformed") return process.stdout.write("not-json\n");
    if (config.action.type === "serverRequest") {
      send({ id: "server-request-1", method: "mcpServer/elicitation/request", params: { message: "do not answer" } });
      return;
    }
  }
  if (config.notifications) send({ method: "mcpServer/startupStatus/updated", params: { state: "ready" } });
  if (request.method === "initialize") return send({ id: request.id, result: { userAgent: "fake-linear" } });
  if (request.method === "initialized" && request.id === undefined) return;
  if (request.method === "thread/start") return send({ id: request.id, result: { thread: { id: "ephemeral-thread" } } });
  if (request.method === "mcpServerStatus/list")
    return send({ id: request.id, result: { data: config.servers ?? [], nextCursor: null } });
  if (request.method === "mcpServer/tool/call") {
    if (config.rpcToolError) return send({ id: request.id, error: { code: -32000, message: "sanitized fake RPC failure" } });
    const result = config.results?.[request.params.tool] ?? { content: [{ type: "text", text: "{}" }] };
    return send({ id: request.id, result });
  }
  send({ id: request.id, error: { code: -32601, message: `unexpected method ${request.method}` } });
});
