import { join, resolve } from "node:path";

export const FRAM_GRAPH_AUTHORING_CAPABILITY = "graph-authoring.fram" as const;
export const FRAM_MCP_SERVER = "fram" as const;
export const FRAM_MCP_COMMAND = "/home/tom/code/fram/bin/fram-mcp" as const;
export const FRAM_MCP_TOOL_NAMES = Object.freeze([
  "tell",
  "retract",
  "show",
  "ask",
  "validate",
  "add-def",
  "set-body",
  "rename-def",
  "insert-after",
  "replace-in-body",
] as const);
export const FRAM_MCP_TOOLS = Object.freeze(
  FRAM_MCP_TOOL_NAMES.map((name) => `mcp__${FRAM_MCP_SERVER}__${name}`),
);

const STATIC_FRAM_MCP_ENV = Object.freeze({
  FRAM_FLIP: "1",
  FRAM_GRAPH_EDIT: "1",
  FRAM_CODE_PORT: "47891",
  FRAM_OUT: "/home/tom/code/fram/out",
  FRAM_BIN: "/home/tom/code/fram/bin",
  FRAM_RESOLVE: "/home/tom/code/fram/chartroom/src/resolve.clj",
  FRAM_ROUNDTRIP: "/home/tom/code/beagle/beagle-lib/private/facts-roundtrip.rkt",
  FRAM_CHECK_EMIT: "/home/tom/code/beagle/beagle-lib/private/facts-check-emit.rkt",
  FRAM_BUILD_ALL: "/home/tom/code/beagle/bin/beagle-build-all",
  BEAGLE_HOME: "/home/tom/code/beagle",
});

export function framMcpEnvironment(cwd: string): Readonly<Record<string, string>> {
  const source = resolve(cwd);
  return Object.freeze({
    ...STATIC_FRAM_MCP_ENV,
    FRAM_CODE_LOG: join(source, ".fram", "code.log"),
    FRAM_SRC: source,
  });
}

export function framMcpServer(cwd: string) {
  return Object.freeze({
    type: "stdio" as const,
    command: FRAM_MCP_COMMAND,
    args: Object.freeze([]) as unknown as string[],
    env: framMcpEnvironment(cwd),
  });
}

function exactStringMap(actual: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const entries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return entries.length === expectedEntries.length
    && entries.every(([key, value], index) =>
      key === expectedEntries[index]?.[0] && value === expectedEntries[index]?.[1]);
}

export function hasCanonicalFramMcpServer(server: unknown, cwd: string): boolean {
  if (!server || typeof server !== "object" || Array.isArray(server)) return false;
  const raw = server as Record<string, unknown>;
  return Object.keys(raw).sort().join(",") === "args,command,env,type"
    && raw.type === "stdio"
    && raw.command === FRAM_MCP_COMMAND
    && Array.isArray(raw.args)
    && raw.args.length === 0
    && exactStringMap(raw.env, framMcpEnvironment(cwd));
}
