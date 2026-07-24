import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  boundedDoneBars, canonicalDoneBars, MAX_DELIVERY_BARS,
  MAX_DELIVERY_WRITER_REQUEST_UTF8_BYTES,
  MAX_RUN_RESERVATION_BASELINE_UTF8_BYTES,
  parseRunBarEvidence, sha256, utf8ByteCount, validInstant,
  validAgentEntity, validRunEntity, validThreadEntity, validUnicodeScalars,
  type RunBarEvidence,
} from "./delivery-verification";

const REPO = resolve(import.meta.dir, "..", "..");
const WRITER = resolve(REPO, "cli", "delivery-evidence-internal.clj");
export const RUN_RESERVATION_VERSION = "north:run-reservation:v1";
const RUN_RESERVATION_BODY = [
  "run_capability_sha256",
  "run_reservation_agent",
  "run_reservation_contract_origin",
  "run_reservation_done_when",
  "run_reservation_thread",
  "run_reservation_version",
  "run_reserved_at",
] as const;

export interface DeliveryRunContext {
  runId: string;
  threadId: string;
  reporterAgentId: string;
  capability: string;
}

export interface DeliveryReservation {
  contractOrigin: "accepted" | "worker-defined";
  baselineDoneWhen: string[];
}

export interface DeliveryRunState {
  reservationValid: boolean;
  evidence: RunBarEvidence[];
}

export function newDeliveryRunContext(
  runId: string,
  threadId: string,
  reporterAgentId: string,
  capability = randomBytes(32).toString("hex"),
): DeliveryRunContext {
  const normalizedRun = runId.replace(/^@/, "");
  const normalizedThread = threadId.replace(/^@/, "");
  const normalizedAgent = reporterAgentId.replace(/^@?agent:/, "");
  if (!validRunEntity(`@${normalizedRun}`)) throw new Error("invalid delivery run id");
  if (!validThreadEntity(`@${normalizedThread}`)) throw new Error("invalid delivery thread id");
  if (!validAgentEntity(`@agent:${normalizedAgent}`)) {
    throw new Error("invalid delivery reporter id");
  }
  if (!/^[0-9a-f]{64}$/.test(capability)) throw new Error("invalid delivery run capability");
  return {
    runId: normalizedRun,
    threadId: normalizedThread,
    reporterAgentId: normalizedAgent,
    capability,
  };
}

function invokeWriter(
  operation: "reserve" | "record",
  request: Record<string, string>,
  port = process.env.NORTH_PORT ?? "7977",
): string {
  const invocation = deliveryWriterInvocation(operation, request, port);
  try {
    return execFileSync("bb", invocation.argv, {
      encoding: "utf8",
      input: invocation.stdin,
      stdio: ["pipe", "pipe", "pipe"],
      // Reservation publication owns a 5s monotonic retry window in coord.clj.
      // Keep subprocess boundary longer so writer can report its semantic cause.
      timeout: 10_000,
    }).trim();
  } catch (error) {
    // Preserve only the writer's bounded semantic Message line. Even though the
    // live capability now travels on stdin rather than argv, subprocess errors
    // remain an inappropriate place to reflect the request body.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const reason = stderr.match(/^Message:\s+(.+)$/m)?.[1]?.trim();
    throw new Error(`delivery evidence ${operation} rejected${reason ? `: ${reason}` : ""}`);
  }
}

export function deliveryReservationFailureCause(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("delivery evidence publication deadline exceeded")) {
    return "publication deadline exceeded";
  }
  if (message.includes("run subject is not fresh")
    || message.includes("run reservation projection changed before commit")
    || message.includes("run reservation lost singleton/freshness race")) {
    return "reservation conflict";
  }
  if (message === "delivery evidence reserve returned a malformed acknowledgement") {
    return "malformed acknowledgement";
  }
  if (message === "delivery evidence reserve returned an invalid acknowledgement") {
    return "invalid acknowledgement";
  }
  if (message === "reservation acknowledgement unavailable") {
    return "acknowledgement unavailable";
  }
  if (message.includes("coordinator rejected delivery evidence write")) {
    return "coordinator rejected write";
  }
  return "writer rejected reservation";
}

/** @internal Pure subprocess boundary used by the writer and its secrecy test. */
export function deliveryWriterInvocation(
  operation: "reserve" | "record",
  request: Record<string, string>,
  port: string,
): { argv: string[]; stdin: string } {
  const serialized = JSON.stringify(request);
  if (!validUnicodeScalars(serialized)
    || utf8ByteCount(serialized) > MAX_DELIVERY_WRITER_REQUEST_UTF8_BYTES) {
    throw new Error(`delivery evidence ${operation} rejected: request exceeds evidence limits`);
  }
  return { argv: [WRITER, port, operation], stdin: serialized };
}

export function reserveDeliveryRun(context: DeliveryRunContext): DeliveryReservation {
  const raw = invokeWriter("reserve", {
    run: context.runId,
    thread: context.threadId,
    reporter: `agent:${context.reporterAgentId}`,
    capabilitySha256: sha256(context.capability),
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("delivery evidence reserve returned a malformed acknowledgement");
  }
  const baseline = parsed.baselineDoneWhen;
  const normalizedBaseline = Array.isArray(baseline)
    ? canonicalDoneBars(baseline)
    : undefined;
  const expectedKeys = [
    "baselineDoneWhen", "contractOrigin", "ok", "reporter", "run", "thread",
  ];
  if (Object.keys(parsed).sort().join("\0") !== expectedKeys.sort().join("\0")
    || parsed.ok !== true
    || parsed.run !== `@${context.runId}`
    || parsed.thread !== `@${context.threadId}`
    || parsed.reporter !== `@agent:${context.reporterAgentId}`
    || (parsed.contractOrigin !== "accepted" && parsed.contractOrigin !== "worker-defined")
    || !normalizedBaseline
    || !boundedDoneBars(normalizedBaseline, true)
    || JSON.stringify(baseline) !== JSON.stringify(normalizedBaseline)
    || (parsed.contractOrigin === "accepted"
      ? normalizedBaseline.length === 0
      : normalizedBaseline.length !== 0)) {
    throw new Error("delivery evidence reserve returned an invalid acknowledgement");
  }
  return {
    contractOrigin: parsed.contractOrigin,
    baselineDoneWhen: normalizedBaseline,
  };
}

export function deliveryRunEnvironment(context: DeliveryRunContext): Record<string, string> {
  return {
    NORTH_RUN_ID: context.runId,
    NORTH_THREAD_ID: context.threadId,
    NORTH_RUN_CAPABILITY: context.capability,
  };
}

export function loadDeliveryRunState(
  runId: string,
  command = process.env.NORTH_BIN ?? "north",
): DeliveryRunState {
  try {
    const raw = execFileSync(command, ["json", "show", runId.replace(/^@/, "")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    const facts = JSON.parse(raw) as Array<{ predicate?: unknown; value?: unknown }>;
    if (!runReservationValid(facts)) {
      return { reservationValid: false, evidence: [] };
    }
    const one = (predicate: string): string | undefined => {
      const values = facts
        .filter((fact) => fact.predicate === predicate)
        .map((fact) => fact.value);
      return values.length === 1 && typeof values[0] === "string"
        ? values[0]
        : undefined;
    };
    const run = `@${runId.replace(/^@/, "")}`;
    const thread = one("run_reservation_thread");
    const reporter = one("run_reservation_agent");
    const rawEvidence = facts
      .filter((fact) => fact.predicate === "run_bar_evidence")
      .map((fact) => fact.value);
    if (!thread || !reporter || rawEvidence.length > MAX_DELIVERY_BARS
      || rawEvidence.some((value) => typeof value !== "string")) {
      return { reservationValid: false, evidence: [] };
    }
    const evidence = (rawEvidence as string[]).map(parseRunBarEvidence);
    if (evidence.some((record) =>
      !record
      || record.run !== run
      || record.thread !== thread
      || record.reporter !== reporter)
      || new Set(evidence.map((record) => record?.bar)).size !== evidence.length) {
      return { reservationValid: false, evidence: [] };
    }
    return { reservationValid: true, evidence: evidence as RunBarEvidence[] };
  } catch {
    return { reservationValid: false, evidence: [] };
  }
}

export function loadRunBarEvidence(
  runId: string,
  command = process.env.NORTH_BIN ?? "north",
): RunBarEvidence[] {
  return loadDeliveryRunState(runId, command).evidence;
}

export function runReservationValid(
  facts: readonly { predicate?: unknown; value?: unknown }[],
): boolean {
  const singleton = (predicate: string): string | undefined => {
    const values = facts
      .filter((fact) => fact.predicate === predicate)
      .map((fact) => fact.value);
    return values.length === 1 && typeof values[0] === "string" && values[0].length
      ? values[0]
      : undefined;
  };
  const projection = RUN_RESERVATION_BODY.map(
    (predicate) => [predicate, singleton(predicate)] as const,
  );
  if (projection.some(([, value]) => value === undefined)) return false;
  const marker = singleton("run_reservation_manifest_sha256");
  const body = Object.fromEntries(projection) as Record<
    typeof RUN_RESERVATION_BODY[number],
    string
  >;
  let baseline: unknown;
  if (!validUnicodeScalars(body.run_reservation_done_when)
    || utf8ByteCount(body.run_reservation_done_when)
      > MAX_RUN_RESERVATION_BASELINE_UTF8_BYTES) return false;
  try {
    baseline = JSON.parse(body.run_reservation_done_when);
  } catch {
    return false;
  }
  const normalizedBaseline = Array.isArray(baseline)
    ? canonicalDoneBars(baseline)
    : undefined;
  if (!marker
    || body.run_reservation_version !== RUN_RESERVATION_VERSION
    || !validAgentEntity(body.run_reservation_agent)
    || !validThreadEntity(body.run_reservation_thread)
    || !/^[0-9a-f]{64}$/.test(body.run_capability_sha256)
    || (body.run_reservation_contract_origin !== "accepted"
      && body.run_reservation_contract_origin !== "worker-defined")
    || !normalizedBaseline
    || !boundedDoneBars(normalizedBaseline, true)
    || JSON.stringify(baseline) !== JSON.stringify(normalizedBaseline)
    || (body.run_reservation_contract_origin === "accepted"
      ? normalizedBaseline.length === 0
      : normalizedBaseline.length !== 0)
    || !validInstant(body.run_reserved_at)) return false;
  const canonical = projection
    .map(([predicate, value]) => `${predicate}\0${value}\n`)
    .join("");
  return marker === sha256(canonical);
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): DeliveryRunContext {
  return newDeliveryRunContext(
    env.NORTH_RUN_ID ?? "",
    env.NORTH_THREAD_ID ?? "",
    env.AGENT_ID ?? "",
    env.NORTH_RUN_CAPABILITY ?? "",
  );
}

export function recordRunBarEvidence(
  bar: string,
  observed: string,
  env: NodeJS.ProcessEnv = process.env,
): RunBarEvidence {
  const context = contextFromEnv(env);
  const raw = invokeWriter("record", {
    run: context.runId,
    thread: context.threadId,
    reporter: `agent:${context.reporterAgentId}`,
    capability: context.capability,
    bar,
    observed,
  }, env.NORTH_PORT ?? "7977");
  const parsed = parseRunBarEvidence(raw);
  if (!parsed) throw new Error("delivery evidence writer returned a malformed record");
  return parsed;
}

if (import.meta.main) {
  const [verb, bar, observed, ...extra] = process.argv.slice(2);
  if (verb !== "record" || !bar || !observed || extra.length) {
    console.error("usage: north evidence record \"<exact done_when>\" \"<observed result>\"");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(recordRunBarEvidence(bar, observed)));
  } catch (error) {
    console.error(`north evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
