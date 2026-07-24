import { join, resolve } from "node:path";

export const FRAM_GRAPH_AUTHORING_CAPABILITY = "graph-authoring.fram" as const;
export const FRAM_MCP_SERVER = "fram" as const;
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

// The fram and beagle roots are deployment facts, not source constants: the
// nix package purity gate rejects checkout paths baked into the installed
// CLI. Every path below derives lazily from these two roots, so composing
// the capability without them fails closed with a named error while every
// non-capability spawn never touches this resolution at all.
export function framGraphAuthoringRoots(): { framHome: string; beagleHome: string } {
  const framHome = process.env.NORTH_FRAM_HOME;
  const beagleHome = process.env.NORTH_BEAGLE_HOME;
  if (!framHome || !beagleHome) {
    const missing = [
      !framHome && "NORTH_FRAM_HOME",
      !beagleHome && "NORTH_BEAGLE_HOME",
    ].filter(Boolean).join(", ");
    throw new Error(
      "graph_authoring_fram_roots_unset: the graph-authoring.fram capability "
      + `requires NORTH_FRAM_HOME and NORTH_BEAGLE_HOME in the dispatching `
      + `environment (missing: ${missing})`,
    );
  }
  return { framHome: resolve(framHome), beagleHome: resolve(beagleHome) };
}

export function framMcpCommand(): string {
  return join(framGraphAuthoringRoots().framHome, "bin", "fram-mcp");
}

function staticFramMcpEnv(): Readonly<Record<string, string>> {
  const { framHome, beagleHome } = framGraphAuthoringRoots();
  return Object.freeze({
    FRAM_FLIP: "1",
    FRAM_GRAPH_EDIT: "1",
    FRAM_CODE_PORT: "47891",
    FRAM_OUT: join(framHome, "out"),
    FRAM_BIN: join(framHome, "bin"),
    FRAM_RESOLVE: join(framHome, "chartroom", "src", "resolve.clj"),
    FRAM_ROUNDTRIP: join(beagleHome, "beagle-lib", "private", "facts-roundtrip.rkt"),
    FRAM_CHECK_EMIT: join(beagleHome, "beagle-lib", "private", "facts-check-emit.rkt"),
    FRAM_BUILD_ALL: join(beagleHome, "bin", "beagle-build-all"),
    BEAGLE_HOME: beagleHome,
  });
}

export function framMcpEnvironment(cwd: string): Readonly<Record<string, string>> {
  const source = resolve(cwd);
  return Object.freeze({
    ...staticFramMcpEnv(),
    FRAM_CODE_LOG: join(source, ".fram", "code.log"),
    FRAM_SRC: source,
  });
}

export function framMcpServer(cwd: string) {
  return Object.freeze({
    type: "stdio" as const,
    command: framMcpCommand(),
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
    && raw.command === framMcpCommand()
    && Array.isArray(raw.args)
    && raw.args.length === 0
    && exactStringMap(raw.env, framMcpEnvironment(cwd));
}
