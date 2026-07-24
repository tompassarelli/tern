// Hermetic managed-graph env for tests that assert on harness-built MCP env or
// spawn authority.
//
// A real managed north run exports lane identity, FRAM instance selection, and
// attribution/provenance selectors. The harness forwards a whitelisted subset
// (MANAGED_NORTH_MCP_ENV_KEYS) into the child North MCP env. When the test
// process is itself a managed lane, that ambient state leaks into the built
// options and breaks assertions that expect a clean, minimal boundary. Scrub
// the inherited pollution while leaving the keys the harness re-sets itself.
import { MANAGED_NORTH_MCP_ENV_KEYS } from "../../src/execution-admission";

// The harness always re-sets these from lane identity, so leaving the inherited
// value in place is harmless — but everything else in the whitelist is pure
// ambient leakage for a hermetic unit test.
const HARNESS_OWNED = new Set([
  "HOME", "NORTH_BIN", "AGENT_ID", "AGENT_TOPOLOGY", "NORTH_PORT",
  "NORTH_MKFIFO_BIN", "NORTH_GIT_BIN", "NORTH_PEER_BB",
]);

export const AMBIENT_GRAPH_POLLUTION: readonly string[] =
  MANAGED_NORTH_MCP_ENV_KEYS.filter((key) => !HARNESS_OWNED.has(key));

/**
 * Delete inherited managed-graph env so a harness-built MCP env / spawn
 * authority reflects only what the test sets. Returns a restore function that
 * puts every touched key back exactly (set-or-delete), so a scrub never leaks
 * into sibling suites.
 */
export function scrubAmbientGraphEnv(extraKeys: readonly string[] = []): () => void {
  const keys = [...AMBIENT_GRAPH_POLLUTION, ...extraKeys];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}
