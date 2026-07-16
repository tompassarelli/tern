import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const server = resolve(import.meta.dir, "../../bin/north-mcp");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeNorth(): string {
  const directory = mkdtempSync(join(tmpdir(), "north-linear-mcp-"));
  temporary.push(directory);
  const fake = join(directory, "north");
  writeFileSync(fake, `#!/usr/bin/env bun
if (process.env.FAKE_TOOL_ERROR === "1") {
  process.stderr.write("HEAD-" + "x".repeat(12_000) + "-TAIL");
  process.exit(17);
}
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));
`);
  chmodSync(fake, 0o755);
  return fake;
}

function rpc(requests: Record<string, unknown>[], env: Record<string, string> = {}): any[] {
  const result = spawnSync("bb", [server], {
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    env: { ...process.env, ...env, NORTH_BIN: fakeNorth() },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function argv(response: any): string[] {
  expect(response.result.isError).toBe(false);
  expect(response.result.content).toHaveLength(1);
  expect(response.result.content[0].type).toBe("text");
  return JSON.parse(response.result.content[0].text).argv;
}

test("advertises four concise Linear tools with truthful safety annotations", () => {
  const [response] = rpc([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  const linear = response.result.tools.filter((tool: any) => tool.name.startsWith("linear_"));
  expect(linear.map((tool: any) => tool.name)).toEqual([
    "linear_get", "linear_import", "linear_plan", "linear_sync",
  ]);

  const tools = Object.fromEntries(linear.map((tool: any) => [tool.name, tool]));
  expect(tools.linear_get.annotations).toEqual({
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  });
  expect(tools.linear_import.annotations).toEqual({
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  });
  expect(tools.linear_plan.annotations).toEqual(tools.linear_get.annotations);
  expect(tools.linear_sync.annotations).toEqual({
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  });
  expect(Object.keys(tools.linear_get.inputSchema.properties)).toEqual(["issue", "server"]);
  expect(Object.keys(tools.linear_import.inputSchema.properties)).toEqual(["issue", "server"]);
  expect(Object.keys(tools.linear_plan.inputSchema.properties)).toEqual(["thread", "server"]);
  expect(Object.keys(tools.linear_sync.inputSchema.properties)).toEqual(["thread", "apply", "server"]);
});

test("forwards exact north linear argv and keeps sync plan-only by default", () => {
  const responses = rpc([
    call(1, "linear_get", { issue: "MSA-101" }),
    call(2, "linear_import", { issue: "MSA-102", server: "linear-mcp-msa-new" }),
    call(3, "linear_plan", { thread: "2026-07-16-120000", server: "linear-mcp-msa-new" }),
    call(4, "linear_sync", { thread: "2026-07-16-120000", apply: false }),
    call(5, "linear_sync", { thread: "2026-07-16-120000", apply: true, server: "linear-mcp-msa-new" }),
  ]);
  expect(argv(responses[0])).toEqual(["linear", "get", "MSA-101"]);
  expect(argv(responses[1])).toEqual(["linear", "import", "MSA-102", "--server", "linear-mcp-msa-new"]);
  expect(argv(responses[2])).toEqual(["linear", "plan", "2026-07-16-120000", "--server", "linear-mcp-msa-new"]);
  expect(argv(responses[3])).toEqual(["linear", "sync", "2026-07-16-120000"]);
  expect(argv(responses[4])).toEqual([
    "linear", "sync", "2026-07-16-120000", "--apply", "--server", "linear-mcp-msa-new",
  ]);
});

test("passes tool failures through as bounded text", () => {
  const [response] = rpc([call(1, "linear_get", { issue: "MSA-500" })], { FAKE_TOOL_ERROR: "1" });
  const result = response.result;
  expect(result.isError).toBe(true);
  expect(result.content[0].type).toBe("text");
  expect(result.content[0].text.length).toBeLessThanOrEqual(8192);
  expect(result.content[0].text).toContain("HEAD-");
  expect(result.content[0].text).toContain("... tool error truncated ...");
  expect(result.content[0].text.endsWith("-TAIL")).toBe(true);
});
