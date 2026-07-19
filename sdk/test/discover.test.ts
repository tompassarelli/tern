import { expect, test } from "bun:test";
import { discover, type DiscoverDependencies } from "../src/discover";
import { ProviderSelectionError } from "../src/provider-routing";
import { DispatchAlreadyActiveError } from "../src/dispatch-driver";
import { presetRequest } from "./routing-fixtures";

function dependencies(dispatch: DiscoverDependencies["dispatch"]) {
  const observations = { dispatches: 0, sleeps: [] as number[] };
  const value: DiscoverDependencies = {
    readyThreads: () => [{ id: "thread-1", title: "ready", condition: "ready" }],
    dispatch: async (thread, role) => { observations.dispatches++; return dispatch(thread, role); },
    sleep: async (ms) => {
      expect(observations.dispatches).toBe(observations.sleeps.length + 1);
      observations.sleeps.push(ms);
    },
    random: () => 0.5,
  };
  return { value, observations };
}

test("subscription exhaustion backs off and terminates instead of hot-looping", async () => {
  const { value, observations } = dependencies(async () => {
    throw new ProviderSelectionError("no_provider_available",
      "no agent provider available: anthropic=ready/exhausted, openai=ready/exhausted");
  });

  expect(await discover("test-discover", {
    routingRequest: presetRequest("implementer"), maxEmptyRounds: 3,
  }, value)).toEqual([]);
  expect(observations).toEqual({ dispatches: 3, sleeps: [2_000, 4_000, 8_000] });
});

test("repeated generic dispatch failures also consume maxEmptyRounds", async () => {
  const { value, observations } = dependencies(async () => { throw new Error("broken thread"); });

  expect(await discover("test-discover", {
    routingRequest: presetRequest("implementer"), maxEmptyRounds: 2,
  }, value)).toEqual([]);
  expect(observations).toEqual({ dispatches: 2, sleeps: [2_000, 4_000] });
});

test("driver contention falls through to the next ready thread without a second acquisition layer", async () => {
  const dispatched: string[] = [];
  const sleeps: number[] = [];
  const value: DiscoverDependencies = {
    readyThreads: () => [
      { id: "thread-contended", title: "busy", condition: "ready" },
      { id: "thread-free", title: "free", condition: "ready" },
    ],
    dispatch: async (thread) => {
      dispatched.push(thread);
      if (thread === "thread-contended") throw new DispatchAlreadyActiveError(thread);
    },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
  };

  expect(await discover("test-discover", {
    routingRequest: presetRequest("implementer"), maxTasks: 1,
  }, value)).toEqual(["thread-free"]);
  expect(dispatched).toEqual(["thread-contended", "thread-free"]);
  expect(sleeps).toEqual([]);
});

test("discovery fails closed before polling when the complete Gaffer request is absent", async () => {
  const { value, observations } = dependencies(async () => undefined);
  await expect(discover("test-discover", {} as any, value))
    .rejects.toThrow("complete eight-field Gaffer request");
  expect(observations.dispatches).toBe(0);
});
