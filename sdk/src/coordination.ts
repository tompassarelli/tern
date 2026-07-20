// Durable real-time coordination for managed SDK agents.
//
// One long-lived North feed process arms the coordinator subscription before it
// replays pending mail. Each machine-framed message is claimed by the feed, then
// acknowledged only after this host admits it into the active input channel.
// Process/feed crashes therefore replay instead of silently losing a steer.
import { spawn as procSpawn, type ChildProcess } from "node:child_process";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import { parseStrictJson } from "./strict-json";
import { trustedNorthBabashkaExecutable } from "./trusted-runtime";

const REPO = resolve(import.meta.dir, "..", "..");
const LIVE_FEED = `${REPO}/cli/north-live-feed.clj`;
const DEFAULT_PORT = "7977";
const LIVE_FEED_PROTOCOL = "north-live-feed-v1";
const DEFAULT_FEED_FRAME_BYTES = 192 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 8_000;
const LIVE_FEED_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 45_000;
const DEFAULT_STOP_KILL_MS = 1_000;
const DEFAULT_DEDUPE_IDS = 4_096;
const MAX_ID_BYTES = 512;
const MAX_SENDER_BYTES = 1_024;
const MAX_SUBJECT_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 128 * 1024;
const ROUTE_EPOCH =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIX_BABASHKA =
  /^\/nix\/store\/[0-9a-z]{32}-babashka(?:-[^/]+)?\/bin\/bb$/;

export interface InputAdmission {
  /** True only when the provider input iterator dequeues this exact turn. */
  readonly consumed: Promise<boolean>;
  /** Withdraw a still-queued turn; a consumed turn cannot be withdrawn. */
  readonly cancel: () => void;
}

type FeedAdmissionValue =
  | void
  | boolean
  | InputAdmission;
type FeedAdmission =
  | FeedAdmissionValue
  | PromiseLike<FeedAdmissionValue>;

export class LiveFeedConfigurationError extends Error {
  readonly code = "NORTH_LIVE_FEED_CONFIGURATION_INVALID";

  constructor() {
    super("trusted North Babashka executable unavailable");
    this.name = "LiveFeedConfigurationError";
  }
}

export class LiveFeedStoppedBeforeReadyError extends Error {
  readonly code = "NORTH_LIVE_FEED_STOPPED_BEFORE_READY";

  constructor() {
    super("North live feed stopped before its coordinator subscription was armed");
    this.name = "LiveFeedStoppedBeforeReadyError";
  }
}

export class LiveFeedStartupTimeoutError extends Error {
  readonly code = "NORTH_LIVE_FEED_STARTUP_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super("North live feed did not arm within its bounded startup budget");
    this.name = "LiveFeedStartupTimeoutError";
  }
}

export interface FeedSubscription {
  (): void;
  /** Resolves only after the coordinator subscription is armed and start is admitted. */
  readonly ready: Promise<void>;
  /**
   * Freeze-side barrier. Resolves only after the still-bound feed has observed
   * the frozen route and terminally settled every producer-admitted steer that
   * was ordered before it.
   */
  readonly drain: (frozenRouteEpoch: string) => Promise<void>;
  /**
   * Diagnostic transport state. Once `ready` resolves, live-input capability is
   * durable across recoverable child restarts because graph mail is replayed;
   * callers must not downgrade that public capability merely for transient false.
   */
  readonly isArmed: () => boolean;
}

export interface SubscriptionRuntime {
  spawn?: typeof procSpawn;
  /** Test injection. Production must use the wrapper-owned Nix-store selector. */
  bbExecutable?: string;
  /** Test injection. Production resolves the coordinator port from NORTH_PORT at spawn time. */
  port?: string;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  healthyResetMs?: number;
  /** Compatibility name: now bounds each machine frame, not process-lifetime output. */
  maxOutputBytes?: number;
  maxFrameBytes?: number;
  readyTimeoutMs?: number;
  startupTimeoutMs?: number;
  admissionTimeoutMs?: number;
  drainTimeoutMs?: number;
  stopKillMs?: number;
  dedupeIds?: number;
}

interface ReadyFrame {
  protocol: typeof LIVE_FEED_PROTOCOL;
  type: "ready";
  recipient: string;
  subscribed: number;
}

interface MailFrame {
  protocol: typeof LIVE_FEED_PROTOCOL;
  type: "mail";
  id: string;
  from: string;
  subject: string;
  body: string;
}

interface DrainedFrame {
  protocol: typeof LIVE_FEED_PROTOCOL;
  type: "drained";
  recipient: string;
  epoch: string;
}

interface DrainProgressFrame {
  protocol: typeof LIVE_FEED_PROTOCOL;
  type: "drain_progress";
  recipient: string;
  epoch: string;
  settled: number;
}

interface ErrorFrame {
  protocol: typeof LIVE_FEED_PROTOCOL;
  type: "error";
  code: string;
  id?: string;
}

type FeedFrame =
  | ReadyFrame
  | MailFrame
  | DrainProgressFrame
  | DrainedFrame
  | ErrorFrame;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function peerBabashkaExecutable(injected: string | undefined): string {
  // An explicit in-process injection (SubscriptionRuntime.bbExecutable) is a
  // test seam — never attacker-reachable env — honored on the canonical
  // store-shape check alone. Production passes undefined and resolves the
  // immutable Nix-store bb from trusted entry pointers under the full realpath +
  // X_OK proof: managed children do not always inherit the wrapper's
  // NORTH_PEER_BB, so the feed's bb must be discoverable from the same immutable
  // system/profile layout as trusted Git, not a bare env assumption.
  if (injected !== undefined) {
    if (!NIX_BABASHKA.test(injected)) throw new LiveFeedConfigurationError();
    return injected;
  }
  try {
    return trustedNorthBabashkaExecutable();
  } catch {
    throw new LiveFeedConfigurationError();
  }
}

function userMsg(text: string): SDKUserMessage {
  // priority 'now' = urgent: jump the queue so a real-time ping is seen ASAP.
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    priority: "now",
  };
}

// A controllable input channel. `push` is the durable admission boundary: its
// promise resolves true only when the provider iterator dequeues that exact
// turn. Closing or cancelling first resolves false so graph mail can replay.
export function inputChannel(initial: string) {
  interface QueuedInput {
    message: SDKUserMessage;
    state: "queued" | "consumed" | "cancelled";
    settle?: (consumed: boolean) => void;
  }
  const queue: QueuedInput[] = [{
    message: userMsg(initial),
    state: "queued",
  }];
  let wake: (() => void) | null = null;
  let closed = false;
  let liveMessagesReceived = 0;
  const cancelQueued = (entry: QueuedInput) => {
    if (entry.state !== "queued") return;
    entry.state = "cancelled";
    entry.settle?.(false);
  };
  return {
    push(text: string): InputAdmission {
      if (closed) {
        return {
          consumed: Promise.resolve(false),
          cancel: () => {},
        };
      }
      let settle!: (consumed: boolean) => void;
      const consumed = new Promise<boolean>((resolveConsumed) => {
        settle = resolveConsumed;
      });
      const entry: QueuedInput = {
        message: userMsg(text),
        state: "queued",
        settle,
      };
      queue.push(entry);
      wake?.();
      wake = null;
      return {
        consumed,
        cancel: () => cancelQueued(entry),
      };
    },
    end() {
      if (closed) return;
      closed = true;
      for (const entry of queue) {
        if (entry.settle) cancelQueued(entry);
      }
      wake?.();
      wake = null;
    },
    pending() {
      return queue.reduce(
        (count, entry) => count + (entry.state === "queued" ? 1 : 0),
        0,
      );
    },
    liveMessagesReceived() { return liveMessagesReceived; },
    async *stream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (queue.length) {
          const entry = queue.shift()!;
          if (entry.state !== "queued") continue;
          entry.state = "consumed";
          if (entry.settle) {
            liveMessagesReceived++;
            entry.settle(true);
          }
          yield entry.message;
        }
        if (closed) return;
        await new Promise<void>((resolveWake) => { wake = resolveWake; });
      }
    },
  };
}

class LiveFeedLines {
  private fragments: Buffer[] = [];
  private bufferedBytes = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxLineBytes: number) {
    positiveInteger(maxLineBytes, "maxFrameBytes");
  }

  push(value: Buffer | string): readonly string[] {
    const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = incoming.indexOf(0x0a, start);
      if (newline < 0) break;
      const segment = incoming.subarray(start, newline);
      if (this.bufferedBytes + segment.byteLength > this.maxLineBytes)
        throw new Error("North live-feed frame exceeds its byte bound");
      if (segment.byteLength) {
        this.fragments.push(segment);
        this.bufferedBytes += segment.byteLength;
      }
      const raw = this.fragments.length === 1
        ? this.fragments[0]!
        : Buffer.concat(this.fragments, this.bufferedBytes);
      this.fragments = [];
      this.bufferedBytes = 0;
      let line: string;
      try { line = this.decoder.decode(raw); }
      catch { throw new Error("North live-feed emitted invalid UTF-8"); }
      if (!line.length) throw new Error("North live-feed emitted an empty frame");
      lines.push(line);
      start = newline + 1;
    }
    const remainder = incoming.subarray(start);
    if (this.bufferedBytes + remainder.byteLength > this.maxLineBytes)
      throw new Error("North live-feed frame exceeds its byte bound");
    if (remainder.byteLength) {
      this.fragments.push(remainder);
      this.bufferedBytes += remainder.byteLength;
    }
    return lines;
  }

  finish(): void {
    if (this.bufferedBytes)
      throw new Error("North live-feed closed with a partial frame");
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function boundedString(
  value: unknown,
  maxBytes: number,
  pattern?: RegExp,
): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && (pattern === undefined || pattern.test(value));
}

function feedFrame(line: string, maxFrameBytes: number): FeedFrame {
  const parsed = parseStrictJson(line, "North live-feed frame", {
    maxBytes: maxFrameBytes,
    maxDepth: 2,
    maxNodes: 16,
  });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("North live-feed frame must be an object");
  const frame = parsed as Record<string, unknown>;
  if (frame.protocol !== LIVE_FEED_PROTOCOL)
    throw new Error("North live-feed protocol mismatch");

  if (frame.type === "ready") {
    if (!exactKeys(frame, ["protocol", "type", "recipient", "subscribed"])
        || !boundedString(frame.recipient, MAX_ID_BYTES, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
        || !Number.isSafeInteger(frame.subscribed)
        || (frame.subscribed as number) < 0)
      throw new Error("North live-feed ready frame is malformed");
    return frame as unknown as ReadyFrame;
  }

  if (frame.type === "mail") {
    if (!exactKeys(frame, ["protocol", "type", "id", "from", "subject", "body"])
        || !boundedString(frame.id, MAX_ID_BYTES, /^@msg:[A-Za-z0-9][A-Za-z0-9._:-]*$/)
        || !boundedString(frame.from, MAX_SENDER_BYTES)
        || !boundedString(frame.subject, MAX_SUBJECT_BYTES)
        || !boundedString(frame.body, MAX_BODY_BYTES))
      throw new Error("North live-feed mail frame is malformed");
    return frame as unknown as MailFrame;
  }

  if (frame.type === "drain_progress") {
    if (!exactKeys(frame, ["protocol", "type", "recipient", "epoch", "settled"])
        || !boundedString(frame.recipient, MAX_ID_BYTES, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
        || !boundedString(frame.epoch, 36, ROUTE_EPOCH)
        || !Number.isSafeInteger(frame.settled)
        || (frame.settled as number) <= 0)
      throw new Error("North live-feed drain progress frame is malformed");
    return frame as unknown as DrainProgressFrame;
  }

  if (frame.type === "drained") {
    if (!exactKeys(frame, ["protocol", "type", "recipient", "epoch"])
        || !boundedString(frame.recipient, MAX_ID_BYTES, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
        || !boundedString(frame.epoch, 36, ROUTE_EPOCH))
      throw new Error("North live-feed drained frame is malformed");
    return frame as unknown as DrainedFrame;
  }

  if (frame.type === "error") {
    const keys = frame.id === undefined
      ? ["protocol", "type", "code"]
      : ["protocol", "type", "code", "id"];
    if (!exactKeys(frame, keys)
        || !boundedString(frame.code, 128, /^[a-z][a-z0-9_]*$/)
        || (frame.id !== undefined
            && !boundedString(frame.id, MAX_ID_BYTES, /^@msg:[A-Za-z0-9][A-Za-z0-9._:-]*$/)))
      throw new Error("North live-feed error frame is malformed");
    return frame as unknown as ErrorFrame;
  }

  throw new Error("North live-feed frame type is unknown");
}

function controlFrame(type: "start"): string;
function controlFrame(type: "drain", epoch: string): string;
function controlFrame(type: "ack" | "nack", id: string): string;
function controlFrame(
  type: "start" | "drain" | "ack" | "nack",
  value?: string,
): string {
  const frame = type === "drain"
    ? { type, epoch: value }
    : value === undefined ? { type } : { type, id: value };
  return `${JSON.stringify(frame)}\n`;
}

class BoundedRememberedIds {
  private readonly ids = new Set<string>();

  constructor(private readonly max: number) {
    positiveInteger(max, "dedupeIds");
  }

  has(id: string): boolean { return this.ids.has(id); }

  add(id: string): void {
    if (this.ids.delete(id)) this.ids.add(id);
    else {
      this.ids.add(id);
      while (this.ids.size > this.max) {
        const oldest = this.ids.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.ids.delete(oldest);
      }
    }
  }
}

function writeControl(child: ChildProcess, payload: string): boolean {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
  try {
    child.stdin.write(payload);
    return true;
  } catch {
    return false;
  }
}

interface NormalizedAdmission {
  readonly consumed: Promise<boolean>;
  readonly cancel: () => void;
}

function normalizeAdmission(value: FeedAdmission): NormalizedAdmission {
  const isInputAdmission = (candidate: unknown): candidate is InputAdmission =>
    typeof candidate === "object"
    && candidate !== null
    && "consumed" in candidate
    && "cancel" in candidate
    && typeof (candidate as InputAdmission).cancel === "function";
  let input: InputAdmission | null = null;
  let cancellationRequested = false;
  const cancelAdmission = () => {
    cancellationRequested = true;
    try { input?.cancel(); } catch { /* cancellation is fail-closed below */ }
  };
  return {
    consumed: Promise.resolve(value).then((admitted) => {
      if (!isInputAdmission(admitted)) return admitted !== false;
      input = admitted;
      if (cancellationRequested) cancelAdmission();
      return Promise.resolve(admitted.consumed).then(
        (consumed) => consumed === true,
        () => false,
      );
    }, () => false),
    cancel: cancelAdmission,
  };
}

function awaitAdmission(
  admission: NormalizedAdmission,
  timeoutMs: number,
  schedule: (callback: () => void, delayMs: number) => unknown,
  cancelTimer: (timer: unknown) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolveAdmission) => {
    let settled = false;
    let timer: unknown = null;
    const finish = (consumed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        cancelTimer(timer);
        timer = null;
      }
      resolveAdmission(consumed);
    };
    timer = schedule(() => {
      timer = null;
      admission.cancel();
      finish(false);
    }, timeoutMs);
    admission.consumed.then(
      (consumed) => finish(consumed),
      () => finish(false),
    );
  });
}

// Subscribe one managed lane to its durable North mail feed. The callback is an
// admission operation. InputAdmission acknowledges only after the provider
// iterator dequeues the turn; end/cancel/error before dequeue nacks the claim.
// The host remembers consumed IDs across feed process restarts so
// crash-between-dequeue-and-graph-ack replay is acked without a second push.
function subscribeFeedMode(
  self: string,
  onMail: (summary: string) => FeedAdmission,
  runtime: SubscriptionRuntime,
  settlementOnly: boolean,
): FeedSubscription {
  const spawn = runtime.spawn ?? procSpawn;
  const bbExecutable = peerBabashkaExecutable(runtime.bbExecutable);
  // Resolve at spawn time so a per-lane / restarted coordinator port is honored,
  // and so hermetic suites pin it deterministically instead of racing ambient env.
  const feedPort = runtime.port ?? process.env.NORTH_PORT ?? DEFAULT_PORT;
  const schedule = runtime.schedule
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = runtime.cancel
    ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const now = runtime.now ?? Date.now;
  const initialBackoffMs = positiveInteger(runtime.initialBackoffMs ?? 250, "initialBackoffMs");
  const maxBackoffMs = positiveInteger(runtime.maxBackoffMs ?? 5_000, "maxBackoffMs");
  const healthyResetMs = positiveInteger(runtime.healthyResetMs ?? 30_000, "healthyResetMs");
  const maxFrameBytes = positiveInteger(
    runtime.maxFrameBytes ?? runtime.maxOutputBytes ?? DEFAULT_FEED_FRAME_BYTES,
    "maxFrameBytes",
  );
  const readyTimeoutMs = positiveInteger(
    runtime.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    "readyTimeoutMs",
  );
  const startupTimeoutMs = positiveInteger(
    runtime.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    "startupTimeoutMs",
  );
  const admissionTimeoutMs = positiveInteger(
    runtime.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
    "admissionTimeoutMs",
  );
  if (admissionTimeoutMs >= LIVE_FEED_ACK_TIMEOUT_MS) {
    throw new Error(
      "admissionTimeoutMs must be smaller than the live-feed acknowledgement timeout",
    );
  }
  const drainTimeoutMs = positiveInteger(
    runtime.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    "drainTimeoutMs",
  );
  const stopKillMs = positiveInteger(runtime.stopKillMs ?? DEFAULT_STOP_KILL_MS, "stopKillMs");
  const admittedIds = new BoundedRememberedIds(runtime.dedupeIds ?? DEFAULT_DEDUPE_IDS);
  let stopped = false;
  let current: ChildProcess | null = null;
  let retryTimer: unknown = null;
  let stopKillTimer: unknown = null;
  let startupTimer: unknown = null;
  let cancelCurrentReadyTimer: (() => void) | null = null;
  let cancelCurrentAdmission: (() => void) | null = null;
  let requestCurrentDrain: (() => void) | null = null;
  let rapidFailures = 0;
  let armed = false;
  let drainRequested = false;
  let drainEpoch: string | null = null;
  let drainSettled = false;
  let drainTimer: unknown = null;
  let resolveDrain!: () => void;
  let rejectDrain!: (error: Error) => void;
  const drained = new Promise<void>((resolve, reject) => {
    resolveDrain = resolve;
    rejectDrain = reject;
  });
  void drained.catch(() => {});
  let readinessSettled = false;
  let resolveReadiness!: () => void;
  let rejectReadiness!: (error: Error) => void;
  const readiness = new Promise<void>((resolveReady, rejectReady) => {
    resolveReadiness = resolveReady;
    rejectReadiness = rejectReady;
  });
  // Existing stop-only callers need not install a rejection handler. Awaiters
  // still observe the original promise's typed stop-before-ready rejection.
  void readiness.catch(() => {});

  const armDrainDeadline = () => {
    if (drainTimer !== null) cancel(drainTimer);
    drainTimer = schedule(() => {
      drainTimer = null;
      if (drainSettled) return;
      drainSettled = true;
      rejectDrain(new Error("North live-feed terminal drain timed out"));
    }, drainTimeoutMs);
  };

  const backoff = (): number =>
    Math.min(maxBackoffMs, initialBackoffMs * (2 ** Math.min(rapidFailures - 1, 20)));

  const start = () => {
    if (stopped) return;
    const startedAt = now();
    let child: ChildProcess;
    try {
      child = spawn(bbExecutable, [
        LIVE_FEED,
        feedPort,
        self,
        "--ack-timeout-ms",
        String(LIVE_FEED_ACK_TIMEOUT_MS),
        ...(settlementOnly ? ["--settlement-only", "true"] : []),
      ], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      rapidFailures++;
      retryTimer = schedule(() => {
        retryTimer = null;
        start();
      }, backoff());
      return;
    }
    current = child;
    child.stdin?.on("error", () => { /* close/replay is the recovery path */ });
    const lines = new LiveFeedLines(maxFrameBytes);
    let ready = false;
    let closed = false;
    let recoveryScheduled = false;
    let protocolFailed = false;
    let readyTimer: unknown = null;
    let activeAdmission: NormalizedAdmission | null = null;
    let drainSent = false;
    let lastDrainProgress = 0;
    let processing: Promise<void> = Promise.resolve();
    const clearReadyTimer = () => {
      if (readyTimer !== null) {
        cancel(readyTimer);
        readyTimer = null;
      }
      if (cancelCurrentReadyTimer === clearReadyTimer)
        cancelCurrentReadyTimer = null;
    };
    readyTimer = schedule(() => {
      readyTimer = null;
      if (cancelCurrentReadyTimer === clearReadyTimer)
        cancelCurrentReadyTimer = null;
      if (stopped || ready || closed) return;
      protocolFailed = true;
      try { child.kill("SIGKILL"); } catch { /* close schedules recovery */ }
    }, readyTimeoutMs);
    cancelCurrentReadyTimer = clearReadyTimer;

    const failProtocol = () => {
      if (protocolFailed || closed) return;
      protocolFailed = true;
      armed = false;
      activeAdmission?.cancel();
      try { child.kill("SIGKILL"); } catch { /* close schedules recovery */ }
    };

    const sendDrain = () => {
      if (
        !drainRequested
        || drainSettled
        || drainSent
        || !ready
        || stopped
        || protocolFailed
        || closed
      ) return;
      if (drainEpoch === null) {
        failProtocol();
        return;
      }
      drainSent = true;
      activeAdmission?.cancel();
      if (!writeControl(child, controlFrame("drain", drainEpoch)))
        failProtocol();
    };
    requestCurrentDrain = sendDrain;

    const handleFrame = async (frame: FeedFrame): Promise<void> => {
      if (stopped || protocolFailed || closed) return;
      if (frame.type === "ready") {
        if (ready || frame.recipient !== self)
          throw new Error("North live-feed readiness is contradictory");
        ready = true;
        clearReadyTimer();
        if (!writeControl(child, controlFrame("start")))
          throw new Error("North live-feed start acknowledgement failed");
        armed = true;
        if (!readinessSettled) {
          readinessSettled = true;
          if (startupTimer !== null) {
            cancel(startupTimer);
            startupTimer = null;
          }
          resolveReadiness();
        }
        sendDrain();
        return;
      }
      if (!ready) throw new Error("North live-feed delivered before readiness");
      if (frame.type === "drain_progress") {
        if (
          frame.recipient !== self
          || frame.epoch !== drainEpoch
          || !drainRequested
          || drainSettled
          || !drainSent
          || frame.settled <= lastDrainProgress
        ) {
          throw new Error("North live-feed drain progress is contradictory");
        }
        lastDrainProgress = frame.settled;
        armDrainDeadline();
        return;
      }
      if (frame.type === "drained") {
        if (
          frame.recipient !== self
          || frame.epoch !== drainEpoch
          || !drainRequested
          || drainSettled
          || !drainSent
        ) {
          throw new Error("North live-feed drain acknowledgement is contradictory");
        }
        drainSettled = true;
        if (drainTimer !== null) {
          cancel(drainTimer);
          drainTimer = null;
        }
        resolveDrain();
        return;
      }
      if (frame.type === "error") {
        console.error(
          `[north-feed] ${frame.code}${frame.id ? ` (${frame.id})` : ""}`,
        );
        return;
      }

      if (drainRequested) {
        // The route is already frozen. Cancel any frame that crossed the pipe
        // just before the freeze; the feed's terminal scan will reject managed
        // steers durably instead of admitting them into a dead provider input.
        if (!writeControl(child, controlFrame("nack", frame.id)))
          throw new Error("North live-feed drain rejection failed");
        return;
      }

      if (admittedIds.has(frame.id)) {
        // A prior feed died after provider dequeue but before durable graph ack.
        // Complete the new claim without injecting the user turn twice.
        if (!writeControl(child, controlFrame("ack", frame.id)))
          throw new Error("North live-feed replay acknowledgement failed");
        return;
      }

      let rawAdmission: FeedAdmission;
      try {
        rawAdmission = onMail(
          `[north real-time ping from ${frame.from} — ${frame.subject}]\n${frame.body}`,
        );
      } catch {
        if (!writeControl(child, controlFrame("nack", frame.id)))
          throw new Error("North live-feed rejection acknowledgement failed");
        return;
      }

      const admission = normalizeAdmission(rawAdmission);
      activeAdmission = admission;
      const cancelAdmission = () => admission.cancel();
      cancelCurrentAdmission = cancelAdmission;
      const consumed = await awaitAdmission(
        admission,
        admissionTimeoutMs,
        schedule,
        cancel,
      );
      if (activeAdmission === admission) activeAdmission = null;
      if (cancelCurrentAdmission === cancelAdmission)
        cancelCurrentAdmission = null;

      if (!consumed) {
        if (!writeControl(child, controlFrame("nack", frame.id)))
          throw new Error("North live-feed rejection acknowledgement failed");
        return;
      }

      // Remember before the graph ack. If the feed dies on this write, its next
      // claim is acked without delivering the already-dequeued turn twice.
      admittedIds.add(frame.id);
      if (!writeControl(child, controlFrame("ack", frame.id)))
        throw new Error("North live-feed delivery acknowledgement failed");
    };

    const enqueueFrame = (frame: FeedFrame) => {
      processing = processing
        .then(() => handleFrame(frame))
        .catch(() => { failProtocol(); });
    };

    child.stdout?.on("data", (value: Buffer | string) => {
      if (stopped || protocolFailed || closed) return;
      try {
        // Validate the complete chunk before queueing any of it. A malformed
        // sibling frame therefore cannot leave a valid prefix half-admitted.
        const frames = lines.push(value)
          .map((line) => feedFrame(line, maxFrameBytes));
        for (const frame of frames) enqueueFrame(frame);
      } catch {
        failProtocol();
      }
    });

    child.once("error", () => { /* `close` is the single recovery edge */ });
    child.once("close", () => {
      if (closed) return;
      closed = true;
      const closedAt = now();
      clearReadyTimer();
      armed = false;
      activeAdmission?.cancel();
      try { lines.finish(); }
      catch { protocolFailed = true; }
      if (current === child) current = null;
      if (requestCurrentDrain === sendDrain) requestCurrentDrain = null;
      if (stopKillTimer !== null) {
        cancel(stopKillTimer);
        stopKillTimer = null;
      }
      void processing.then(() => {
        if (recoveryScheduled) return;
        recoveryScheduled = true;
        if (stopped) return;
        // A short-lived child always backs off, even when it delivered a frame.
        // Otherwise a durable-ack failure could produce a zero-delay crash loop.
        const healthy = closedAt - startedAt >= healthyResetMs;
        if (healthy && !protocolFailed) rapidFailures = 0;
        else rapidFailures++;
        retryTimer = schedule(() => {
          retryTimer = null;
          start();
        }, healthy && !protocolFailed ? 0 : backoff());
      });
    });
  };

  const terminate = (readinessError: Error) => {
    if (stopped) return;
    stopped = true;
    armed = false;
    if (!readinessSettled) {
      readinessSettled = true;
      rejectReadiness(readinessError);
    }
    if (startupTimer !== null) {
      cancel(startupTimer);
      startupTimer = null;
    }
    if (retryTimer !== null) {
      cancel(retryTimer);
      retryTimer = null;
    }
    cancelCurrentReadyTimer?.();
    cancelCurrentAdmission?.();
    requestCurrentDrain = null;
    if (!drainSettled) {
      drainSettled = true;
      if (drainTimer !== null) {
        cancel(drainTimer);
        drainTimer = null;
      }
      rejectDrain(readinessError);
    }
    const child = current;
    if (!child) return;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    stopKillTimer = schedule(() => {
      stopKillTimer = null;
      if (current !== child) return;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, stopKillMs);
  };
  const stop = (() => {
    terminate(new LiveFeedStoppedBeforeReadyError());
  }) as FeedSubscription;
  const drain = (frozenRouteEpoch: string) => {
    if (drainRequested) {
      return frozenRouteEpoch === drainEpoch
        ? drained
        : Promise.reject(new Error("North live-feed drain epoch changed"));
    }
    if (stopped) return Promise.reject(new Error("North live feed is already stopped"));
    if (!ROUTE_EPOCH.test(frozenRouteEpoch))
      return Promise.reject(new Error("North live-feed drain epoch is malformed"));
    drainRequested = true;
    drainEpoch = frozenRouteEpoch;
    cancelCurrentAdmission?.();
    armDrainDeadline();
    requestCurrentDrain?.();
    return drained;
  };
  Object.defineProperties(stop, {
    ready: { value: readiness, enumerable: true },
    drain: { value: drain, enumerable: true },
    isArmed: { value: () => armed, enumerable: true },
  });
  startupTimer = schedule(() => {
    startupTimer = null;
    terminate(new LiveFeedStartupTimeoutError(startupTimeoutMs));
  }, startupTimeoutMs);
  start();
  return stop;
}

export function subscribeFeed(
  self: string,
  onMail: (summary: string) => FeedAdmission,
  runtime: SubscriptionRuntime = {},
): FeedSubscription {
  return subscribeFeedMode(self, onMail, runtime, false);
}

/**
 * Arm a feed that never admits ordinary mail and exists only to settle
 * manifest-marked steers against an already-frozen managed route.
 */
export function subscribeSettlementFeed(
  self: string,
  runtime: SubscriptionRuntime = {},
): FeedSubscription {
  return subscribeFeedMode(self, () => false, runtime, true);
}
