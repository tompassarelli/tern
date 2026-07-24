// Persistent-connection fast path for the managed-lane identity PUBLISH write
// (1k-tier cut #1, thread 019f90f5; atomic op adoption, thread 019f9374). The
// admission bottleneck measured in docs/private/admission-benchmark-report.md is
// a fresh bb/JVM cold-start per admission for cli/agent-fact-internal.clj
// `publish`. This module removes that JVM on the common path by speaking the
// coordinator's own EDN wire protocol (cli/coord.clj) directly over TCP from
// TypeScript, under the SAME per-subject write-lease. It is a pure ACCELERATOR:
//
//   - It attempts ONLY a fresh publish whose projection validate-publish! would
//     accept; any other shape returns null so the caller uses the subprocess.
//   - It reports "committed" ONLY after the coordinator acknowledges the marker,
//     exactly as commit-marker! does. Any deviation, timeout, or ambiguity
//     returns null → the caller falls back to cli/agent-fact-internal.clj keyed
//     by the SAME holder + operationId + desired projection, so
//     recover-identity-write! deterministically reconciles any killed markerless
//     prefix (recovered_killed_prefix / exact_replay). The fast path can
//     therefore never double-publish or lose a write; the proven Clojure
//     recovery stays the correctness authority.
//
// PREFERRED PATH — one atomic wire op (1k-tier lever #2, fram :managed-agent-
// publish, promoted 2893706). The whole identity publish (assert-batch of every
// present predicate + manifest marker) is committed server-side in ONE store
// transaction under the canonical per-subject lease, collapsing ~115 serialized
// round-trips per admission to one. When the coordinator does not advertise the
// op ({:error "unknown op"}) the module transparently falls back to the LEGACY
// per-predicate fenced-wire sequence below, so a rollout window with mixed
// coordinator generations keeps accelerating. Marker bytes are identical on both
// paths; a reject on either fails closed to the subprocess.
//
// This introduces no new long-lived process (avoiding the runaway-JVM hazard the
// bench lane observed) and adds no client-side ordering: the coordinator's single
// writer-lease per subject remains the sole serialization authority. The wire
// codec + one-shot request/response transport live in ./coord-wire, shared
// verbatim with the coordinator's own Clojure client (send-envelope).
import { createHash } from "node:crypto";
import type { EdnMap, OpPairs } from "./coord-wire";
import { coordPort, expectedLog, kw, sendManagedAgentPublish, sendOp } from "./coord-wire";
import type { ManagedWriteResult } from "./identity";

// ---------------------------------------------------------------------------
// Predicate vocabulary — MUST stay byte-identical to cli/agent-provenance.clj
// identity-predicates and cli/agent-fact-internal.clj publish/required sets. A
// drift here would let the fast path commit an identity the reader rejects.
// ---------------------------------------------------------------------------
const IDENTITY_PREDICATES = [
  "kind", "role", "model", "provider", "provider_target", "live_input",
  "live_input_state", "live_input_epoch", "effort",
  "composition_kind", "composition_id", "composition_overrides",
  "composition_override_reason", "nearest_preset", "bespoke_reason",
  "promotion_candidate", "composition_contract_sha256",
  "composition_contract_fingerprint_version", "composition_contract_fingerprint_domain",
  "repo", "goal", "worktree", "branch", "coordinator", "spawned_at",
] as const;
const PROJECTION_PREDICATES = ["display_handle", "display_name"] as const;
const PUBLISH_PREDICATES = new Set<string>([...IDENTITY_PREDICATES, ...PROJECTION_PREDICATES]);
// required-identity-predicates in agent-fact-internal.clj is North's required
// set MINUS identity_manifest_sha256 (the marker is written last, not supplied).
const REQUIRED_PUBLISH_PREDICATES = [
  "kind", "role", "goal", "provider", "provider_target", "live_input",
  "live_input_state", "live_input_epoch", "model", "effort",
  "composition_kind", "composition_id", "repo", "spawned_at", "display_handle",
  "display_name",
];
const MARKER_PREDICATE = "identity_manifest_sha256";
const TERMINAL_MARKER_PREDICATE = "terminal_manifest_sha256";
// Terminal bodies must be absent for a clean fresh publish; presence forces fallback.
const TERMINAL_PREDICATES = [
  "outcome", "process_outcome", "delivery_outcome", "delivery_reason",
  "delivery_evidence", "delivery_evidence_sha256",
  "delivery_attestation", "delivery_attestation_sha256",
];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Mirror cli/terminal-projection.clj valid-agent-entity? — the canonical entity
// string whose bytes feed both the write-lease digest and every te on the wire.
const AGENT_ENTITY = /^@agent:[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Port of cli/agent-fact-internal.clj `entity`: strip a leading `@agent:`/`agent:`
 * and re-prefix `@agent:`, then require the canonical shape. The subprocess
 * normalizes its subject argument this way, and BOTH the write-lease resource
 * and every `te` derive from the normalized form — so the fast path must use the
 * identical string or it would take a different lease and write to a different
 * entity than the reader/subprocess. Returns null (→ fallback) on any id the
 * subprocess would reject.
 */
export function normalizeAgentEntity(subject: string): string | null {
  const raw = subject.replace(/^@?agent:/, "");
  const canonical = `@agent:${raw}`;
  return AGENT_ENTITY.test(canonical) ? canonical : null;
}

/** Marker: present identity predicates, sorted, joined `pred\u0000value\n`,
 * sha256 — MUST match cli/agent-fact-internal.clj `canonical` over
 * (select-keys facts identity-predicates); NUL is load-bearing. */
export function identityMarker(projection: Record<string, string>): string {
  const canonical = IDENTITY_PREDICATES
    .filter((p) => projection[p] !== undefined && projection[p] !== "")
    .slice()
    .sort()
    .map((p) => `${p}\u0000${projection[p]}\n`)
    .join("");
  return sha256Hex(canonical);
}

/** managed-agent-write:<sha256(entity)> — the coordinator write-lease resource,
 * computed over the NORMALIZED @agent: entity exactly like write-lease-resource. */
export function writeLeaseResource(entity: string): string {
  return `managed-agent-write:${sha256Hex(entity)}`;
}

/**
 * Port of cli/agent-fact-internal.clj validate-publish!. Returns true only for a
 * projection the subprocess would accept, so the fast path never commits an
 * identity the reader would reject. Any false → the caller uses the subprocess,
 * which reproduces the canonical rejection error.
 */
export function validPublishProjection(projection: Record<string, string>): boolean {
  for (const key of Object.keys(projection)) {
    if (!PUBLISH_PREDICATES.has(key)) return false;
  }
  for (const req of REQUIRED_PUBLISH_PREDICATES) {
    const v = projection[req];
    if (v === undefined || v === "") return false;
  }
  if (projection.kind !== "lane") return false;
  if (projection.live_input !== "streaming" && projection.live_input !== "unsupported") return false;
  if (!["pending", "armed", "frozen"].includes(projection.live_input_state)) return false;
  if (!UUID_V4.test(projection.live_input_epoch)) return false;
  if (projection.live_input === "unsupported" && projection.live_input_state !== "frozen") return false;
  if (projection.role !== projection.composition_id) return false;
  const bespokeOnly = [
    "bespoke_reason", "promotion_candidate", "composition_contract_sha256",
    "composition_contract_fingerprint_version", "composition_contract_fingerprint_domain",
  ];
  if (projection.composition_kind === "preset") {
    if (!("composition_overrides" in projection)) return false;
    if (bespokeOnly.some((p) => p in projection)) return false;
  } else if (projection.composition_kind === "bespoke") {
    if (bespokeOnly.some((p) => !(p in projection))) return false;
    if (!["true", "false"].includes(projection.promotion_candidate)) return false;
    if (!SHA256_HEX.test(projection.composition_contract_sha256)) return false;
    if (projection.composition_contract_fingerprint_version !== "v1") return false;
    if (projection.composition_contract_fingerprint_domain !== "north:bespoke-contract:v1") return false;
  } else {
    return false;
  }
  return true;
}

function rejected(m: EdnMap): boolean {
  return m[":reject"] !== undefined && m[":reject"] !== null;
}

interface Lease { resource: string; holder: string; epoch: number; }

// Guard predicates for the atomic op's clean-fresh gate. IDENTITY_PREDICATES
// already feed the manifest (so the server verifies each present/absent), and
// the projection facts carry display_handle/display_name; these are the terminal
// bodies + terminal marker whose presence must force publish-conflict, byte-for-
// byte the clean-fresh gate the legacy path applies below.
const ATOMIC_GUARD_PREDICATES = [
  ...PROJECTION_PREDICATES, TERMINAL_MARKER_PREDICATE, ...TERMINAL_PREDICATES,
];

/**
 * Attempt the ONE atomic :managed-agent-publish op. Returns:
 *   - true         → committed (fresh publish or byte-identical idempotent replay)
 *   - false        → the coordinator refused this shape; fail closed to subprocess
 *   - "unsupported"→ the coordinator does not advertise the op; use the legacy wire
 * NEVER throws.
 */
async function atomicPublish(
  entity: string,
  projection: Record<string, string>,
  holder: string,
  port: number,
  log: string,
  deadline: number,
): Promise<boolean | "unsupported"> {
  const marker = identityMarker(projection);
  try {
    const r = await sendManagedAgentPublish(port, log, {
      entity,
      facts: Object.entries(projection),
      identityPreds: IDENTITY_PREDICATES,
      guardPreds: ATOMIC_GUARD_PREDICATES,
      marker,
      holder,
      ttlMs: 60_000,
    }, deadline);
    // A pre-op coordinator generation routes an unknown verb to its default arm.
    if (r[":error"] === "unknown op") return "unsupported";
    // Success ONLY on the acknowledged fenced-publish carrying our exact marker
    // and normalized subject; every reject (:held, :publish-conflict,
    // :manifest-mismatch, …) and any surprising shape fails closed to the
    // subprocess so recover-identity-write! owns the reused/partial case.
    return Boolean(r[":ok"]) && r[":fenced-publish"] === true
      && r[":te"] === entity && r[":marker"] === marker;
  } catch {
    return false;
  }
}

/**
 * Attempt a fresh managed publish over the wire. Returns a committed result, or
 * null to signal the caller should use the subprocess path. NEVER returns a
 * non-committed result and NEVER throws: on any failure it fails closed to the
 * fallback.
 */
export async function fastPublish(
  subject: string,
  projection: Record<string, string>,
  holder: string,
  operationId: string,
  timeoutMs: number,
): Promise<ManagedWriteResult | null> {
  if (process.env.NORTH_MANAGED_WRITER_FASTPATH === "0") return null;
  if (process.env.NORTH_IDENTITY_TEST_REDIRECT === "1") return null;
  if (!validPublishProjection(projection)) return null;
  const entity = normalizeAgentEntity(subject);
  if (entity === null) return null;

  const port = coordPort();
  const log = expectedLog();
  const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));

  // Preferred: one atomic server-side fenced publish. Fall back to the legacy
  // per-predicate wire sequence only when the coordinator lacks the op.
  const atomic = await atomicPublish(entity, projection, holder, port, log, deadline);
  if (atomic === "unsupported") {
    return legacyWirePublish(entity, projection, holder, operationId, port, log, deadline);
  }
  return atomic ? { status: "committed", operationId } : null;
}

/**
 * Legacy accelerator: the ~115 sequential per-predicate fenced writes, retained
 * verbatim for coordinators that predate :managed-agent-publish. Same contract
 * as fastPublish — committed result or null (fail closed to the subprocess).
 */
async function legacyWirePublish(
  entity: string,
  projection: Record<string, string>,
  holder: string,
  operationId: string,
  port: number,
  log: string,
  deadline: number,
): Promise<ManagedWriteResult | null> {
  const resource = writeLeaseResource(entity);
  const op = (...pairs: OpPairs): OpPairs => pairs;
  const send = (o: OpPairs) => sendOp(port, log, o, deadline);
  const resolvedValues = async (p: string): Promise<unknown[]> => {
    const r = await send(op([kw("op"), kw("resolved")], [kw("te"), entity], [kw("p"), p]));
    const values = r[":values"];
    return Array.isArray(values) ? values : [];
  };

  let lease: Lease | null = null;
  try {
    // Acquire the SAME per-subject write-lease the subprocess uses (60s TTL >
    // the 10s writer budget, per acquire-write-lease!). Publish never waits on a
    // held lease — a held lease means a concurrent writer owns this subject, so
    // we fall back rather than race it.
    const acq = await send(op(
      [kw("op"), kw("acquire-lease")],
      [kw("res"), resource],
      [kw("holder"), holder],
      [kw("ttl-ms"), 60_000],
    ));
    if (!acq[":ok"] || typeof acq[":epoch"] !== "number") return null;
    lease = { resource, holder, epoch: acq[":epoch"] as number };

    // Clean-fresh gate: any existing managed body/marker/terminal → fall back so
    // recover-identity-write! owns the reused/partial case (fresh? in publish!).
    for (const p of [...PUBLISH_PREDICATES, MARKER_PREDICATE, TERMINAL_MARKER_PREDICATE, ...TERMINAL_PREDICATES]) {
      if ((await resolvedValues(p)).length > 0) return null;
    }

    const fence = (): OpPairs => [
      [kw("res"), resource], [kw("holder"), holder], [kw("epoch"), lease!.epoch],
    ];
    // Write every projection fact under the fence (put-facts!).
    for (const [p, value] of Object.entries(projection)) {
      const put = await send([[kw("op"), kw("assert-with-fence")], ...fence(), [kw("te"), entity], [kw("p"), p], [kw("r"), value]]);
      if (rejected(put)) return null;
    }
    // Verify the exact publish projection read back (verify-exact! publish-predicates).
    for (const p of PUBLISH_PREDICATES) {
      const values = await resolvedValues(p);
      const want = projection[p];
      if (want !== undefined && want !== "") {
        if (values.length !== 1 || values[0] !== want) return null;
      } else if (values.length !== 0) return null;
    }
    // Commit the marker last (commit-marker!): confirm no competing marker, put
    // it under the fence, then confirm the marker AND identity readback exactly.
    const marker = identityMarker(projection);
    const existingMarker = await resolvedValues(MARKER_PREDICATE);
    if (existingMarker.length > 0 && !(existingMarker.length === 1 && existingMarker[0] === marker)) return null;
    const putMarker = await send([[kw("op"), kw("assert-with-fence")], ...fence(), [kw("te"), entity], [kw("p"), MARKER_PREDICATE], [kw("r"), marker]]);
    if (rejected(putMarker)) return null;
    const markerBack = await resolvedValues(MARKER_PREDICATE);
    if (markerBack.length !== 1 || markerBack[0] !== marker) return null;
    // Re-verify the identity projection is still exact under the committed marker.
    for (const p of IDENTITY_PREDICATES) {
      const values = await resolvedValues(p);
      const want = projection[p];
      if (want !== undefined && want !== "") {
        if (values.length !== 1 || values[0] !== want) return null;
      } else if (values.length !== 0) return null;
    }
    return { status: "committed", operationId };
  } catch {
    // Any transport/parse/timeout failure fails closed to the subprocess.
    return null;
  } finally {
    if (lease) {
      // Advisory release so the fallback (or a successor) can re-acquire a fresh
      // epoch immediately; on success the marker is already durable.
      try {
        await sendOp(port, log, op(
          [kw("op"), kw("release-lease")],
          [kw("res"), lease.resource],
          [kw("holder"), lease.holder],
          [kw("epoch"), lease.epoch],
        ), Date.now() + 1000);
      } catch { /* expiry recovers the lease */ }
    }
  }
}
