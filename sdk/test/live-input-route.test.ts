import { expect, test } from "bun:test";
import {
  LiveFeedStartupTimeoutError,
  type FeedSubscription,
} from "../src/coordination";
import { ManagedLiveInputRoute, type ManagedRouteAxes } from "../src/live-input-route";
import { ProviderRetrySafeError } from "../src/providers/types";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function subscription(
  ready: Promise<void>,
  stop: () => void | Promise<void> = () => {},
  drain: (frozenRouteEpoch: string) => Promise<void> = async () => {},
): FeedSubscription {
  const settle = async () => { await stop(); };
  return Object.assign(settle, {
    ready,
    drain,
    isArmed: () => true,
  });
}

const initialRoute: ManagedRouteAxes = {
  provider: "anthropic",
  providerTarget: "claude-personal",
  liveInput: "streaming",
  model: "claude-opus-4-8",
  effort: "xhigh",
};

const inputAdmission = {
  consumed: Promise.resolve(true),
  cancel: () => {},
};

test("terminal unbind waits for direct feed-child settlement", async () => {
  const stopGate = deferred();
  const events: string[] = [];
  const route = new ManagedLiveInputRoute(
    "lane-await-reap",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => subscription(
      Promise.resolve(),
      async () => {
        events.push("stop");
        await stopGate.promise;
        events.push("reaped");
      },
      async () => { events.push("drain"); },
    ),
    (_agentId, facts) => { events.push(`write:${facts.liveInputState}`); },
  );
  await route.activate(initialRoute);
  let settled = false;
  const terminal = route.freezeAndUnbind().then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["write:armed", "write:frozen", "drain", "stop"]);
  expect(settled).toBe(false);
  stopGate.resolve();
  await terminal;
  expect(events).toEqual([
    "write:armed",
    "write:frozen",
    "drain",
    "stop",
    "reaped",
  ]);
});

test("streaming route publishes armed only after feed readiness", async () => {
  const gate = deferred();
  const writes: any[] = [];
  const route = new ManagedLiveInputRoute(
    "lane-ready",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => subscription(gate.promise),
    (_agentId, facts) => { writes.push(facts); },
  );
  expect(route.initialProjection().liveInputState).toBe("pending");
  const activation = route.activate(initialRoute);
  await Promise.resolve();
  expect(writes).toHaveLength(0);
  gate.resolve();
  await activation;
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    liveInput: "streaming",
    liveInputState: "armed",
  });
  expect(writes[0].liveInputEpoch).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("readiness failure is retry-safe before route publication", async () => {
  let stops = 0;
  const writes: any[] = [];
  const route = new ManagedLiveInputRoute(
    "lane-timeout",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => subscription(
      Promise.reject(new LiveFeedStartupTimeoutError(30_000)),
      () => { stops++; },
    ),
    (_agentId, facts) => { writes.push(facts); },
  );
  const error = await route.activate(initialRoute).catch((cause) => cause);
  expect(error).toBeInstanceOf(ProviderRetrySafeError);
  expect(error.message).toBe("live_input_feed_unavailable_before_acceptance");
  expect(writes).toHaveLength(0);
  expect(stops).toBe(1);
});

test("armed publication failure is fatal and stops the uncommitted feed", async () => {
  let stops = 0;
  const route = new ManagedLiveInputRoute(
    "lane-publication-fails",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => subscription(Promise.resolve(), () => { stops++; }),
    () => { throw new Error("route commit failed"); },
  );
  const error = await route.activate(initialRoute).catch((cause) => cause);
  expect(error).not.toBeInstanceOf(ProviderRetrySafeError);
  expect(error.message).toBe("route commit failed");
  expect(stops).toBe(1);
});

test("lost-ack recovery commits armed locally and preserves the already-ready feed", async () => {
  let stops = 0;
  const states: string[] = [];
  const route = new ManagedLiveInputRoute(
    "lane-lost-ack-recovered",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => subscription(
      Promise.resolve(),
      () => { stops++; },
      async () => {},
    ),
    (_agentId, facts) => {
      states.push(facts.liveInputState!);
      return {
        status: "committed",
        operationId: `test-operation-${states.length}`,
        reason: states.length === 1 ? "exact_replay" : undefined,
      };
    },
  );
  await route.activate(initialRoute);
  expect(states).toEqual(["armed"]);
  expect(stops).toBe(0);
  await route.freezeAndUnbind();
  expect(states).toEqual(["armed", "frozen"]);
  expect(stops).toBe(1);
});

test("armed streaming route permanently refuses unsupported fallback", async () => {
  const events: string[] = [];
  const route = new ManagedLiveInputRoute(
    "lane-no-downgrade",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => subscription(Promise.resolve(), () => { events.push("stop"); }),
    (_agentId, facts) => { events.push(`write:${facts.liveInputState}`); },
  );
  await route.activate(initialRoute);
  const error = await route.beforeFallback(
    {
      fromTarget: "claude-personal",
      fromProvider: "anthropic",
      fromLiveInput: "streaming",
      toTarget: "codex-personal",
      toProvider: "openai",
      toLiveInput: "unsupported",
    },
    async () => { events.push("reserve"); },
  ).catch((cause) => cause);
  expect(error).toBeInstanceOf(ProviderRetrySafeError);
  expect(error.message).toBe(
    "live_input_fallback_refused_after_streaming_route_armed",
  );
  expect(events).toEqual(["write:armed"]);
});

test("streaming sibling fallback freezes before unbind and re-arms a fresh epoch", async () => {
  const events: string[] = [];
  const epochs: string[] = [];
  let subscriptionNumber = 0;
  const route = new ManagedLiveInputRoute(
    "lane-streaming-sibling",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => {
      const current = ++subscriptionNumber;
      return subscription(
        Promise.resolve(),
        () => { events.push(`stop:${current}`); },
        async () => { events.push(`drain:${current}`); },
      );
    },
    (_agentId, facts) => {
      events.push(`write:${facts.liveInputState}:${facts.providerTarget}`);
      epochs.push(facts.liveInputEpoch!);
    },
  );
  const initialEpoch = route.initialProjection().liveInputEpoch;
  await route.activate(initialRoute);
  await route.beforeFallback(
    {
      fromTarget: "claude-personal",
      fromProvider: "anthropic",
      fromLiveInput: "streaming",
      toTarget: "claude-work",
      toProvider: "anthropic",
      toLiveInput: "streaming",
    },
    async () => { events.push("reserve"); },
  );
  await route.activate({
    ...initialRoute,
    providerTarget: "claude-work",
  });
  await route.freezeAndUnbind();
  expect(events).toEqual([
    "write:armed:claude-personal",
    "write:frozen:claude-personal",
    "drain:1",
    "stop:1",
    "reserve",
    "write:armed:claude-work",
    "write:frozen:claude-work",
    "drain:2",
    "stop:2",
  ]);
  expect(new Set([initialEpoch, ...epochs]).size).toBe(5);
});

test("two failed durable freeze attempts still unbind the live transport exactly once", async () => {
  let stops = 0;
  let frozenAttempts = 0;
  const route = new ManagedLiveInputRoute(
    "lane-double-freeze-failure",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => subscription(Promise.resolve(), () => { stops++; }),
    (_agentId, facts) => {
      if (facts.liveInputState === "frozen") {
        frozenAttempts++;
        throw new Error(`freeze commit failed ${frozenAttempts}`);
      }
    },
  );
  await route.activate(initialRoute);

  const first = await (async () => {
    try {
      await route.freezeAndUnbind();
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  const second = await (async () => {
    try {
      await route.freezeAndUnbind();
      return undefined;
    } catch (error) {
      return error;
    }
  })();

  expect(first).toBeInstanceOf(Error);
  expect((first as Error).message).toBe("freeze commit failed 1");
  expect(second).toBeInstanceOf(Error);
  expect((second as Error).message).toBe("freeze commit failed 2");
  expect(frozenAttempts).toBe(2);
  expect(stops).toBe(1);
});

test("a failed drain retry earns a fresh settlement-feed barrier", async () => {
  const events: string[] = [];
  let feeds = 0;
  const route = new ManagedLiveInputRoute(
    "lane-drain-retry",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => {
      const feed = ++feeds;
      return subscription(
        Promise.resolve(),
        () => { events.push(`stop:${feed}`); },
        async () => {
          events.push(`drain:${feed}`);
          if (feed === 1) throw new Error("first drain failed");
        },
      );
    },
    (_agentId, facts) => { events.push(`write:${facts.liveInputState}`); },
  );
  await route.activate(initialRoute);
  await expect(route.freezeAndUnbind()).rejects.toThrow("first drain failed");
  await route.freezeAndUnbind();
  expect(events).toEqual([
    "write:armed",
    "write:frozen",
    "drain:1",
    "stop:1",
    "drain:2",
    "stop:2",
  ]);
});

test("a freeze-write failure retry settles through a fresh feed", async () => {
  const events: string[] = [];
  let feeds = 0;
  let frozenWrites = 0;
  const route = new ManagedLiveInputRoute(
    "lane-freeze-retry",
    { kind: "lane" },
    initialRoute,
    () => inputAdmission,
    () => {
      const feed = ++feeds;
      return subscription(
        Promise.resolve(),
        () => { events.push(`stop:${feed}`); },
        async () => { events.push(`drain:${feed}`); },
      );
    },
    (_agentId, facts) => {
      events.push(`write:${facts.liveInputState}`);
      if (
        facts.liveInputState === "frozen"
        && ++frozenWrites === 1
      ) throw new Error("first freeze write failed");
    },
  );
  await route.activate(initialRoute);
  await expect(route.freezeAndUnbind()).rejects.toThrow(
    "first freeze write failed",
  );
  await route.freezeAndUnbind();
  expect(events).toEqual([
    "write:armed",
    "write:frozen",
    "stop:1",
    "write:frozen",
    "drain:2",
    "stop:2",
  ]);
});
