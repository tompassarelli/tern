import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import {
  inputChannel,
  LiveFeedConfigurationError,
  LiveFeedReapTimeoutError,
  LiveFeedStartupTimeoutError,
  LiveFeedStoppedBeforeReadyError,
  subscribeFeed,
  subscribeSettlementFeed,
} from "../src/coordination";

const protocol = "north-live-feed-v1";
const frozenEpoch = "00000000-0000-4000-8000-000000000042";
const trustedBb =
  "/nix/store/00000000000000000000000000000000-babashka-test/bin/bb";

class FakeStdin extends EventEmitter {
  destroyed = false;
  writable = true;
  writes: string[] = [];

  write(value: string | Buffer) {
    if (!this.writable || this.destroyed) throw new Error("stdin unavailable");
    this.writes.push(String(value));
    return true;
  }

  end() {
    this.writable = false;
  }

  destroy() {
    this.destroyed = true;
    this.writable = false;
  }
}

class FakeStdout extends EventEmitter {
  destroyed = false;

  destroy() {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStdout();
  stdin = new FakeStdin();
  stderr = null;
  signals: Array<string | undefined> = [];
  unrefCalls = 0;

  kill(signal?: string) {
    this.signals.push(signal);
    return true;
  }

  unref() {
    this.unrefCalls++;
  }
}

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function harness(options: {
  maxFrameBytes?: number;
  admissionTimeoutMs?: number;
  drainTimeoutMs?: number;
  stopKillMs?: number;
  stopReapMs?: number;
  settlementOnly?: boolean;
} = {}) {
  const children: FakeChild[] = [];
  const timers: FakeTimer[] = [];
  let clock = 0;
  const runtime = {
    spawn: ((command: string, args: string[], spawnOptions: unknown) => {
      expect(command).toBe(trustedBb);
      expect(args[0]).toEndWith("/cli/north-live-feed.clj");
      expect(args.slice(1)).toEqual([
        "7977",
        "agent-test",
        "--ack-timeout-ms",
        "10000",
        ...(options.settlementOnly ? ["--settlement-only", "true"] : []),
      ]);
      expect(spawnOptions).toEqual({ stdio: ["pipe", "pipe", "ignore"] });
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as any,
    bbExecutable: trustedBb,
    port: "7977",
    schedule: (callback: () => void, delayMs: number) => {
      const timer: FakeTimer = {
        callback: () => {
          if (timer.cancelled) return;
          timer.cancelled = true;
          callback();
        },
        delayMs,
        cancelled: false,
      };
      timers.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => { (timer as FakeTimer).cancelled = true; },
    now: () => clock,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
    healthyResetMs: 30_000,
    readyTimeoutMs: 5_000,
    startupTimeoutMs: 20_000,
    admissionTimeoutMs: options.admissionTimeoutMs ?? 3_000,
    drainTimeoutMs: options.drainTimeoutMs ?? 45_000,
    stopKillMs: options.stopKillMs ?? 250,
    stopReapMs: options.stopReapMs ?? 5_000,
    ...(options.maxFrameBytes === undefined
      ? {}
      : { maxFrameBytes: options.maxFrameBytes }),
  };
  return {
    children,
    timers,
    runtime,
    setClock(value: number) { clock = value; },
    activeTimers() { return timers.filter(({ cancelled }) => !cancelled); },
  };
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emitLine(child: FakeChild, value: object | string) {
  const line = typeof value === "string" ? value : JSON.stringify(value);
  child.stdout.emit("data", Buffer.from(`${line}\n`));
}

function ready(child: FakeChild, recipient = "agent-test") {
  emitLine(child, {
    protocol,
    type: "ready",
    recipient,
    subscribed: 17,
  });
}

function mail(
  child: FakeChild,
  id = "@msg:one",
  subject = "update",
  body = "done",
) {
  emitLine(child, {
    protocol,
    type: "mail",
    id,
    from: "peer",
    subject,
    body,
  });
}

function drainProgress(
  child: FakeChild,
  settled: number,
  recipient = "agent-test",
  epoch = frozenEpoch,
) {
  emitLine(child, {
    protocol,
    type: "drain_progress",
    recipient,
    epoch,
    settled,
  });
}

function drained(
  child: FakeChild,
  recipient = "agent-test",
  epoch = frozenEpoch,
) {
  emitLine(child, {
    protocol,
    type: "drained",
    recipient,
    epoch,
  });
}

test("input channel cancels queued live turns when it closes before dequeue", async () => {
  const channel = inputChannel("initial");
  const live = channel.push("live");
  expect(channel.pending()).toBe(2);
  expect(channel.liveMessagesReceived()).toBe(0);
  channel.end();
  expect(await live.consumed).toBe(false);
  expect(await channel.push("too late").consumed).toBe(false);
  expect(channel.liveMessagesReceived()).toBe(0);

  const values: string[] = [];
  for await (const message of channel.stream())
    values.push(message.message.content as string);
  expect(values).toEqual(["initial"]);
});

test("input channel proves a live turn only when the provider dequeues it", async () => {
  const channel = inputChannel("initial");
  const stream = channel.stream();
  expect((await stream.next()).value?.message.content).toBe("initial");

  const live = channel.push("live");
  let consumed = false;
  void live.consumed.then((value) => { consumed = value; });
  await settle();
  expect(consumed).toBe(false);
  expect(channel.liveMessagesReceived()).toBe(0);

  expect((await stream.next()).value?.message.content).toBe("live");
  expect(await live.consumed).toBe(true);
  expect(channel.liveMessagesReceived()).toBe(1);
  channel.end();
  expect((await stream.next()).done).toBe(true);
});

test("subscription separates readiness, admits once, and acks the exact message ID", async () => {
  const h = harness();
  const admitted: string[] = [];
  const subscription = subscribeFeed("agent-test", (summary) => {
    admitted.push(summary);
    return true;
  }, h.runtime);
  const child = h.children[0]!;

  expect(subscription.isArmed()).toBe(false);
  expect(child.stdin.writes).toEqual([]);
  ready(child);
  await subscription.ready;
  expect(subscription.isArmed()).toBe(true);
  expect(child.stdin.writes).toEqual(['{"type":"start"}\n']);
  mail(child);
  await settle();
  expect(admitted).toEqual(["[north real-time ping from peer — update]\ndone"]);
  expect(child.stdin.writes).toEqual([
    '{"type":"start"}\n',
    '{"type":"ack","id":"@msg:one"}\n',
  ]);
  subscription();
  expect(subscription.isArmed()).toBe(false);
});

test("terminal drain is canonical, rejects crossing mail, and resolves only on its receipt", async () => {
  const h = harness();
  let admissions = 0;
  const subscription = subscribeFeed(
    "agent-test",
    () => { admissions++; return true; },
    h.runtime,
  );
  const child = h.children[0]!;
  ready(child);
  await subscription.ready;

  let resolved = false;
  const barrier = subscription.drain(frozenEpoch).then(() => { resolved = true; });
  expect(child.stdin.writes).toEqual([
    '{"type":"start"}\n',
    `{"type":"drain","epoch":"${frozenEpoch}"}\n`,
  ]);
  mail(child, "@msg:crossing-freeze");
  await settle();
  expect(admissions).toBe(0);
  expect(child.stdin.writes).toContain(
    '{"type":"nack","id":"@msg:crossing-freeze"}\n',
  );
  expect(resolved).toBe(false);

  drained(child);
  await barrier;
  expect(resolved).toBe(true);
  subscription();
});

test("terminal drain survives a child crash and is reissued after re-arm", async () => {
  const h = harness();
  const subscription = subscribeFeed("agent-test", () => true, h.runtime);
  const first = h.children[0]!;
  ready(first);
  await subscription.ready;
  const barrier = subscription.drain(frozenEpoch);
  expect(first.stdin.writes).toContain(
    `{"type":"drain","epoch":"${frozenEpoch}"}\n`,
  );

  first.emit("close", 1);
  await settle();
  const retry = h.activeTimers().find(({ delayMs }) => delayMs === 100);
  expect(retry).toBeDefined();
  retry!.callback();
  const replacement = h.children[1]!;
  ready(replacement);
  await settle();
  expect(replacement.stdin.writes).toEqual([
    '{"type":"start"}\n',
    `{"type":"drain","epoch":"${frozenEpoch}"}\n`,
  ]);
  drained(replacement);
  await barrier;
  subscription();
});

test("unsolicited or wrong-recipient drain receipts fail closed", async () => {
  const unsolicited = harness();
  const first = subscribeFeed("agent-test", () => true, unsolicited.runtime);
  ready(unsolicited.children[0]!);
  await first.ready;
  drained(unsolicited.children[0]!);
  await settle();
  expect(unsolicited.children[0]!.signals).toContain("SIGKILL");
  first();

  const wrong = harness();
  const second = subscribeFeed("agent-test", () => true, wrong.runtime);
  ready(wrong.children[0]!);
  await second.ready;
  const barrier = second.drain(frozenEpoch);
  drained(wrong.children[0]!, "different-agent");
  await settle();
  expect(wrong.children[0]!.signals).toContain("SIGKILL");
  void barrier.catch(() => {});
  second();
});

test("terminal drain has a bounded rejection deadline", async () => {
  const h = harness({ drainTimeoutMs: 700 });
  const subscription = subscribeFeed("agent-test", () => true, h.runtime);
  ready(h.children[0]!);
  await subscription.ready;
  const barrier = subscription.drain(frozenEpoch);
  const timeout = h.activeTimers().find(({ delayMs }) => delayMs === 700);
  expect(timeout).toBeDefined();
  timeout!.callback();
  await expect(barrier).rejects.toThrow("terminal drain timed out");
  subscription();
});

test("durable drain progress renews the watchdog without weakening the epoch", async () => {
  const h = harness({ drainTimeoutMs: 700 });
  const subscription = subscribeFeed("agent-test", () => true, h.runtime);
  const child = h.children[0]!;
  ready(child);
  await subscription.ready;
  const barrier = subscription.drain(frozenEpoch);
  const firstDeadline = h.activeTimers().find(({ delayMs }) => delayMs === 700)!;
  drainProgress(child, 1);
  await settle();
  expect(firstDeadline.cancelled).toBe(true);
  const secondDeadline = h.activeTimers().find(({ delayMs }) => delayMs === 700)!;
  expect(secondDeadline).not.toBe(firstDeadline);
  drainProgress(child, 2);
  await settle();
  expect(secondDeadline.cancelled).toBe(true);
  drained(child);
  await barrier;
  subscription();
});

test("drain rejects malformed or changing route epochs before false success", async () => {
  const h = harness();
  const subscription = subscribeFeed("agent-test", () => true, h.runtime);
  const child = h.children[0]!;
  ready(child);
  await subscription.ready;
  await expect(subscription.drain("not-an-epoch")).rejects.toThrow(
    "drain epoch is malformed",
  );
  expect(child.stdin.writes).toEqual(['{"type":"start"}\n']);
  const barrier = subscription.drain(frozenEpoch);
  await expect(
    subscription.drain("00000000-0000-4000-8000-000000000043"),
  ).rejects.toThrow("drain epoch changed");
  drained(child);
  await barrier;
  subscription();
});

test("dedicated settlement feed launches in non-admitting mode", async () => {
  const h = harness({ settlementOnly: true });
  const subscription = subscribeSettlementFeed("agent-test", h.runtime);
  const child = h.children[0]!;
  ready(child);
  await subscription.ready;
  const barrier = subscription.drain(frozenEpoch);
  expect(child.stdin.writes).toEqual([
    '{"type":"start"}\n',
    `{"type":"drain","epoch":"${frozenEpoch}"}\n`,
  ]);
  drained(child);
  await barrier;
  subscription();
});

test("subscription acks only after the provider dequeues the queued turn", async () => {
  const h = harness();
  const channel = inputChannel("initial");
  const stream = channel.stream();
  expect((await stream.next()).value?.message.content).toBe("initial");
  const stop = subscribeFeed(
    "agent-test",
    (summary) => channel.push(summary),
    h.runtime,
  );
  const child = h.children[0]!;

  ready(child);
  await stop.ready;
  mail(child, "@msg:dequeue");
  await settle();
  expect(channel.pending()).toBe(1);
  expect(channel.liveMessagesReceived()).toBe(0);
  expect(child.stdin.writes).toEqual(['{"type":"start"}\n']);

  expect((await stream.next()).value?.message.content).toBe(
    "[north real-time ping from peer — update]\ndone",
  );
  await settle();
  expect(channel.liveMessagesReceived()).toBe(1);
  expect(child.stdin.writes).toContain(
    '{"type":"ack","id":"@msg:dequeue"}\n',
  );
  channel.end();
  stop();
});

test("channel end before dequeue nacks and the same message remains retryable", async () => {
  const h = harness();
  let channel = inputChannel("initial");
  let stream = channel.stream();
  await stream.next();
  let admissions = 0;
  const stop = subscribeFeed("agent-test", (summary) => {
    admissions++;
    return channel.push(summary);
  }, h.runtime);
  const child = h.children[0]!;

  ready(child);
  await stop.ready;
  mail(child, "@msg:end-before-dequeue");
  await settle();
  expect(child.stdin.writes).not.toContain(
    '{"type":"ack","id":"@msg:end-before-dequeue"}\n',
  );
  channel.end();
  await settle();
  expect(child.stdin.writes).toContain(
    '{"type":"nack","id":"@msg:end-before-dequeue"}\n',
  );

  channel = inputChannel("replacement");
  stream = channel.stream();
  await stream.next();
  mail(child, "@msg:end-before-dequeue");
  await settle();
  expect(admissions).toBe(2);
  await stream.next();
  await settle();
  expect(child.stdin.writes.filter(
    (line) => line === '{"type":"ack","id":"@msg:end-before-dequeue"}\n',
  )).toHaveLength(1);
  channel.end();
  stop();
});

test("admission timeout withdraws a queued turn and nacks its claim", async () => {
  const h = harness({ admissionTimeoutMs: 3_000 });
  const channel = inputChannel("initial");
  const stream = channel.stream();
  await stream.next();
  const stop = subscribeFeed(
    "agent-test",
    (summary) => channel.push(summary),
    h.runtime,
  );
  const child = h.children[0]!;

  ready(child);
  await stop.ready;
  mail(child, "@msg:timeout");
  await settle();
  const admissionTimeout = h.activeTimers()
    .find(({ delayMs }) => delayMs === 3_000);
  expect(admissionTimeout).toBeDefined();
  admissionTimeout!.callback();
  await settle();

  expect(channel.pending()).toBe(0);
  expect(channel.liveMessagesReceived()).toBe(0);
  expect(child.stdin.writes).toContain(
    '{"type":"nack","id":"@msg:timeout"}\n',
  );
  expect(child.stdin.writes).not.toContain(
    '{"type":"ack","id":"@msg:timeout"}\n',
  );
  channel.end();
  stop();
});

test("host admission timeout must precede the child acknowledgement deadline", () => {
  const h = harness({ admissionTimeoutMs: 10_000 });
  expect(() => subscribeFeed("agent-test", () => true, h.runtime)).toThrow(
    "admissionTimeoutMs must be smaller than the live-feed acknowledgement timeout",
  );
  expect(h.children).toHaveLength(0);
});

test("async admission is serialized and may resolve to a dequeue proof", async () => {
  const h = harness();
  const channel = inputChannel("initial");
  const stream = channel.stream();
  await stream.next();
  const gate = deferred<void>();
  const admissions: string[] = [];
  const stop = subscribeFeed("agent-test", (summary) => {
    admissions.push(summary);
    if (admissions.length === 1) {
      return gate.promise.then(() => channel.push(summary));
    }
    return true;
  }, h.runtime);
  const child = h.children[0]!;

  ready(child);
  await stop.ready;
  mail(child, "@msg:async-one", "first", "one");
  mail(child, "@msg:async-two", "second", "two");
  await settle();
  expect(admissions).toHaveLength(1);
  expect(child.stdin.writes.filter(
    (line) => line.startsWith('{"type":"ack"'),
  )).toEqual([]);

  gate.resolve();
  await settle();
  expect(admissions).toHaveLength(1);
  expect(channel.pending()).toBe(1);
  expect((await stream.next()).value?.message.content).toBe(
    "[north real-time ping from peer — first]\none",
  );
  await settle();

  expect(admissions).toHaveLength(2);
  expect(child.stdin.writes.filter(
    (line) => line.startsWith('{"type":"ack"'),
  )).toEqual([
    '{"type":"ack","id":"@msg:async-one"}\n',
    '{"type":"ack","id":"@msg:async-two"}\n',
  ]);
  channel.end();
  stop();
});

test("timed-out async admission cancels a dequeue proof that resolves late", async () => {
  const h = harness({ admissionTimeoutMs: 3_000 });
  const channel = inputChannel("initial");
  const stream = channel.stream();
  await stream.next();
  const gate = deferred<ReturnType<typeof channel.push>>();
  const stop = subscribeFeed("agent-test", () => gate.promise, h.runtime);
  const child = h.children[0]!;

  ready(child);
  await stop.ready;
  mail(child, "@msg:late-async");
  await settle();
  const admissionTimeout = h.activeTimers()
    .find(({ delayMs }) => delayMs === 3_000);
  expect(admissionTimeout).toBeDefined();
  admissionTimeout!.callback();
  await settle();
  expect(child.stdin.writes).toContain(
    '{"type":"nack","id":"@msg:late-async"}\n',
  );

  const late = channel.push("must never reach provider");
  gate.resolve(late);
  await settle();
  expect(await late.consumed).toBe(false);
  expect(channel.pending()).toBe(0);
  expect(channel.liveMessagesReceived()).toBe(0);
  channel.end();
  stop();
});

test("crash after dequeue but before graph ack replays without a second provider turn", async () => {
  const h = harness();
  const channel = inputChannel("initial");
  const stream = channel.stream();
  await stream.next();
  let admissions = 0;
  const stop = subscribeFeed("agent-test", (summary) => {
    admissions++;
    return channel.push(summary);
  }, h.runtime);
  const first = h.children[0]!;
  ready(first);
  await stop.ready;
  mail(first, "@msg:replay");
  await settle();
  expect(admissions).toBe(1);
  expect(first.stdin.writes).not.toContain(
    '{"type":"ack","id":"@msg:replay"}\n',
  );

  first.stdin.writable = false;
  expect((await stream.next()).value?.message.content).toBe(
    "[north real-time ping from peer — update]\ndone",
  );
  await settle();
  expect(first.signals).toContain("SIGKILL");

  first.emit("close", 1);
  await settle();
  const retry = h.activeTimers().find(({ delayMs }) => delayMs === 100);
  expect(retry).toBeDefined();
  retry!.callback();
  const second = h.children[1]!;
  ready(second);
  mail(second, "@msg:replay");
  await settle();
  expect(admissions).toBe(1);
  expect(second.stdin.writes).toContain('{"type":"ack","id":"@msg:replay"}\n');
  expect(channel.pending()).toBe(0);
  channel.end();
  stop();
});

test("duplicate frames never duplicate channel admission and every replayed claim is acked", async () => {
  const h = harness();
  let admissions = 0;
  const stop = subscribeFeed("agent-test", () => { admissions++; }, h.runtime);
  const child = h.children[0]!;
  ready(child);
  mail(child, "@msg:duplicate");
  mail(child, "@msg:duplicate");
  await settle();
  expect(admissions).toBe(1);
  expect(child.stdin.writes.filter(
    (line) => line === '{"type":"ack","id":"@msg:duplicate"}\n',
  )).toHaveLength(2);
  stop();
});

test("failed channel admission nacks and remains eligible for a later retry", async () => {
  const h = harness();
  let attempts = 0;
  const stop = subscribeFeed("agent-test", () => {
    attempts++;
    return false;
  }, h.runtime);
  const child = h.children[0]!;
  ready(child);
  mail(child, "@msg:nack");
  mail(child, "@msg:nack");
  await settle();
  expect(attempts).toBe(2);
  expect(child.stdin.writes.filter(
    (line) => line === '{"type":"nack","id":"@msg:nack"}\n',
  )).toHaveLength(2);
  stop();
});

test("duplicate JSON members and frames before readiness fail closed", async () => {
  const duplicate = harness();
  const stopDuplicate = subscribeFeed("agent-test", () => {}, duplicate.runtime);
  emitLine(
    duplicate.children[0]!,
    `{"protocol":"${protocol}","type":"ready","type":"mail","recipient":"agent-test","subscribed":1}`,
  );
  expect(duplicate.children[0]!.signals).toContain("SIGKILL");
  stopDuplicate();

  const early = harness();
  const stopEarly = subscribeFeed("agent-test", () => {}, early.runtime);
  mail(early.children[0]!);
  await settle();
  expect(early.children[0]!.signals).toContain("SIGKILL");
  stopEarly();
});

test("frame bytes, UTF-8, and newline termination are independently bounded", async () => {
  const oversized = harness({ maxFrameBytes: 256 });
  const stopOversized = subscribeFeed("agent-test", () => {}, oversized.runtime);
  oversized.children[0]!.stdout.emit("data", Buffer.alloc(257, 0x78));
  expect(oversized.children[0]!.signals).toContain("SIGKILL");
  stopOversized();

  const invalidUtf8 = harness();
  const stopInvalid = subscribeFeed("agent-test", () => {}, invalidUtf8.runtime);
  invalidUtf8.children[0]!.stdout.emit("data", Buffer.from([0xff, 0x0a]));
  expect(invalidUtf8.children[0]!.signals).toContain("SIGKILL");
  stopInvalid();

  const partial = harness();
  const stopPartial = subscribeFeed("agent-test", () => {}, partial.runtime);
  partial.children[0]!.stdout.emit("data", Buffer.from("{\"protocol\":"));
  partial.children[0]!.emit("close", 1);
  await settle();
  const retry = partial.activeTimers().find(({ delayMs }) => delayMs === 100);
  expect(retry).toBeDefined();
  stopPartial();

  const oversizedFact = harness();
  const stopOversizedFact = subscribeFeed(
    "agent-test",
    () => {},
    oversizedFact.runtime,
  );
  ready(oversizedFact.children[0]!);
  mail(
    oversizedFact.children[0]!,
    "@msg:oversized-fact",
    "x".repeat((16 * 1024) + 1),
  );
  expect(oversizedFact.children[0]!.signals).toContain("SIGKILL");
  stopOversizedFact();
});

test("readiness timeout and rapid exits back off exponentially", async () => {
  const h = harness();
  const stop = subscribeFeed("agent-test", () => {}, h.runtime);
  const first = h.children[0]!;
  const readyTimeout = h.activeTimers().find(({ delayMs }) => delayMs === 5_000);
  expect(readyTimeout).toBeDefined();
  readyTimeout!.callback();
  expect(first.signals).toContain("SIGKILL");
  first.emit("close", null, "SIGKILL");
  await settle();
  const firstRetry = h.activeTimers().find(({ delayMs }) => delayMs === 100);
  expect(firstRetry).toBeDefined();
  firstRetry!.callback();

  const second = h.children[1]!;
  second.emit("close", 1);
  await settle();
  const secondRetry = h.activeTimers().find(({ delayMs }) => delayMs === 200);
  expect(secondRetry).toBeDefined();
  stop();
});

test("readiness remains pending across pre-arm retries and resolves on the armed replacement", async () => {
  const h = harness();
  const subscription = subscribeFeed("agent-test", () => {}, h.runtime);
  const first = h.children[0]!;
  first.emit("close", 1);
  await settle();
  const retry = h.activeTimers().find(({ delayMs }) => delayMs === 100);
  expect(retry).toBeDefined();
  expect(subscription.isArmed()).toBe(false);
  retry!.callback();

  const replacement = h.children[1]!;
  ready(replacement);
  await subscription.ready;
  expect(subscription.isArmed()).toBe(true);
  subscription();
});

test("total startup budget rejects, stops, and reaps an endlessly unready feed", async () => {
  const h = harness();
  const subscription = subscribeFeed("agent-test", () => {}, h.runtime);
  const child = h.children[0]!;
  const startupTimeout = h.activeTimers().find(({ delayMs }) => delayMs === 20_000);
  const readyTimeout = h.activeTimers().find(({ delayMs }) => delayMs === 5_000);
  expect(startupTimeout).toBeDefined();
  expect(readyTimeout).toBeDefined();

  startupTimeout!.callback();
  const readinessError = await subscription.ready.catch((error) => error);
  expect(readinessError).toBeInstanceOf(LiveFeedStartupTimeoutError);
  expect(readinessError).toMatchObject({
    code: "NORTH_LIVE_FEED_STARTUP_TIMEOUT",
    timeoutMs: 20_000,
  });
  expect(subscription.isArmed()).toBe(false);
  expect(readyTimeout!.cancelled).toBe(true);
  expect(child.signals).toEqual(["SIGTERM"]);
  const killTimer = h.activeTimers().find(({ delayMs }) => delayMs === 250);
  expect(killTimer).toBeDefined();
  child.emit("close", 0);
  expect(killTimer!.cancelled).toBe(true);
  expect(h.activeTimers()).toEqual([]);
  expect(h.children).toHaveLength(1);
});

test("healthy long-running exit resets backoff and clean stop never rearms", async () => {
  const h = harness();
  const stop = subscribeFeed("agent-test", () => {}, h.runtime);
  const child = h.children[0]!;
  ready(child);
  h.setClock(30_001);
  child.emit("close", 0);
  await settle();
  const immediate = h.activeTimers().find(({ delayMs }) => delayMs === 0);
  expect(immediate).toBeDefined();
  immediate!.callback();

  const replacement = h.children[1]!;
  stop();
  expect(replacement.signals).toEqual(["SIGTERM"]);
  const killTimer = h.activeTimers().find(({ delayMs }) => delayMs === 250);
  expect(killTimer).toBeDefined();
  replacement.emit("close", 0);
  expect(killTimer!.cancelled).toBe(true);
  expect(h.activeTimers().filter(({ delayMs }) => delayMs === 0)).toHaveLength(0);
});

test("stop before readiness rejects the typed readiness proof and reaps without retry", async () => {
  const h = harness();
  const subscription = subscribeFeed("agent-test", () => {}, h.runtime);
  const child = h.children[0]!;
  const readyTimeout = h.activeTimers().find(({ delayMs }) => delayMs === 5_000);
  expect(readyTimeout).toBeDefined();

  subscription();
  const readinessError = await subscription.ready.catch((error) => error);
  expect(readinessError).toBeInstanceOf(LiveFeedStoppedBeforeReadyError);
  expect(readinessError).toMatchObject({
    code: "NORTH_LIVE_FEED_STOPPED_BEFORE_READY",
  });
  expect(subscription.isArmed()).toBe(false);
  expect(readyTimeout!.cancelled).toBe(true);
  expect(child.signals).toEqual(["SIGTERM"]);
  const killTimer = h.activeTimers().find(({ delayMs }) => delayMs === 250);
  expect(killTimer).toBeDefined();
  child.emit("close", 0);
  expect(killTimer!.cancelled).toBe(true);
  expect(h.activeTimers()).toEqual([]);
  expect(h.children).toHaveLength(1);
});

test("stop is idempotent and settles only after close and queued output processing", async () => {
  const h = harness();
  const admission = deferred<boolean>();
  const subscription = subscribeFeed(
    "agent-test",
    () => ({ consumed: admission.promise, cancel: () => {} }),
    h.runtime,
  );
  const child = h.children[0]!;
  ready(child);
  await subscription.ready;
  mail(child);
  await settle();

  const first = subscription();
  const second = subscription();
  expect(first).toBe(second);
  expect(child.signals).toEqual(["SIGTERM"]);
  let settledStop = false;
  void first.then(() => { settledStop = true; });
  child.emit("close", 0);
  await Promise.resolve();
  expect(settledStop).toBe(false);
  admission.resolve(false);
  await first;
  expect(settledStop).toBe(true);
  expect(h.children).toHaveLength(1);
});

test("stop escalates once and rejects with a typed bounded reap failure", async () => {
  const h = harness({ stopKillMs: 50, stopReapMs: 100 });
  const subscription = subscribeFeed("agent-test", () => {}, h.runtime);
  const child = h.children[0]!;
  const settlement = subscription();

  const killTimer = h.activeTimers().find(({ delayMs }) => delayMs === 50);
  const reapTimer = h.activeTimers().find(({ delayMs }) => delayMs === 100);
  expect(killTimer).toBeDefined();
  expect(reapTimer).toBeDefined();
  killTimer!.callback();
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  reapTimer!.callback();
  const error = await settlement.catch((cause) => cause);
  expect(error).toBeInstanceOf(LiveFeedReapTimeoutError);
  expect(error).toMatchObject({
    code: "NORTH_LIVE_FEED_REAP_TIMEOUT",
    timeoutMs: 100,
  });
  expect(child.stdin.destroyed).toBe(true);
  expect(child.stdout.destroyed).toBe(true);
  expect(child.unrefCalls).toBe(1);
  expect(subscription()).toBe(settlement);
});

test("subscription executes only the package-owned BB selector and ignores hostile PATH", () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "/tmp/north-hostile-path";
  try {
    const h = harness();
    const subscription = subscribeFeed("agent-test", () => {}, h.runtime);
    expect(h.children).toHaveLength(1);
    subscription();

    const untrusted = harness();
    let configurationError: unknown;
    try {
      subscribeFeed(
        "agent-test",
        () => {},
        { ...untrusted.runtime, bbExecutable: "bb" },
      );
    } catch (error) {
      configurationError = error;
    }
    expect(configurationError).toBeInstanceOf(LiveFeedConfigurationError);
    expect(configurationError).toMatchObject({
      code: "NORTH_LIVE_FEED_CONFIGURATION_INVALID",
    });
    expect(untrusted.children).toHaveLength(0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
