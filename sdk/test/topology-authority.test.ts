import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertCoordinationAuthority, TopologyAuthorityError,
} from "../src/topology-authority";
import { sendPeerCommand, validatePeerCommandArgs } from "../src/harness";
import { presetRequest } from "./routing-fixtures";

const temporary: string[] = [];
const inheritedTopology = process.env.AGENT_TOPOLOGY;
const inheritedPath = process.env.PATH;
const inheritedPeerBb = process.env.NORTH_PEER_BB;
afterEach(() => {
  if (inheritedTopology === undefined) delete process.env.AGENT_TOPOLOGY;
  else process.env.AGENT_TOPOLOGY = inheritedTopology;
  if (inheritedPath === undefined) delete process.env.PATH;
  else process.env.PATH = inheritedPath;
  if (inheritedPeerBb === undefined) delete process.env.NORTH_PEER_BB;
  else process.env.NORTH_PEER_BB = inheritedPeerBb;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("peer command accepts a complete Gaffer envelope, never role-only or partial routing", () => {
  expect(() => validatePeerCommandArgs("spawn", {
    prompt: "probe", ...presetRequest("verifier"),
  })).not.toThrow();
  expect(() => validatePeerCommandArgs("dispatch", {
    thread: "thread-probe",
    role: "verifier",
    taskGrade: "senior",
    domainRequirements: [],
    topology: "worker",
    tier: "senior",
    reasoning: "high",
    posture: "evaluate",
    composition: { kind: "preset", id: "verifier", overrides: [] },
  })).not.toThrow();
  expect(() => validatePeerCommandArgs("spawn", {
    prompt: "probe", role: "verifier",
  })).toThrow("complete eight-field");
  expect(() => validatePeerCommandArgs("spawn", {
    prompt: "probe", role: "verifier", tier: "senior",
  })).toThrow("complete eight-field");
  expect(() => validatePeerCommandArgs("spawn", {
    prompt: "probe", role: "verifier", hiddenAuthority: "root",
  } as any)).toThrow("unknown field");
  expect(() => validatePeerCommandArgs("tell", { id: "x", pred: "goal" } as any))
    .toThrow("requires id, pred, and value");
  expect(() => validatePeerCommandArgs("tell", {
    id: "thread-grade", pred: "judgment_grade", value: "s",
  })).not.toThrow();
  for (const value of ["S", "medium", " s", "s "]) {
    expect(() => validatePeerCommandArgs("tell", {
      id: "thread-grade", pred: "judgment_grade", value,
    })).toThrow("exactly one of");
  }
});

test("peer managed spawn fails before msg-cli for both workers and orchestrators", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-peer-command-"));
  temporary.push(directory);
  const marker = join(directory, "argv");
  const fakeBb = join(directory, "bb");
  writeFileSync(fakeBb, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nprintf accepted\n`);
  chmodSync(fakeBb, 0o755);
  process.env.PATH = `${directory}:${inheritedPath ?? ""}`;
  process.env.NORTH_PEER_BB = fakeBb;

  process.env.AGENT_TOPOLOGY = "worker";
  expect(() => sendPeerCommand("worker", "peer", "spawn", {
    prompt: "must not publish", role: "director",
  })).toThrow("command_peer:spawn requires orchestrator topology");
  expect(existsSync(marker)).toBe(false);

  process.env.AGENT_TOPOLOGY = "orchestrator";
  expect(() => sendPeerCommand("director", "peer", "spawn", {
    prompt: "verify it", role: "verifier",
  })).toThrow("peer spawn is unsupported until atomic command claim + child reconciliation land");
  expect(existsSync(marker)).toBe(false);
});

test("authority is ambient only for top-level sessions and otherwise fail-closed", () => {
  delete process.env.AGENT_TOPOLOGY;
  expect(() => assertCoordinationAuthority("spawn", undefined)).not.toThrow();
  expect(() => assertCoordinationAuthority("spawn", "orchestrator")).not.toThrow();
  for (const topology of ["worker", "unexpected"]) {
    let error: unknown;
    try { assertCoordinationAuthority("spawn", topology); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TopologyAuthorityError);
    expect(error).toMatchObject({
      code: "NORTH_TOPOLOGY_AUTHORITY_DENIED",
      operation: "spawn",
      topology,
      preSideEffect: true,
    });
  }
});

test("raw SDK spawn and dispatch reject workers before admission, driver, or provider boundaries", async () => {
  const previous = process.env.AGENT_TOPOLOGY;
  const previousIdentityRedirect = process.env.NORTH_IDENTITY_TEST_REDIRECT;
  const previousNorthBin = process.env.NORTH_BIN;
  const previousNorthPort = process.env.NORTH_PORT;
  process.env.AGENT_TOPOLOGY = "worker";
  process.env.NORTH_IDENTITY_TEST_REDIRECT = "1";
  process.env.NORTH_BIN = "/bin/false";
  process.env.NORTH_PORT = "59999";
  let providerCalls = 0;
  let driverCalls = 0;
  try {
    const { spawn, spawnParallel } = await import("./support/spawn");
    await expect(spawn({
      prompt: "must not execute",
      role: "director",
      routingMetadata: { role: "director", topology: "orchestrator" },
      queryFn: () => {
        providerCalls++;
        return { async *[Symbol.asyncIterator]() {} } as any;
      },
    })).rejects.toMatchObject({
      code: "NORTH_TOPOLOGY_AUTHORITY_DENIED",
      operation: "spawn",
      preSideEffect: true,
    });
    await expect(spawnParallel([])).rejects.toMatchObject({
      code: "NORTH_TOPOLOGY_AUTHORITY_DENIED",
      operation: "spawnParallel",
      preSideEffect: true,
    });

    const { dispatch, dispatchParallel } = await import("./support/dispatch");
    await expect(dispatch("authority-probe-thread", {
      claimDriver: (() => {
        driverCalls++;
        return { release() {} };
      }) as any,
    })).rejects.toMatchObject({
      code: "NORTH_TOPOLOGY_AUTHORITY_DENIED",
      operation: "dispatch",
      preSideEffect: true,
    });
    await expect(dispatchParallel([])).rejects.toMatchObject({
      code: "NORTH_TOPOLOGY_AUTHORITY_DENIED",
      operation: "dispatchParallel",
      preSideEffect: true,
    });
    expect(providerCalls).toBe(0);
    expect(driverCalls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TOPOLOGY;
    else process.env.AGENT_TOPOLOGY = previous;
    if (previousIdentityRedirect === undefined) delete process.env.NORTH_IDENTITY_TEST_REDIRECT;
    else process.env.NORTH_IDENTITY_TEST_REDIRECT = previousIdentityRedirect;
    if (previousNorthBin === undefined) delete process.env.NORTH_BIN;
    else process.env.NORTH_BIN = previousNorthBin;
    if (previousNorthPort === undefined) delete process.env.NORTH_PORT;
    else process.env.NORTH_PORT = previousNorthPort;
  }
});

test("raw recursive SDK spawn requires an exact fresh child thread binding before admission", async () => {
  const previous = {
    topology: process.env.AGENT_TOPOLOGY,
    thread: process.env.NORTH_THREAD_ID,
    run: process.env.NORTH_RUN_ID,
    capability: process.env.NORTH_RUN_CAPABILITY,
  };
  process.env.AGENT_TOPOLOGY = "orchestrator";
  process.env.NORTH_THREAD_ID = "parent-thread";
  process.env.NORTH_RUN_ID = "run-parent";
  process.env.NORTH_RUN_CAPABILITY = "cap-parent";
  try {
    const { spawn } = await import("./support/spawn");
    const request = {
      prompt: "recursive probe",
      routingMetadata: presetRequest("verifier"),
      admitBillableClock: () => {
        throw new Error("admission must not run");
      },
    };
    await expect(spawn(request)).rejects.toMatchObject({
      code: "NORTH_RECURSIVE_CHILD_BINDING_REQUIRED",
      preSideEffect: true,
    });
    await expect(spawn({
      ...request,
      thread: "parent-thread",
      loadThreadFacts: () => [],
    })).rejects.toThrow("cannot reuse the parent thread");
    await expect(spawn({
      ...request,
      thread: "child-thread",
      loadThreadFacts: () => [{ predicate: "part_of", value: "@other-thread" }],
    })).rejects.toThrow("exactly one child part_of link");
  } finally {
    if (previous.topology === undefined) delete process.env.AGENT_TOPOLOGY;
    else process.env.AGENT_TOPOLOGY = previous.topology;
    if (previous.thread === undefined) delete process.env.NORTH_THREAD_ID;
    else process.env.NORTH_THREAD_ID = previous.thread;
    if (previous.run === undefined) delete process.env.NORTH_RUN_ID;
    else process.env.NORTH_RUN_ID = previous.run;
    if (previous.capability === undefined) delete process.env.NORTH_RUN_CAPABILITY;
    else process.env.NORTH_RUN_CAPABILITY = previous.capability;
  }
});

test("raw MCP spawn and dispatch reject worker callers before preflight, claim, or launch", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-topology-mcp-"));
  temporary.push(directory);
  const bunMarker = join(directory, "bun-called");
  const bbMarker = join(directory, "bb-called");
  const fakeBun = join(directory, "bun");
  const fakeBb = join(directory, "bb");
  writeFileSync(fakeBun, `#!/usr/bin/env bash\ntouch ${JSON.stringify(bunMarker)}\nexit 1\n`);
  writeFileSync(fakeBb, `#!/usr/bin/env bash\ntouch ${JSON.stringify(bbMarker)}\nexit 1\n`);
  chmodSync(fakeBun, 0o755);
  chmodSync(fakeBb, 0o755);

  const north = resolve(import.meta.dir, "../..");
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "spawn", arguments: {
        prompt: "must not execute", role: "director", topology: "orchestrator",
      } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "dispatch", arguments: {
        id: "authority-probe-thread", role: "director", topology: "orchestrator",
      } } },
  ].map((request) => JSON.stringify(request)).join("\n") + "\n";
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: requests,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_TOPOLOGY: "worker",
      NORTH_MCP_BUN: fakeBun,
      NORTH_MCP_BB: fakeBb,
      NORTH_BIN: "/bin/false",
    },
  });
  expect(result.status).toBe(0);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(responses).toHaveLength(2);
  for (const [index, operation] of ["spawn", "dispatch"].entries()) {
    expect(responses[index].result.isError).toBe(true);
    expect(responses[index].result.content[0].text).toBe(
      `coordination authority denied: ${operation} requires orchestrator topology; current topology is worker`,
    );
  }
  expect(existsSync(bunMarker)).toBe(false);
  expect(existsSync(bbMarker)).toBe(false);
});

test("MCP generic tell cannot emulate a peer retask under worker topology", () => {
  const north = resolve(import.meta.dir, "../..");
  const request = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "tell", arguments: {
      id: "agent:peer-agent", predicate: "goal", value: "hijacked goal",
    } },
  }) + "\n";
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: request,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_TOPOLOGY: "worker",
      AGENT_ID: "worker-self",
      NORTH_BIN: resolve(north, "bin/north"),
      FRAM_HOME: "/definitely/absent",
    },
  });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain(
    "worker topology cannot mutate agent identity or authority via generic facts",
  );
  expect(response.result.content[0].text).not.toContain("subject resolver");
});

test("MCP generic tell cannot bypass the run-scoped evidence writer", () => {
  const north = resolve(import.meta.dir, "../..");
  const request = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "tell", arguments: {
      id: "run-other-lane", predicate: "run_bar_evidence", value: "{}",
    } },
  }) + "\n";
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], {
    input: request,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_TOPOLOGY: "worker",
      AGENT_ID: "worker-self",
      NORTH_BIN: resolve(north, "bin/north"),
      FRAM_HOME: "/definitely/absent",
    },
  });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain(
    "generic fact verbs cannot mutate harness-owned run facts",
  );
  expect(response.result.content[0].text).toContain("north evidence record");
});
