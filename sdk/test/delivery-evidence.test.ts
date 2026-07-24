import { expect, test } from "bun:test";
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliveryReservationFailureCause, deliveryRunEnvironment,
  deliveryWriterInvocation, loadDeliveryRunState, newDeliveryRunContext,
  recordRunBarEvidence, RUN_RESERVATION_VERSION, runReservationValid,
} from "../src/delivery-evidence";
import { MANAGED_NORTH_MCP_ENV_KEYS } from "../src/execution-admission";
import { harnessOptions } from "../src/harness";
import {
  MAX_DELIVERY_BARS, MAX_RUN_BAR_EVIDENCE_RECORD_UTF8_BYTES,
  RUN_BAR_EVIDENCE_VERSION, sha256,
} from "../src/delivery-verification";

const conformance = JSON.parse(readFileSync(
  new URL("./fixtures/delivery-conformance.json", import.meta.url),
  "utf8",
)) as {
  reservationBody: Array<[string, string]>;
  reservationManifestSha256: string;
};

test("delivery run context is explicit and never mutates ambient process env", () => {
  const before = {
    run: process.env.NORTH_RUN_ID,
    thread: process.env.NORTH_THREAD_ID,
    capability: process.env.NORTH_RUN_CAPABILITY,
  };
  const context = newDeliveryRunContext(
    "run-lane-123",
    "thread-123",
    "lane-123",
    "a".repeat(64),
  );
  expect(deliveryRunEnvironment(context)).toEqual({
    NORTH_RUN_ID: "run-lane-123",
    NORTH_THREAD_ID: "thread-123",
    NORTH_RUN_CAPABILITY: "a".repeat(64),
  });
  const options = harnessOptions({
    self: "lane-123",
    deliveryRun: context,
    presenceRegistrar: false,
    presenceRenewer: false,
  }) as any;
  expect(options.env.NORTH_RUN_ID).toBe("run-lane-123");
  expect(options.env.NORTH_THREAD_ID).toBe("thread-123");
  expect(options.env.NORTH_RUN_CAPABILITY).toBe("a".repeat(64));
  expect(options.mcpServers.north.env.NORTH_RUN_ID).toBe("run-lane-123");
  expect(options.mcpServers.north.env.NORTH_THREAD_ID).toBe("thread-123");
  expect(options.mcpServers.north.env.NORTH_RUN_CAPABILITY).toBe("a".repeat(64));
  const withoutReservation = harnessOptions({
    self: "lane-without-reservation",
    presenceRegistrar: false,
    presenceRenewer: false,
  }) as any;
  for (const key of ["NORTH_RUN_ID", "NORTH_THREAD_ID", "NORTH_RUN_CAPABILITY"]) {
    expect(withoutReservation.env[key]).toBeUndefined();
    expect(withoutReservation.mcpServers.north.env[key]).toBeUndefined();
  }
  expect({
    run: process.env.NORTH_RUN_ID,
    thread: process.env.NORTH_THREAD_ID,
    capability: process.env.NORTH_RUN_CAPABILITY,
  }).toEqual(before);
});

test("writer failures never echo the live capability in diagnostics", () => {
  const capability = "b".repeat(64);
  expect(() => recordRunBarEvidence("tests pass", "exit 0", {
    AGENT_ID: "lane-123",
    NORTH_RUN_ID: "run-lane-123",
    NORTH_THREAD_ID: "thread-123",
    NORTH_RUN_CAPABILITY: capability,
    NORTH_PORT: "1",
  })).toThrow("delivery evidence record rejected");
  try {
    recordRunBarEvidence("tests pass", "exit 0", {
      AGENT_ID: "lane-123",
      NORTH_RUN_ID: "run-lane-123",
      NORTH_THREAD_ID: "thread-123",
      NORTH_RUN_CAPABILITY: capability,
      NORTH_PORT: "1",
    });
  } catch (error) {
    expect(String(error)).not.toContain(capability);
  }
});

test("reservation failure diagnostics expose only bounded semantic causes", () => {
  const secret = "live-capability-must-not-leak";
  expect(deliveryReservationFailureCause(new Error(
    `delivery evidence reserve rejected: delivery evidence publication deadline exceeded ${secret}`,
  ))).toBe("publication deadline exceeded");
  expect(deliveryReservationFailureCause(new Error(
    `delivery evidence reserve rejected: run reservation projection changed before commit ${secret}`,
  ))).toBe("reservation conflict");
  expect(deliveryReservationFailureCause(new Error(
    `unclassified writer failure ${secret}`,
  ))).toBe("writer rejected reservation");
});

test("live run capabilities travel on stdin and never enter writer argv", () => {
  const capability = "c".repeat(64);
  const invocation = deliveryWriterInvocation("record", {
    run: "run-lane-123",
    thread: "thread-123",
    reporter: "agent:lane-123",
    capability,
    bar: "tests pass",
    observed: "exit 0",
  }, "7977");
  expect(invocation.argv).toHaveLength(3);
  expect(invocation.argv.join("\0")).not.toContain(capability);
  expect(invocation.stdin).toContain(capability);
});

test("managed MCP environment explicitly carries all run evidence bindings", () => {
  for (const key of ["NORTH_RUN_ID", "NORTH_THREAD_ID", "NORTH_RUN_CAPABILITY"]) {
    expect((MANAGED_NORTH_MCP_ENV_KEYS as readonly string[]).includes(key)).toBe(true);
  }
});

test("evidence loading requires one digest-committed reservation projection", () => {
  const body = conformance.reservationBody;
  expect(body.find(([predicate]) => predicate === "run_reservation_version")?.[1])
    .toBe(RUN_RESERVATION_VERSION);
  const marker = sha256(body.map(([predicate, value]) =>
    `${predicate}\0${value}\n`).join(""));
  expect(marker).toBe(conformance.reservationManifestSha256);
  const facts = [
    ...body.map(([predicate, value]) => ({ predicate, value })),
    { predicate: "run_reservation_manifest_sha256", value: marker },
  ];
  expect(runReservationValid(facts)).toBe(true);
  const workerDefinedBody = body.map(([predicate, value]) => [
    predicate,
    predicate === "run_reservation_contract_origin"
      ? "worker-defined"
      : predicate === "run_reservation_done_when" ? "[]" : value,
  ] as [string, string]);
  const workerDefinedMarker = sha256(workerDefinedBody.map(([predicate, value]) =>
    `${predicate}\0${value}\n`).join(""));
  expect(runReservationValid([
    ...workerDefinedBody.map(([predicate, value]) => ({ predicate, value })),
    {
      predicate: "run_reservation_manifest_sha256",
      value: workerDefinedMarker,
    },
  ])).toBe(true);
  expect(runReservationValid([
    ...facts,
    { predicate: "run_reservation_agent", value: "@agent:competing-lane" },
  ])).toBe(false);
  expect(runReservationValid(facts.map((fact) =>
    fact.predicate === "run_reservation_contract_origin"
      ? { ...fact, value: "worker-defined" }
      : fact))).toBe(false);
  expect(runReservationValid(facts.map((fact) =>
    fact.predicate === "run_reservation_done_when"
      ? { ...fact, value: "[\" tests pass \"]" }
      : fact))).toBe(false);
  expect(runReservationValid(facts.map((fact) =>
    fact.predicate === "run_reserved_at"
      ? { ...fact, value: "2026-01-01T24:00:00Z" }
      : fact))).toBe(false);
});

test("evidence loading invalidates the entire malformed, cross-scoped, duplicate, or over-cap set", () => {
  const body = conformance.reservationBody;
  const marker = sha256(body.map(([predicate, value]) =>
    `${predicate}\0${value}\n`).join(""));
  const reservation = [
    ...body.map(([predicate, value]) => ({ predicate, value })),
    { predicate: "run_reservation_manifest_sha256", value: marker },
  ];
  const record = {
    bar: "smoke → old run",
    observed: "exit 0",
    recordedAt: "2026-07-18T10:00:00Z",
    reporter: "@agent:lane-123",
    run: "@run-load-state",
    thread: "@thread-123",
    version: RUN_BAR_EVIDENCE_VERSION,
  };
  const load = (evidenceValues: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "north-delivery-state-"));
    const command = join(dir, "facts");
    const facts = [
      ...reservation,
      ...evidenceValues.map((value) => ({ predicate: "run_bar_evidence", value })),
    ];
    writeFileSync(
      command,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(1, ${JSON.stringify(JSON.stringify(facts))});\n`,
    );
    chmodSync(command, 0o700);
    try {
      return loadDeliveryRunState("run-load-state", command);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  expect(load([JSON.stringify(record)])).toEqual({
    reservationValid: true,
    evidence: [record],
  });
  expect(load(["{"])).toEqual({ reservationValid: false, evidence: [] });
  expect(load([JSON.stringify({ ...record, reporter: "@agent:other" })]))
    .toEqual({ reservationValid: false, evidence: [] });
  expect(load([
    JSON.stringify(record),
    JSON.stringify({ ...record, recordedAt: "2026-07-18T10:00:01Z" }),
  ])).toEqual({ reservationValid: false, evidence: [] });
  expect(load(Array.from(
    { length: MAX_DELIVERY_BARS + 1 },
    (_, index) => JSON.stringify({ ...record, bar: `probe-${index}` }),
  ))).toEqual({ reservationValid: false, evidence: [] });
  expect(load([" ".repeat(MAX_RUN_BAR_EVIDENCE_RECORD_UTF8_BYTES + 1)]))
    .toEqual({ reservationValid: false, evidence: [] });
});
