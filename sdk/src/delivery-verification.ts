import { createHash } from "node:crypto";
import type { Fact } from "./north-client";

export const DELIVERY_EVIDENCE_VERSION = "north:done-bars:v2";
export const RUN_BAR_EVIDENCE_VERSION = "north:run-bar-evidence:v1";
export const DELIVERY_ATTESTATION_VERSION = "north:delivery-attestation:v1";
export const DELIVERY_ATTESTATION_AUTHORITY = "managed-independent-verifier";
export const MAX_DELIVERY_BARS = 32;
export const MAX_DELIVERY_BAR_UTF8_BYTES = 512;
export const MAX_DELIVERY_OBSERVED_UTF8_BYTES = 2048;
export const MAX_DELIVERY_ENVELOPE_UTF8_BYTES = 256 * 1024;
export const MAX_RUN_BAR_EVIDENCE_RECORD_UTF8_BYTES = 16 * 1024;
export const MAX_RUN_RESERVATION_BASELINE_UTF8_BYTES = 64 * 1024;
export const MAX_DELIVERY_WRITER_REQUEST_UTF8_BYTES = 16 * 1024;
export const MAX_DELIVERY_THREAD_ID_UTF8_BYTES = 512;
export const MAX_DELIVERY_RUN_ID_UTF8_BYTES = 512;
export const MAX_DELIVERY_AGENT_ID_UTF8_BYTES = 256;
export const MAX_DELIVERY_ATTESTATION_UTF8_BYTES = 16 * 1024;

export interface RunBarEvidence {
  version: typeof RUN_BAR_EVIDENCE_VERSION;
  run: string;
  thread: string;
  reporter: string;
  bar: string;
  observed: string;
  recordedAt: string;
}

export interface DeliveryEvidenceMatch {
  bar: string;
  evidence: RunBarEvidence[];
}

export interface DeliveryEvidenceSnapshot {
  version: typeof DELIVERY_EVIDENCE_VERSION;
  run: string;
  thread: string;
  reporter: string;
  contractOrigin: "accepted" | "worker-defined";
  baselineDoneWhen: string[];
  doneWhen: string[];
  matches: DeliveryEvidenceMatch[];
}

export interface DeliveryAttestation {
  version: typeof DELIVERY_ATTESTATION_VERSION;
  target: string;
  run: string;
  thread: string;
  evidenceSha256: string;
  actor: string;
  role: "verifier" | "judge";
  authority: typeof DELIVERY_ATTESTATION_AUTHORITY;
  attestedAt: string;
}

export interface DeliveryProof {
  deliveryEvidence: string;
  deliveryEvidenceSha256: string;
  deliveryAttestation?: string;
  deliveryAttestationSha256?: string;
}

export type DeliveryAssessment =
  | {
      deliveryOutcome: "unverified";
      deliveryReason:
        | "delivery_thread_unavailable_at_finalize"
        | "delivery_reservation_unavailable_at_finalize"
        | "delivery_contract_missing"
        | "delivery_contract_exceeds_evidence_limits"
        | "delivery_contract_changed_during_run"
        | "delivery_bar_evidence_incomplete"
        | "delivery_bar_evidence_ambiguous"
        | "terminal_run_publication_unverified";
    }
  | {
      deliveryOutcome: "reported";
      deliveryReason: "complete_run_scoped_done_bar_evidence_self_reported";
      proof: DeliveryProof;
    };

const lexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const utf8ByteCount = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export function validUnicodeScalars(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function canonicalEvidenceText(value: unknown): string | undefined {
  if (!validUnicodeScalars(value) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return undefined;
  }
  const canonical = value.replace(/^ +| +$/g, "");
  return canonical.length ? canonical : undefined;
}

export const boundedNonblankText = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string"
  && canonicalEvidenceText(value) === value
  && utf8ByteCount(value) <= maxBytes;

export function canonicalDoneBars(values: readonly unknown[]): string[] | undefined {
  if (values.length > MAX_DELIVERY_BARS) return undefined;
  const canonical = values.map(canonicalEvidenceText);
  if (canonical.some((value) => value === undefined)) return undefined;
  return [...new Set(canonical as string[])].sort(lexical);
}

export const boundedDoneBars = (
  values: unknown,
  allowEmpty: boolean,
): values is string[] =>
  Array.isArray(values)
  && (allowEmpty || values.length > 0)
  && values.length <= MAX_DELIVERY_BARS
  && values.every((value) =>
    boundedNonblankText(value, MAX_DELIVERY_BAR_UTF8_BYTES))
  && sameStrings(values, [...new Set(values)].sort(lexical));

export function validThreadEntity(value: unknown): value is string {
  if (!validUnicodeScalars(value)
    || utf8ByteCount(value) > MAX_DELIVERY_THREAD_ID_UTF8_BYTES
    || !value.startsWith("@") || value.length === 1) return false;
  for (const character of value.slice(1)) {
    const codePoint = character.codePointAt(0)!;
    if (character === "@"
      || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x20 || codePoint === 0xa0 || codePoint === 0x1680
      || (codePoint >= 0x2000 && codePoint <= 0x200a)
      || codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0x202f
      || codePoint === 0x205f || codePoint === 0x3000 || codePoint === 0xfeff) {
      return false;
    }
  }
  return true;
}

export function validRunEntity(value: unknown): value is string {
  return typeof value === "string"
    && utf8ByteCount(value) <= MAX_DELIVERY_RUN_ID_UTF8_BYTES
    && /^@run[-:][A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export function validAgentEntity(value: unknown): value is string {
  return typeof value === "string"
    && utf8ByteCount(value) <= MAX_DELIVERY_AGENT_ID_UTF8_BYTES
    && /^@agent:[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Strict RFC-3339 UTC instant subset shared with the Clojure reader. Date.parse
 * normalizes impossible calendar dates (for example February 30), so the
 * calendar is checked explicitly instead of treating parser permissiveness as
 * proof syntax.
 */
export function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = instantPattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function evidenceReportsBar(bar: string, evidence: string): boolean {
  const expected = bar.trim();
  const observed = evidence.trim();
  if (!expected || !observed.startsWith(expected)) return false;
  return /^\s*→\s*\S/.test(observed.slice(expected.length));
}

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(lexical);
  const wanted = [...expected].sort(lexical);
  return sameStrings(actual, wanted);
};

export function parseRunBarEvidence(raw: string): RunBarEvidence | undefined {
  try {
    if (!validUnicodeScalars(raw)
      || utf8ByteCount(raw) > MAX_RUN_BAR_EVIDENCE_RECORD_UTF8_BYTES) return undefined;
    return validateRunBarEvidence(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function validateRunBarEvidence(value: unknown): RunBarEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = value as Partial<RunBarEvidence>;
  if (!exactKeys(parsed, [
    "bar", "observed", "recordedAt", "reporter", "run", "thread", "version",
  ])) return undefined;
  if (parsed.version !== RUN_BAR_EVIDENCE_VERSION
    || !validRunEntity(parsed.run)
    || !validThreadEntity(parsed.thread)
    || !validAgentEntity(parsed.reporter)
    || !boundedNonblankText(parsed.bar, MAX_DELIVERY_BAR_UTF8_BYTES)
    || !boundedNonblankText(parsed.observed, MAX_DELIVERY_OBSERVED_UTF8_BYTES)
    || !validInstant(parsed.recordedAt)) return undefined;
  return parsed as RunBarEvidence;
}

export function assessThreadDelivery(
  threadId: string,
  reporterAgentId: string,
  facts: readonly Fact[],
  baselineFacts: readonly Fact[] = [],
  runId = `run:${reporterAgentId.replace(/^@?agent:/, "")}`,
  runEvidence: readonly RunBarEvidence[] = [],
): DeliveryAssessment {
  if (!facts.length) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_thread_unavailable_at_finalize",
    };
  }

  const baselineDoneWhen = canonicalDoneBars(
    baselineFacts.filter(({ predicate }) => predicate === "done_when").map(({ value }) => value),
  );
  const doneWhen = canonicalDoneBars(
    facts.filter(({ predicate }) => predicate === "done_when").map(({ value }) => value),
  );
  if (!baselineDoneWhen || !doneWhen
    || !boundedDoneBars(baselineDoneWhen, true)
    || !boundedDoneBars(doneWhen, true)) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_contract_exceeds_evidence_limits",
    };
  }
  if (!doneWhen.length) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_contract_missing",
    };
  }

  const contractOrigin = baselineDoneWhen.length ? "accepted" : "worker-defined";
  if (contractOrigin === "accepted" && !sameStrings(baselineDoneWhen, doneWhen)) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_contract_changed_during_run",
    };
  }

  const run = `@${runId.replace(/^@/, "")}`;
  const thread = `@${threadId.replace(/^@/, "")}`;
  const reporter = `@agent:${reporterAgentId.replace(/^@?agent:/, "")}`;
  const parsedEvidence = runEvidence.map(validateRunBarEvidence);
  const invalidEvidenceSet = runEvidence.length > MAX_DELIVERY_BARS
    || parsedEvidence.some((candidate) =>
      !candidate
      || candidate.run !== run
      || candidate.thread !== thread
      || candidate.reporter !== reporter
      || !doneWhen.includes(candidate.bar))
    || new Set(parsedEvidence.map((candidate) => candidate?.bar)).size !== parsedEvidence.length;
  if (invalidEvidenceSet) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_bar_evidence_ambiguous",
    };
  }
  const eligible = parsedEvidence as RunBarEvidence[];
  const matches = doneWhen.map((bar) => ({
    bar,
    evidence: eligible
      .filter((candidate) => candidate.bar === bar)
      .sort((left, right) => lexical(JSON.stringify(left), JSON.stringify(right))),
  }));
  if (matches.some(({ evidence }) => evidence.length === 0)) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_bar_evidence_incomplete",
    };
  }
  if (matches.some(({ evidence }) => evidence.length !== 1)) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_bar_evidence_ambiguous",
    };
  }

  const snapshot: DeliveryEvidenceSnapshot = {
    version: DELIVERY_EVIDENCE_VERSION,
    run,
    thread,
    reporter,
    contractOrigin,
    baselineDoneWhen,
    doneWhen,
    matches,
  };
  const deliveryEvidence = JSON.stringify(snapshot);
  if (utf8ByteCount(deliveryEvidence) > MAX_DELIVERY_ENVELOPE_UTF8_BYTES) {
    return {
      deliveryOutcome: "unverified",
      deliveryReason: "delivery_contract_exceeds_evidence_limits",
    };
  }
  return {
    deliveryOutcome: "reported",
    deliveryReason: "complete_run_scoped_done_bar_evidence_self_reported",
    proof: {
      deliveryEvidence,
      deliveryEvidenceSha256: sha256(deliveryEvidence),
    },
  };
}

export function parseDeliveryEvidence(raw: string): DeliveryEvidenceSnapshot | undefined {
  try {
    if (utf8ByteCount(raw) > MAX_DELIVERY_ENVELOPE_UTF8_BYTES) return undefined;
    const parsed = JSON.parse(raw) as Partial<DeliveryEvidenceSnapshot>;
    const requiredKeys = [
      "baselineDoneWhen", "contractOrigin", "doneWhen", "matches",
      "reporter", "run", "thread", "version",
    ];
    if (!exactKeys(parsed, requiredKeys)) return undefined;
    if (parsed.version !== DELIVERY_EVIDENCE_VERSION
      || !validRunEntity(parsed.run)
      || !validThreadEntity(parsed.thread)
      || !validAgentEntity(parsed.reporter)
      || (parsed.contractOrigin !== "accepted" && parsed.contractOrigin !== "worker-defined")
      || !boundedDoneBars(parsed.baselineDoneWhen, true)
      || !boundedDoneBars(parsed.doneWhen, false)
      || !Array.isArray(parsed.matches) || parsed.matches.length !== parsed.doneWhen.length) {
      return undefined;
    }
    const baselineDoneWhen = parsed.baselineDoneWhen;
    const bars = parsed.doneWhen;
    if ((parsed.contractOrigin === "accepted"
        ? baselineDoneWhen.length === 0 || !sameStrings(baselineDoneWhen, bars)
        : baselineDoneWhen.length !== 0)) return undefined;
    for (let index = 0; index < bars.length; index++) {
      const match = parsed.matches[index];
      if (!match || !exactKeys(match, ["bar", "evidence"])
        || match.bar !== bars[index] || !Array.isArray(match.evidence)
        || match.evidence.length !== 1) return undefined;
      for (const candidate of match.evidence) {
        const evidence = validateRunBarEvidence(candidate);
        if (!evidence
          || evidence.bar !== bars[index]
          || evidence.run !== parsed.run
          || evidence.thread !== parsed.thread
          || evidence.reporter !== parsed.reporter) return undefined;
      }
    }
    return parsed as DeliveryEvidenceSnapshot;
  } catch {
    return undefined;
  }
}

export function parseDeliveryAttestation(raw: string): DeliveryAttestation | undefined {
  try {
    if (!validUnicodeScalars(raw)
      || utf8ByteCount(raw) > MAX_DELIVERY_ATTESTATION_UTF8_BYTES) return undefined;
    const parsed = JSON.parse(raw) as Partial<DeliveryAttestation>;
    if (!exactKeys(parsed, [
      "actor", "attestedAt", "authority", "evidenceSha256", "role",
      "run", "target", "thread", "version",
    ])) return undefined;
    if (parsed.version !== DELIVERY_ATTESTATION_VERSION
      || parsed.authority !== DELIVERY_ATTESTATION_AUTHORITY
      || !validAgentEntity(parsed.target)
      || !validRunEntity(parsed.run)
      || !validThreadEntity(parsed.thread)
      || typeof parsed.evidenceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.evidenceSha256)
      || !validAgentEntity(parsed.actor)
      || (parsed.role !== "verifier" && parsed.role !== "judge")
      || !validInstant(parsed.attestedAt)) return undefined;
    return parsed as DeliveryAttestation;
  } catch {
    return undefined;
  }
}

export function deliveryProofValid(
  outcome: string,
  reason: string,
  proof?: DeliveryProof,
): boolean {
  if (outcome === "blocked" || outcome === "unverified") return proof === undefined;
  if (!proof?.deliveryEvidence || !proof.deliveryEvidenceSha256
    || sha256(proof.deliveryEvidence) !== proof.deliveryEvidenceSha256
    || !parseDeliveryEvidence(proof.deliveryEvidence)) return false;
  if (outcome === "reported") {
    return reason === "complete_run_scoped_done_bar_evidence_self_reported"
      && proof.deliveryAttestation === undefined
      && proof.deliveryAttestationSha256 === undefined;
  }
  // North currently runs all managed lanes under one OS uid. AGENT_ID is
  // therefore provenance, not an unforgeable second-lane capability. Historical
  // attestation envelopes remain parseable for display, but no current proof can
  // mechanically claim or promote "verified" across that boundary.
  return false;
}
