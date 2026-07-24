import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { presetRequest } from "./routing-fixtures";

const temporary: string[] = [];
const GAFFER_ROOT = resolve(import.meta.dir, "../../..", "gaffer");
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function pinEvidence(pins: Array<{ kind: "provider" | "account" | "model"; value: string }>) {
  const issuedAt = new Date();
  return {
    policyVersion: "north-routing-pin-v1",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000).toISOString(),
    reasonCode: "explicit-human-request",
    detail: "MCP contract fixture",
    pins,
  };
}

function mcpSpawnEnvironment(
  configure: (home: string, env: Record<string, string>) => void,
): { home: string; childEnv: Record<string, string> } {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-instance-env-"));
  temporary.push(directory);
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  const capture = join(directory, "sdk-env");
  const fakeBun = join(directory, "bun");
  const fakeNorth = join(directory, "north");
  writeFileSync(fakeBun, `#!/usr/bin/env bash
env > "$NORTH_MCP_CAPTURE"
exit 0
`);
  chmodSync(fakeBun, 0o755);
  writeFileSync(fakeNorth, `#!/usr/bin/env bash
printf '%s\n' '[{"predicate":"kind","value":"lane"},{"predicate":"role","value":"integrator"},{"predicate":"goal","value":"contract probe"},{"predicate":"provider","value":"anthropic"},{"predicate":"provider_target","value":"claude-personal-tompas0x-gmail"},{"predicate":"live_input","value":"streaming"},{"predicate":"live_input_state","value":"frozen"},{"predicate":"live_input_epoch","value":"00000000-0000-4000-8000-000000000041"},{"predicate":"model","value":"claude-opus-4-8"},{"predicate":"effort","value":"xhigh"},{"predicate":"composition_kind","value":"preset"},{"predicate":"composition_id","value":"integrator"},{"predicate":"composition_overrides","value":"[]"},{"predicate":"repo","value":"north"},{"predicate":"spawned_at","value":"2026-07-17T00:00:00Z"},{"predicate":"display_handle","value":"anthropic-claude-gmail-opus-xhigh-integrator-probe"},{"predicate":"display_name","value":"anthropic:claude-personal-tompas0x-gmail · opus · xhigh · gaffer:integrator · contract probe"},{"predicate":"identity_manifest_sha256","value":"c4d461959f641a1917174187051aded161dec0ebfd2eb11641e002f741ed39b8"},{"predicate":"outcome","value":"ran"}]'
`);
  chmodSync(fakeNorth, 0o755);

  const selectors = [
    "FRAM_LOG", "FRAM_TELEMETRY_LOG", "FRAM_THREADS", "NORTH_PORT",
    "AGENT_MODEL", "AGENT_PROVIDER", "AGENT_TARGET", "AGENT_TIER",
    "AGENT_REASONING", "AGENT_EFFORT", "AGENT_POSTURE", "AGENT_COMPOSITION",
    "AGENT_TASK_GRADE", "AGENT_DOMAIN_REQUIREMENTS", "AGENT_TOPOLOGY",
    "NORTH_RUN_ID", "NORTH_THREAD_ID", "NORTH_RUN_CAPABILITY",
    "NORTH_STRUGGLE_POLICY_EXPECTED",
  ];
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => value !== undefined && !selectors.includes(key)),
  ) as Record<string, string>;
  Object.assign(env, {
    HOME: home,
    NORTH_BIN: fakeNorth,
    NORTH_MCP_BUN: fakeBun,
    NORTH_MCP_CAPTURE: capture,
    NORTH_SPAWN_STARTUP_TIMEOUT_MS: "1000",
    GAFFER_HOME: GAFFER_ROOT,
    NO_COLOR: "1",
    // Every ambient routing/proof axis below must be absent from the child.
    // The complete request-owned Gaffer contract is rebuilt below.
    AGENT_MODEL: "ambient-model",
    AGENT_PROVIDER: "openai",
    AGENT_TARGET: "ambient-account",
    AGENT_TIER: "economy",
    AGENT_REASONING: "low",
    AGENT_EFFORT: "low",
    AGENT_POSTURE: "explore",
    AGENT_COMPOSITION: "{\"kind\":\"ambient\"}",
    AGENT_TASK_GRADE: "novice",
    AGENT_DOMAIN_REQUIREMENTS: "[\"ambient\"]",
    NORTH_STRUGGLE_POLICY_EXPECTED: "ambient-policy-must-not-leak",
  });
  configure(home, env);

  const north = resolve(import.meta.dir, "../..");
  const route = presetRequest("integrator");
  const request = `${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "spawn", arguments: {
      prompt: "contract probe",
      caveman: "full",
      ...route,
    } },
  })}\n`;
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: request,
    encoding: "utf8",
    env,
  });
  expect(result.status, result.stderr).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
  const childEnv = Object.fromEntries(
    readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  expect(childEnv).toMatchObject({
    AGENT_ROLE: route.role,
    AGENT_TASK_GRADE: route.taskGrade,
    AGENT_DOMAIN_REQUIREMENTS: JSON.stringify(route.domainRequirements),
    AGENT_TOPOLOGY: route.topology,
    AGENT_TIER: route.tier,
    AGENT_REASONING: route.reasoning,
    AGENT_EFFORT: route.reasoning,
    AGENT_POSTURE: route.posture,
    AGENT_COMPOSITION: JSON.stringify(route.composition),
    AGENT_CAVEMAN: "full",
    NORTH_CAVEMAN_SOURCE: "request",
  });
  expect(JSON.parse(childEnv.NORTH_STRUGGLE_POLICY_EXPECTED)).toEqual({
    version: "north:struggle-observer:v1",
    topology: route.topology,
    errorStreak: 3,
    loopRepeat: 3,
    loopWindow: 20,
    noProgressTurns: 6,
  });
  for (const residue of [
    "AGENT_MODEL", "AGENT_PROVIDER", "AGENT_TARGET",
    "NORTH_RUN_ID", "NORTH_THREAD_ID", "NORTH_RUN_CAPABILITY",
  ]) expect(childEnv).not.toHaveProperty(residue);
  return { home, childEnv };
}

// Anti-rot: the advertised tools/list schema must surface the work identifier
// first, then the eight Gaffer routing fields contiguously, before any optional
// compat/provider field. The properties map in bin/north-mcp is a >8-key map, so
// a plain `{}` literal degrades to a scrambled PersistentHashMap; this test fails
// if a field is dropped, reordered, or displaced from those leading positions.
const EIGHT_ROUTING_FIELDS = [
  "role",
  "taskGrade",
  "domainRequirements",
  "topology",
  "tier",
  "reasoning",
  "posture",
  "composition",
] as const;

function toolsListTools(): Record<string, any> {
  const north = resolve(import.meta.dir, "../..");
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    encoding: "utf8",
    env: { ...process.env, NORTH_MCP_BUN: "/bin/false" },
  });
  expect(result.status, result.stderr).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  const toolsByName: Record<string, any> = {};
  for (const tool of response.result.tools) {
    toolsByName[tool.name] = tool;
  }
  return toolsByName;
}

function toolsListSchemaKeys(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(toolsListTools()).map(([name, tool]) => [
      name,
      // JSON.parse preserves insertion order for non-numeric string keys, so
      // Object.keys reflects the exact advertised (document) order.
      Object.keys(tool.inputSchema.properties),
    ]),
  );
}

test("MCP tools/list advertises the work identifier then the eight Gaffer fields first, in order", () => {
  const keysByTool = toolsListSchemaKeys();
  for (const [tool, identifier] of [["dispatch", "id"], ["spawn", "prompt"]] as const) {
    const keys = keysByTool[tool];
    expect(keys, `${tool} must be advertised in tools/list`).toBeDefined();
    // Work identifier is position 0.
    expect(keys[0], `${tool} must advertise its work identifier first`).toBe(identifier);
    // The eight routing fields occupy positions 1..8 contiguously, in exact order.
    expect(
      keys.slice(1, 1 + EIGHT_ROUTING_FIELDS.length),
      `${tool} must advertise the eight Gaffer routing fields contiguously, in order, right after ${identifier}`,
    ).toEqual([...EIGHT_ROUTING_FIELDS]);
    // Presence guard, independent of the ordering slice above.
    for (const field of EIGHT_ROUTING_FIELDS) {
      expect(keys, `${tool} must advertise ${field}`).toContain(field);
    }
    // Every optional/compat field trails the leading routing block.
    for (const [index, key] of keys.entries()) {
      if (index === 0 || EIGHT_ROUTING_FIELDS.includes(key as (typeof EIGHT_ROUTING_FIELDS)[number])) continue;
      expect(index, `optional field ${key} on ${tool} must trail the routing block`).toBeGreaterThan(
        EIGHT_ROUTING_FIELDS.length,
      );
    }
  }
});

test("MCP tools/list explains automatic routing and explicit selector evidence", () => {
  const tools = toolsListTools();
  for (const name of ["dispatch", "spawn"]) {
    const tool = tools[name];
    expect(tool.description).toContain(
      "For automatic routing, omit model and target and omit provider or use auto",
    );
    expect(tool.description).toContain(
      "requires fresh exact typed pinEvidence",
    );
    expect(tool.inputSchema.properties.pinEvidence.description).toContain(
      "typed pins exactly match every explicit provider, target/account, or model selector",
    );
    expect(tool.inputSchema.properties.provider.description).toContain(
      "Omit or use auto for automatic routing",
    );
    expect(tool.inputSchema.properties.target.description).toContain(
      "requires fresh pinEvidence with an exact matching account pin",
    );
    expect(tool.inputSchema.properties.model.description).toContain(
      "requires fresh pinEvidence with an exact matching model pin",
    );
  }
});

test("managed parent copied selectors without pin evidence are rejected before SDK launch", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-copied-selector-"));
  temporary.push(directory);
  const marker = join(directory, "sdk-launched");
  const fakeBun = join(directory, "bun");
  writeFileSync(fakeBun, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(fakeBun, 0o755);
  const north = resolve(import.meta.dir, "../..");
  const copiedSelectors = {
    provider: "anthropic",
    target: "parent-account",
    model: "parent-model",
  };
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "spawn",
        arguments: {
          prompt: "do not inherit the managed parent's concrete selectors",
          ...presetRequest("verifier"),
          ...copiedSelectors,
        },
      },
    })}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_ID: "parent-director",
      AGENT_TOPOLOGY: "orchestrator",
      AGENT_PROVIDER: copiedSelectors.provider,
      AGENT_TARGET: copiedSelectors.target,
      AGENT_MODEL: copiedSelectors.model,
      NORTH_MCP_BUN: fakeBun,
      NORTH_POLICY_BUN: fakeBun,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toBe(
    "explicit provider, target, or model selectors require fresh exact typed pinEvidence; for automatic routing omit model and target and omit provider or use provider=auto",
  );
  expect(() => readFileSync(marker)).toThrow();
});

test("MCP rejects an invalid detector override before SDK launch", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-struggle-policy-"));
  temporary.push(directory);
  const marker = join(directory, "sdk-launched");
  const fakeBun = join(directory, "bun");
  writeFileSync(fakeBun, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(fakeBun, 0o755);
  const north = resolve(import.meta.dir, "../..");
  const request = `${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "spawn", arguments: {
      prompt: "must fail before launch", ...presetRequest("verifier"),
    } },
  })}\n`;
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: request,
    encoding: "utf8",
    env: {
      ...process.env,
      NORTH_MCP_BUN: fakeBun,
      NORTH_POLICY_BUN: process.execPath,
      STRUGGLE_STALL_TURNS: "0",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain(
    "STRUGGLE_STALL_TURNS must be a positive integer between 1 and 1000",
  );
  expect(() => readFileSync(marker)).toThrow();
});

test("env-less MCP SDK launches materialize the canonical North instance exactly once", () => {
  const defaulted = mcpSpawnEnvironment(() => {});
  expect(defaulted.childEnv).toMatchObject({
    FRAM_LOG: join(defaulted.home, ".local/state/north/facts.log"),
    FRAM_THREADS: join(defaulted.home, ".local/state/north/threads"),
    NORTH_PORT: "7977",
  });
  expect(defaulted.childEnv).not.toHaveProperty("FRAM_TELEMETRY_LOG");

  const split = mcpSpawnEnvironment((home) => {
    const state = join(home, ".local/state/north");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "coordination.log"), "");
  });
  expect(split.childEnv).toMatchObject({
    FRAM_LOG: join(split.home, ".local/state/north/coordination.log"),
    FRAM_TELEMETRY_LOG: join(split.home, ".local/state/north/telemetry.log"),
    FRAM_THREADS: join(split.home, ".local/state/north/threads"),
    NORTH_PORT: "7977",
  });

  const explicit = mcpSpawnEnvironment((_home, env) => {
    const selected = join(_home, "selected");
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(selected, "coordination.log"), "");
    env.FRAM_LOG = join(selected, "custom.log");
    env.FRAM_THREADS = join(selected, "custom-threads");
    env.NORTH_PORT = "64129";
  });
  expect(explicit.childEnv).toMatchObject({
    FRAM_LOG: join(explicit.home, "selected/custom.log"),
    FRAM_THREADS: join(explicit.home, "selected/custom-threads"),
    NORTH_PORT: "64129",
  });
  expect(explicit.childEnv).not.toHaveProperty("FRAM_TELEMETRY_LOG");
});

test("MCP dispatch runs warm child preflight within budget and forwards an exact account target", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-target-"));
  temporary.push(directory);
  const capture = join(directory, "sdk-env");
  const events = join(directory, "events");
  const fakeBun = join(directory, "bun");
  const fakeBb = join(directory, "bb");
  const fakeNorth = join(directory, "north");
  writeFileSync(fakeBun, `#!/usr/bin/env bash
case "$*" in
  *mcp-route-preflight.ts*) exit 0 ;;
esac
printf 'spawn:%s\n' "$AGENT_ID" >> "$NORTH_MCP_EVENTS"
printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$AGENT_TARGET" "$AGENT_PROVIDER" "$AGENT_ID" "$NORTH_DISPATCH_DRIVER_PRECLAIMED" "$FRAM_LOG" "$AGENT_CAVEMAN" "$NORTH_CAVEMAN_SOURCE" "$*" > "$NORTH_MCP_CAPTURE"
thread="\${@: -1}"
NORTH_SDK_PREFLIGHT=1 "$NORTH_BIN" json show "$thread" >/dev/null || { printf '%s\n' NORTH_READ_UNAVAILABLE >&2; exit 17; }
children="$(NORTH_SDK_PREFLIGHT=1 "$NORTH_BIN" json children "$thread")" || { printf '%s\n' NORTH_READ_UNAVAILABLE >&2; exit 17; }
[ "$children" = '[]' ] || exit 18
"$NORTH_MCP_BB" ignored 7977 release "@$thread" "$AGENT_ID"
`);
  chmodSync(fakeBun, 0o755);
  writeFileSync(fakeBb, `#!/usr/bin/env bash
printf 'driver:%s:%s:%s\n' "$3" "$4" "$5" >> "$NORTH_MCP_EVENTS"
exit 0
`);
  chmodSync(fakeBb, 0o755);
  writeFileSync(fakeNorth, `#!/usr/bin/env bash
printf 'north:%s\n' "$*" >> "$NORTH_MCP_EVENTS"
if [ "\${NORTH_SDK_PREFLIGHT:-}" = 1 ]; then
  case "$1:$2" in
    json:show) printf '%s\n' '[{"predicate":"title","value":"completed dispatch probe"}]' ;;
    json:children) printf '%s\n' '[]' ;;
    *) exit 88 ;;
  esac
  exit 0
fi
for _ in $(seq 1 200); do
  grep -q '^driver:release:' "$NORTH_MCP_EVENTS" 2>/dev/null && break
  sleep 0.01
done
printf '%s\n' '[{"predicate":"kind","value":"lane"},{"predicate":"role","value":"integrator"},{"predicate":"goal","value":"contract probe"},{"predicate":"provider","value":"anthropic"},{"predicate":"provider_target","value":"claude-personal-tompas0x-gmail"},{"predicate":"live_input","value":"streaming"},{"predicate":"live_input_state","value":"frozen"},{"predicate":"live_input_epoch","value":"00000000-0000-4000-8000-000000000041"},{"predicate":"model","value":"claude-opus-4-8"},{"predicate":"effort","value":"xhigh"},{"predicate":"composition_kind","value":"preset"},{"predicate":"composition_id","value":"integrator"},{"predicate":"composition_overrides","value":"[]"},{"predicate":"repo","value":"north"},{"predicate":"spawned_at","value":"2026-07-17T00:00:00Z"},{"predicate":"display_handle","value":"anthropic-claude-gmail-opus-xhigh-integrator-probe"},{"predicate":"display_name","value":"anthropic:claude-personal-tompas0x-gmail · opus · xhigh · gaffer:integrator · contract probe"},{"predicate":"identity_manifest_sha256","value":"c4d461959f641a1917174187051aded161dec0ebfd2eb11641e002f741ed39b8"},{"predicate":"outcome","value":"ran"}]'
`);
  chmodSync(fakeNorth, 0o755);

  const north = resolve(import.meta.dir, "../..");
  const exactFramLog = join(directory, "exact-coordination.log");
  const request = `${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "dispatch", arguments: {
      id: "@019f6c5e-61d0-7880-98a0-f8999eac7b03",
      ...presetRequest("integrator"),
      provider: "anthropic",
      target: "claude-personal-tompas0x-gmail",
      caveman: "lite",
      pinEvidence: pinEvidence([
        { kind: "provider", value: "anthropic" },
        { kind: "account", value: "claude-personal-tompas0x-gmail" },
      ]),
    } },
  })}\n`;
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: request,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: directory,
      NORTH_MCP_BUN: fakeBun,
      NORTH_MCP_BB: fakeBb,
      NORTH_MCP_CAPTURE: capture,
      NORTH_MCP_EVENTS: events,
      NORTH_BIN: fakeNorth,
      NORTH_SPAWN_STARTUP_TIMEOUT_MS: "1000",
      GAFFER_HOME: GAFFER_ROOT,
      FRAM_LOG: exactFramLog,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
  expect(response.result.content[0].text).not.toContain("NORTH_READ_UNAVAILABLE");
  expect(response.result.content[0].text).toContain("completed anthropic-claude-gmail-opus-xhigh-integrator-probe");
  expect(response.result.content[0].text).not.toContain("Agent is running");
  expect(response.result.content[0].text).toContain("target=claude-personal-tompas0x-gmail");
  expect(response.result.content[0].text).toContain("thread @019f6c5e-61d0-7880-98a0-f8999eac7b03");
  expect(response.result.content[0].text).not.toContain("@@019f6c5e-61d0-7880-98a0-f8999eac7b03");
  const [target, provider, agentId, preclaimed, observedFramLog, caveman, cavemanSource, command] =
    readFileSync(capture, "utf8").trim().split("|");
  expect(target).toBe("claude-personal-tompas0x-gmail");
  expect(provider).toBe("anthropic");
  expect(preclaimed).toBe("1");
  expect(observedFramLog).toBe(exactFramLog);
  expect(caveman).toBe("lite");
  expect(cavemanSource).toBe("request");
  expect(command).toContain("/dispatch.ts");
  expect(command).toContain("/dispatch.ts 019f6c5e-61d0-7880-98a0-f8999eac7b03");
  expect(command).not.toContain("@@019f6c5e-61d0-7880-98a0-f8999eac7b03");
  expect(agentId).toMatch(/^sdk-f8999eac7b03-[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const lifecycle = readFileSync(events, "utf8").trim().split("\n");
  expect(lifecycle).toContain("north:json show 019f6c5e-61d0-7880-98a0-f8999eac7b03");
  expect(lifecycle).toContain("north:json children 019f6c5e-61d0-7880-98a0-f8999eac7b03");
  expect(lifecycle.some((line) => line.includes(" query "))).toBe(false);
  const claim = lifecycle.findIndex((line) => line === `driver:claim:@019f6c5e-61d0-7880-98a0-f8999eac7b03:${agentId}`);
  const spawn = lifecycle.findIndex((line) => line === `spawn:${agentId}`);
  const release = lifecycle.findIndex((line) => line === `driver:release:@019f6c5e-61d0-7880-98a0-f8999eac7b03:${agentId}`);
  expect(claim).toBeGreaterThanOrEqual(0);
  expect(spawn).toBeGreaterThan(claim);
  expect(release).toBeGreaterThan(spawn);
});

test("canonical assessment preflight rejects tampering before driver claim or SDK launch", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-assessment-preclaim-"));
  temporary.push(directory);
  const sdkMarker = join(directory, "sdk-launched");
  const driverMarker = join(directory, "driver-claimed");
  const fakeBun = join(directory, "bun");
  const fakeBb = join(directory, "bb");
  writeFileSync(fakeBun, `#!/usr/bin/env bash\ntouch ${JSON.stringify(sdkMarker)}\n`);
  writeFileSync(fakeBb, `#!/usr/bin/env bash\ntouch ${JSON.stringify(driverMarker)}\nexit 0\n`);
  chmodSync(fakeBun, 0o755);
  chmodSync(fakeBb, 0o755);
  const route = presetRequest("executor");
  const hostileAssessment = {
    version: "minimum-sufficient-v1",
    signals: {
      decisionOwnership: "none", seamScope: "none",
      errorExposure: "contained-reversible", oracleStrength: "objective-local",
      foundationalImpact: "none", dependencyShape: "atomic-cohesive",
      reasoningShape: "deterministic",
    },
    derived: {
      minimumTier: "standard", minimumReasoning: "medium", ruleCodes: ["forged"],
    },
    selected: { tier: route.tier, reasoning: route.reasoning },
    exception: { code: "unmodeled-risk", detail: "attempt to bypass canonical derivation" },
  };
  const north = resolve(import.meta.dir, "../..");
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "dispatch", arguments: {
        id: "019f6c5e-61d0-7880-98a0-f8999eac7b03",
        ...route,
        routingAssessment: hostileAssessment,
      } } })}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      NORTH_POLICY_BUN: process.execPath,
      NORTH_MCP_BUN: fakeBun,
      NORTH_MCP_BB: fakeBb,
    },
  });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain("canonical Gaffer validation");
  expect(() => readFileSync(driverMarker)).toThrow();
  expect(() => readFileSync(sdkMarker)).toThrow();
});

test("MCP rejects a new unassessed max request before SDK launch", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-max-preclaim-"));
  temporary.push(directory);
  const marker = join(directory, "sdk-launched");
  const fakeBun = join(directory, "bun");
  writeFileSync(fakeBun, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(fakeBun, 0o755);
  const route = presetRequest("executor");
  const north = resolve(import.meta.dir, "../..");
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "spawn", arguments: {
        prompt: "unassessed max must fail",
        ...route,
        tier: "frontier",
        reasoning: "max",
        composition: {
          kind: "preset", id: route.role, overrides: ["tier", "reasoning"],
          overrideReason: "exceptional request",
        },
      } } })}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      NORTH_POLICY_BUN: process.execPath,
      NORTH_MCP_BUN: fakeBun,
    },
  });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain(
    "reasoning=max requires a canonical routingAssessment",
  );
  expect(() => readFileSync(marker)).toThrow();
});

test("MCP spawn reports pre-identity construction failure instead of fabricating a handle", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-startup-failure-"));
  temporary.push(directory);
  const fakeNorth = join(directory, "north");
  writeFileSync(fakeNorth, "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(fakeNorth, 0o755);

  const north = resolve(import.meta.dir, "../..");
  const request = `${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: {
      name: "spawn",
      arguments: { prompt: "construction failure probe", ...presetRequest("verifier") },
    },
  })}\n`;
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: request,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: directory,
      GAFFER_HOME: GAFFER_ROOT,
      NORTH_BIN: fakeNorth,
      NORTH_MCP_BUN: "/bin/false",
      NORTH_SPAWN_STARTUP_TIMEOUT_MS: "500",
      NO_COLOR: "1",
    },
  });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain("child exited before startup acknowledgement");
  expect(response.result.content[0].text).toContain("durable log:");
  expect(response.result.content[0].text).not.toContain("spawned unknown");
  expect(response.result.content[0].text).not.toContain("Agent is running");
});

test("MCP dispatch rejects a contended thread before spawning and redacts coordinator output", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-mcp-contended-"));
  temporary.push(directory);
  const marker = join(directory, "spawned");
  const fakeBun = join(directory, "bun");
  const fakeBb = join(directory, "bb");
  writeFileSync(fakeBun, `#!/usr/bin/env bash
touch "$NORTH_MCP_MARKER"
`);
  chmodSync(fakeBun, 0o755);
  writeFileSync(fakeBb, `#!/usr/bin/env bash
printf '%s\n' 'CANARY private coordinator diagnostic' >&2
exit 3
`);
  chmodSync(fakeBb, 0o755);

  const north = resolve(import.meta.dir, "../..");
  const thread = "019f6c5e-61d0-7880-98a0-f8999eac7b03";
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "dispatch", arguments: {
        id: thread,
        ...presetRequest("verifier"),
      } } })}\n`,
    encoding: "utf8",
    env: { ...process.env, NORTH_MCP_BUN: fakeBun, NORTH_MCP_BB: fakeBb, NORTH_MCP_MARKER: marker },
  });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toBe(`thread @${thread} already has an active driver`);
  expect(response.result.content[0].text).not.toContain("CANARY");
  expect(() => readFileSync(marker)).toThrow();
});

test("raw MCP rejects non-contract Gaffer fields and verifier-as-topology before spawning", () => {
  const north = resolve(import.meta.dir, "../..");
  for (const [name, arguments_, expected] of [
    ["spawn", [], "arguments must be an object"],
    ["dispatch", {}, "dispatch id must be a non-empty string"],
    ["dispatch", { id: 42 }, "dispatch id must be a non-empty string"],
    ["dispatch", {
      id: "@@019f6c5e-61d0-7880-98a0-f8999eac7b03",
      role: "verifier",
      composition: { kind: "preset", id: "verifier", overrides: [] },
    }, "dispatch id must be a safe North thread id (bare or single @ prefix)"],
    ["dispatch", {
      id: "thread;touch-owned",
      role: "verifier",
      composition: { kind: "preset", id: "verifier", overrides: [] },
    }, "dispatch id must be a safe North thread id (bare or single @ prefix)"],
    ["spawn", {}, "spawn prompt must be a non-empty string"],
    ["spawn", { prompt: "" }, "spawn prompt must be a non-empty string"],
    ["spawn", { prompt: "probe" }, "managed spawn requires the complete eight-field Gaffer request; missing: role, taskGrade, domainRequirements, topology, tier, reasoning, posture, composition (recover the valid payload shape: north show @contract:dispatch)"],
    ["dispatch", { id: "019f6c5e-61d0-7880-98a0-f8999eac7b03" }, "managed dispatch requires the complete eight-field Gaffer request; missing: role, taskGrade, domainRequirements, topology, tier, reasoning, posture, composition (recover the valid payload shape: north show @contract:dispatch)"],
    ["spawn", { prompt: "probe", ...presetRequest("verifier"), model: 42 }, "model must be a non-empty string"],
    ["spawn", { prompt: "probe", ...presetRequest("verifier"), coordinator: { raw: "value" } }, "coordinator must be a non-empty string"],
    ["spawn", { prompt: "probe", ...presetRequest("verifier"), caveman: "extreme" }, "invalid caveman mode"],
  ] as const) {
    const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call",
        params: { name, arguments: arguments_ } })}\n`,
      encoding: "utf8", env: { ...process.env, NORTH_MCP_BUN: "/bin/false" },
    });
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout.trim());
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toBe(expected);
  }

  for (const [field, value] of [
    ["invokedAs", "researcher"],
    ["shape", "integrate"],
    ["allocation", { mode: "preferential" }],
  ] as const) {
    const request = `${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "spawn", arguments: { prompt: "contract probe", role: "integrator", [field]: value } },
    })}\n`;
    const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
      input: request, encoding: "utf8", env: { ...process.env, NORTH_MCP_BUN: "/bin/false" },
    });
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout.trim());
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain(`unknown spawn routing field(s): ${field}`);
  }

  const topologyRequest = `${JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: {
      name: "spawn",
      arguments: { prompt: "contract probe", ...presetRequest("verifier"), topology: "verifier" },
    },
  })}\n`;
  const topologyResult = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: topologyRequest, encoding: "utf8", env: { ...process.env, NORTH_MCP_BUN: "/bin/false" },
  });
  const topologyResponse = JSON.parse(topologyResult.stdout.trim());
  expect(topologyResponse.result.isError).toBe(true);
  expect(topologyResponse.result.content[0].text).toBe("invalid topology");

  for (const [arguments_, expected] of [
    [{
      prompt: "probe",
      ...presetRequest("verifier"),
      role: "special",
      composition: { kind: "preset", id: "special", overrides: [] },
    }, "unknown role special requires a bespoke composition"],
    [{ prompt: "probe", ...presetRequest("integrator"),
      composition: { kind: "preset", id: "scout", overrides: [] } },
      "known role integrator requires preset composition id integrator"],
    [{ prompt: "probe", ...presetRequest("scout"), role: "researcher",
      composition: { kind: "preset", id: "researcher", overrides: [] } },
      "role researcher is retired because it was ambiguous"],
    [{ prompt: "probe", ...presetRequest("director"), role: "orchestrator",
      composition: { kind: "preset", id: "orchestrator", overrides: [] } },
      "orchestrator is a topology, not a role"],
  ] as const) {
    const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "spawn", arguments: arguments_ } })}\n`,
      encoding: "utf8", env: { ...process.env, NORTH_MCP_BUN: "/bin/false" },
    });
    const response = JSON.parse(result.stdout.trim());
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain(expected);
  }
});

test("managed MCP admits recursive orchestrator shapes but requires an exact parent reservation", () => {
  const north = resolve(import.meta.dir, "../..");
  const orchestratorContract = {
    responsibility: "coordinate a bounded migration",
    deliverable: "integrated migration result",
    capabilities: ["coordination", "filesystem.read", "filesystem.search", "shell.readonly"],
    mayDecide: ["worker decomposition"],
    mustEscalate: ["scope expansion"],
    doneWhen: ["all worker results are reconciled"],
    report: "integrated verdict",
  };
  const shapes = [
    presetRequest("director"),
    {
      ...presetRequest("director"),
      tier: "senior",
      reasoning: "high",
      composition: {
        kind: "preset", id: "director", overrides: ["tier", "reasoning"],
        overrideReason: "bounded coordination does not require frontier tier",
      },
    },
    {
      role: "migration-director",
      taskGrade: "senior",
      domainRequirements: [],
      topology: "orchestrator",
      tier: "senior",
      reasoning: "high",
      posture: "preserve",
      composition: {
        kind: "bespoke",
        id: "migration-director",
        bespokeReason: "one-off coordination shape",
        promotionCandidate: false,
        contract: orchestratorContract,
      },
    },
  ];
  let id = 100;
  for (const name of ["spawn", "dispatch"]) {
    for (const shape of shapes) {
      const arguments_ = name === "spawn"
        ? { prompt: "managed recursive orchestration", ...shape }
        : { id: "depth-cap-thread", ...shape };
      const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
        input: `${JSON.stringify({
          jsonrpc: "2.0", id: id++, method: "tools/call",
          params: { name, arguments: arguments_ },
        })}\n`,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_TOPOLOGY: "orchestrator",
          AGENT_ID: "parent-director",
          NORTH_MCP_BUN: "/bin/false",
        },
      });
      expect(result.status).toBe(0);
      const response = JSON.parse(result.stdout.trim());
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).not.toContain("coordination depth denied");
      expect(response.result.content[0].text).toContain(
        name === "spawn"
          ? "exact parent run/thread reservation"
          : "could not establish the active driver",
      );
    }
  }
});
