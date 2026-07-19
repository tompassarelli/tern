import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDeliveryEvidence } from "../../sdk/src/delivery-verification.ts";
import {
  agentBundleOp,
  boundedAgentBundleRows,
  liveAgentLeases,
  validAgentControl,
} from "../out/north/fram.js";
import {
  fold_bundle,
  gaffer_provenance,
  project_agent,
  provider_target_label,
  semantic_handle,
  validReportedEvidence,
} from "../out/north/presence.js";
import { api_agents } from "../out/north/server.js";

const fixtures = await Bun.file(
  new URL("../../sdk/test/fixtures/agent-roster-contract.json", import.meta.url),
).json();
const inherited = {
  framLog: process.env.FRAM_LOG,
  telemetryLog: process.env.FRAM_TELEMETRY_LOG,
};
const temporaryDirectories = [];

afterEach(() => {
  if (inherited.framLog === undefined) delete process.env.FRAM_LOG;
  else process.env.FRAM_LOG = inherited.framLog;
  if (inherited.telemetryLog === undefined) delete process.env.FRAM_TELEMETRY_LOG;
  else process.env.FRAM_TELEMETRY_LOG = inherited.telemetryLog;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configureEmptyLogs() {
  const directory = mkdtempSync(join(tmpdir(), "north-web-roster-"));
  const coordination = join(directory, "coordination.log");
  const telemetry = join(directory, "telemetry.log");
  writeFileSync(coordination, "");
  writeFileSync(telemetry, "");
  temporaryDirectories.push(directory);
  process.env.FRAM_LOG = coordination;
  process.env.FRAM_TELEMETRY_LOG = telemetry;
}

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function committedTerminal(facts) {
  const predicates = [
    "delivery_attestation",
    "delivery_attestation_sha256",
    "delivery_evidence",
    "delivery_evidence_sha256",
    "delivery_outcome",
    "delivery_reason",
    "outcome",
    "process_outcome",
  ];
  const canonical = predicates
    .filter((predicate) => typeof facts[predicate] === "string" && facts[predicate].trim())
    .map((predicate) => `${predicate}\0${facts[predicate]}\n`)
    .join("");
  return { ...facts, terminal_manifest_sha256: sha256(canonical) };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

describe("semantic agent roster contract", () => {
  test("shared fixtures project identical provider, model, effort, and Gaffer identity", () => {
    for (const fixture of fixtures) {
      const projected = project_agent(
        fixture.id,
        fixture.facts,
        {},
        { expires_s: 30 },
        {},
        Date.parse("2026-07-19T01:03:00Z"),
      );
      expect(provider_target_label(fixture.facts), fixture.name)
        .toBe(fixture.expected.providerLabel);
      expect(gaffer_provenance(fixture.facts), fixture.name)
        .toBe(fixture.expected.gafferProvenance);
      expect(semantic_handle(fixture.id, fixture.facts), fixture.name)
        .toBe(fixture.expected.semanticHandle);
      expect(projected, fixture.name).toMatchObject({
        uuid: fixture.id,
        control_id: fixture.id,
        display_name: fixture.expected.displayName,
        display_handle: fixture.facts.display_handle,
        provider_label: fixture.expected.providerLabel,
        model_display: fixture.expected.modelDisplay,
        effort: fixture.expected.effortDisplay,
        gaffer_provenance: fixture.expected.gafferProvenance,
      });
    }
  });

  test("native conflict projection matches the shared order-independent golden", () => {
    const native = fixtures.find(({ name }) => name === "native-session");
    if (!native) throw new Error("missing native fixture");
    for (const observationCase of native.observationCases) {
      const subject = `@agent:${native.id}`;
      const folded = fold_bundle(
        observationCase.observations.map(([predicate, value]) =>
          [subject, predicate, value]),
      );
      const facts = folded[subject];
      const projected = project_agent(
        native.id,
        facts,
        {},
        { expires_s: 30 },
        {},
        Date.parse("2026-07-19T01:03:00Z"),
      );
      expect(provider_target_label(facts), observationCase.name)
        .toBe(observationCase.expected.providerLabel);
      expect(gaffer_provenance(facts), observationCase.name)
        .toBe(observationCase.expected.gafferProvenance);
      expect(semantic_handle(native.id, facts), observationCase.name)
        .toBe(observationCase.expected.semanticHandle);
      expect(projected, observationCase.name).toMatchObject({
        display_name: observationCase.expected.displayName,
        display_handle: observationCase.expected.displayHandle,
        provider_label: observationCase.expected.providerLabel,
        model_display: observationCase.expected.modelDisplay,
        effort: observationCase.expected.effortDisplay,
        gaffer_provenance: observationCase.expected.gafferProvenance,
      });
    }
  });

  test("unrelated multi-valued facts cannot corrupt a valid managed identity", () => {
    const fixture = fixtures.find(({ name }) => name === "exact-preset");
    if (!fixture) throw new Error("missing exact-preset fixture");
    expect(gaffer_provenance({
      ...fixture.facts,
      __conflicts: { task: true },
    })).toBe("gaffer:designer");
    expect(gaffer_provenance({
      ...fixture.facts,
      __conflicts: { display_name: true },
    })).toBe("gaffer:designer");
    expect(gaffer_provenance({
      ...fixture.facts,
      __conflicts: { goal: true },
    })).toBe("gaffer:legacy-debt");
  });

  test("reported lifecycle requires the full run-scoped evidence contract", () => {
    const fixture = fixtures.find(({ name }) => name === "exact-preset");
    if (!fixture) throw new Error("missing exact-preset fixture");
    const record = {
      version: "north:run-bar-evidence:v1",
      run: "@run-worker",
      thread: "@thread",
      reporter: "@agent:worker",
      bar: "tests pass",
      observed: "exit 0",
      recordedAt: "2026-07-19T02:00:00.000Z",
    };
    const snapshot = {
      version: "north:done-bars:v2",
      run: record.run,
      thread: record.thread,
      reporter: record.reporter,
      contractOrigin: "accepted",
      baselineDoneWhen: [record.bar],
      doneWhen: [record.bar],
      matches: [{ bar: record.bar, evidence: [record] }],
    };
    const evidence = JSON.stringify(snapshot);
    const terminal = committedTerminal({
      outcome: "ran",
      process_outcome: "ran",
      delivery_outcome: "reported",
      delivery_reason: "complete_run_scoped_done_bar_evidence_self_reported",
      delivery_evidence: evidence,
      delivery_evidence_sha256: sha256(evidence),
    });
    expect(validReportedEvidence(evidence, terminal.delivery_evidence_sha256)).toBeTrue();
    const parityCandidates = [
      snapshot,
      { ...snapshot, extra: true },
      { ...snapshot, run: "@run bad" },
      { ...snapshot, thread: "@thread with space" },
      { ...snapshot, reporter: "@agent:bad account" },
      { ...snapshot, baselineDoneWhen: [] },
      { ...snapshot, doneWhen: ["z", "a"] },
      { ...snapshot, doneWhen: ["tests pass", "tests pass"] },
      { ...snapshot, matches: [] },
      {
        ...snapshot,
        matches: [{
          ...snapshot.matches[0],
          evidence: [{ ...record, observed: "\ud800" }],
        }],
      },
      {
        ...snapshot,
        matches: [{
          ...snapshot.matches[0],
          evidence: [{ ...record, recordedAt: "2026-02-30T02:00:00Z" }],
        }],
      },
    ];
    for (const candidate of parityCandidates) {
      const raw = JSON.stringify(candidate);
      expect(validReportedEvidence(raw, sha256(raw)), raw)
        .toBe(Boolean(parseDeliveryEvidence(raw)));
    }
    expect(project_agent(
      "reported",
      { ...fixture.facts, ...terminal },
      {},
      { expires_s: 30 },
      {},
      Date.now(),
    )).toMatchObject({
      state: "finished",
      process_outcome: "ran",
      delivery_outcome: "reported",
    });

    const malformedSnapshot = structuredClone(snapshot);
    malformedSnapshot.matches[0].evidence[0].bar = "different bar";
    malformedSnapshot.matches[0].evidence[0].recordedAt = "2026-02-30T02:00:00Z";
    const malformedEvidence = JSON.stringify(malformedSnapshot);
    const malformedTerminal = committedTerminal({
      ...terminal,
      delivery_evidence: malformedEvidence,
      delivery_evidence_sha256: sha256(malformedEvidence),
    });
    expect(validReportedEvidence(
      malformedEvidence,
      malformedTerminal.delivery_evidence_sha256,
    )).toBeFalse();
    expect(project_agent(
      "reported",
      { ...fixture.facts, ...malformedTerminal },
      {},
      { expires_s: 30 },
      {},
      Date.now(),
    )).toMatchObject({
      state: "working",
      process_outcome: "",
      delivery_outcome: "",
    });
  });

  test("terminal conflicts never fall back to legacy or manufacture delivery truth", () => {
    const modern = committedTerminal({
      outcome: "ran",
      process_outcome: "ran",
      delivery_outcome: "unverified",
      delivery_reason: "provider_terminal_success_without_external_verification",
    });
    expect(project_agent(
      "conflict",
      { ...modern, __conflicts: { process_outcome: true } },
      {},
      { expires_s: 30 },
      {},
      Date.now(),
    )).toMatchObject({
      state: "working",
      process_outcome: "",
      delivery_outcome: "",
    });
    const residue = committedTerminal({
      outcome: "ran",
      process_outcome: "ran",
      delivery_outcome: "unverified",
      delivery_reason: "provider_terminal_success_without_external_verification",
      delivery_evidence: "",
    });
    expect(project_agent(
      "proof-residue",
      residue,
      {},
      { expires_s: 30 },
      {},
      Date.now(),
    )).toMatchObject({
      state: "working",
      process_outcome: "",
      delivery_outcome: "",
    });
    expect(project_agent(
      "legacy",
      { outcome: "ran", delivery_outcome: "verified" },
      {},
      { expires_s: 30 },
      {},
      Date.now(),
    )).toMatchObject({
      state: "finished",
      state_label: "finished(process:ran, delivery:unrecorded)",
      process_outcome: "ran",
      delivery_outcome: "",
    });
  });

  test("a display fallback is not fabricated as active deliberation", () => {
    const fixture = fixtures.find(({ name }) => name === "exact-preset");
    if (!fixture) throw new Error("missing exact-preset fixture");
    expect(project_agent(
      fixture.id,
      fixture.facts,
      {},
      { expires_s: 30 },
      {},
      Date.now(),
    )).toMatchObject({
      task: fixture.facts.goal,
      focus: false,
      thinking: false,
    });
    expect(project_agent(
      fixture.id,
      fixture.facts,
      { current_thread: "Implement the roster" },
      { expires_s: 30 },
      {},
      Date.now(),
    )).toMatchObject({
      task: "Implement the roster",
      focus: true,
      thinking: true,
    });
  });

  test("bundle construction validates and bounds graph-derived control literals", () => {
    expect(validAgentControl("lane-safe_1:child.2")).toBeTrue();
    for (const invalid of [
      "",
      "lane with spaces",
      'lane-"injection',
      "lane\ninjection",
      "λ-agent",
      `a${"x".repeat(256)}`,
    ]) {
      expect(validAgentControl(invalid), invalid).toBeFalse();
    }

    const op = agentBundleOp(["lane-b", "lane-a", "lane-a"]);
    expect(op).toContain('"@agent:lane-a"');
    expect(op).toContain('"@session:lane-a"');
    expect(op).toContain('"@agent:lane-b"');
    expect(op).not.toContain('{:var "s"}');
    expect(agentBundleOp(['lane-"injection'])).toBeNull();
    expect(agentBundleOp(new Array(256).fill(0).map((_, index) => `lane-${index}`)))
      .not.toBeNull();
    expect(agentBundleOp(new Array(257).fill(0).map((_, index) => `lane-${index}`))).toBeNull();
    expect(boundedAgentBundleRows(new Array(32_769))).toBeNull();
    expect(boundedAgentBundleRows([
      ["@agent:lane-a", "provider", "openai"],
      ["@session:lane-a", "current_thread", "work"],
    ])).toHaveLength(2);
    expect(boundedAgentBundleRows([["@other:lane-a", "provider", "openai"]])).toBeNull();
    expect(boundedAgentBundleRows([["@agent:lane-a", "provider"]])).toBeNull();
    expect(boundedAgentBundleRows([[["@agent:lane-a"], "provider", "openai"]])).toBeNull();
  });

  test("lease fold excludes expired and malformed controls while retaining the newest lease", () => {
    expect(liveAgentLeases([
      ["@lease:session:live", "live|2100|1"],
      ["@lease:session:live", "live|2300|2"],
      ["@lease:session:expired", "expired|1900|1"],
      ["@lease:session:bad control", "bad control|2400|1"],
      ["@lease:session:exponent", "exponent|2e3|1"],
      [["@lease:session:array"], "array|2400|1"],
      ["@other:session:ignored", "ignored|2400|1"],
    ], 2_000)).toEqual([{ control: "live", expires_s: 0 }]);
  });

  test("live API performs two indexed calls and retains a just-finished valid lease", async () => {
    configureEmptyLogs();
    const now = Date.now();
    const requests = [];
    const fixture = fixtures.find(({ name }) => name === "exact-preset");
    if (!fixture) throw new Error("missing exact-preset fixture");
    const factRows = Object.entries(fixture.facts)
      .map(([predicate, value]) => ["@agent:live", predicate, value]);
    factRows.push(["@agent:live", "outcome", "ran"]);
    factRows.push(["@session:live", "current_thread", "Finalize semantic roster"]);

    const server = createServer((socket) => {
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk.toString("utf8");
        if (!request.includes("\n")) return;
        requests.push(request);
        if (requests.length === 1) {
          socket.end(`${JSON.stringify({
            ok: [
              ["@lease:session:live", `live|${now + 60_000}|1`],
              ["@lease:session:expired", `expired|${now - 1}|1`],
            ],
          })}\n`);
        } else if (requests.length === 2) {
          socket.end(`${JSON.stringify({ ok: factRows })}\n`);
        } else {
          socket.end(`${JSON.stringify({ ok: [] })}\n`);
        }
      });
    });
    const port = await listen(server);

    try {
      const result = await api_agents(port);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain('"session_lease"');
      expect(requests[1]).toContain('"@agent:live"');
      expect(requests[1]).toContain('"@session:live"');
      expect(requests[1]).not.toContain("@agent:expired");
      expect(requests[1]).not.toContain("@session:expired");
      expect(requests[1]).not.toContain('{:var "s"}');
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toMatchObject({
        uuid: "live",
        control_id: "live",
        display_name: fixture.expected.displayName,
        provider_label: fixture.expected.providerLabel,
        model_display: fixture.expected.modelDisplay,
        effort: fixture.expected.effortDisplay,
        gaffer_provenance: fixture.expected.gafferProvenance,
        task: "Finalize semantic roster",
        state: "finished",
        state_label: "finished(process:ran, delivery:unrecorded)",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
