import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../web/priv/static/js/north-agents.js", import.meta.url),
  "utf8",
);

function agentTestApi() {
  const testApi = {};
  const context = {
    clearTimeout,
    console,
    document: { addEventListener() {} },
    setInterval,
    setTimeout,
    window: { __NORTH_AGENT_TEST__: testApi, north: {} },
  };
  vm.runInNewContext(source, context, { filename: "north-agents.js" });
  return testApi;
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("a live-event burst permits one roster fetch plus one coalesced trailing fetch", async () => {
  const { createRefreshController } = agentTestApi();
  expect(typeof createRefreshController).toBe("function");

  let active = 0;
  let maximumActive = 0;
  let loads = 0;
  const releases = [];
  const load = () => {
    active += 1;
    loads += 1;
    maximumActive = Math.max(maximumActive, active);
    return new Promise((resolve) => {
      releases.push(() => {
        active -= 1;
        resolve();
      });
    });
  };

  const refresh = createRefreshController(load);
  const initial = refresh.immediate();
  for (let index = 0; index < 50; index += 1) refresh.request();
  await wait(145);
  for (let index = 0; index < 50; index += 1) refresh.request();
  await wait(145);

  expect(loads).toBe(1);
  expect(maximumActive).toBe(1);
  releases.shift()();

  for (let index = 0; index < 20 && loads !== 2; index += 1) await wait(1);
  expect(loads).toBe(2);
  expect(maximumActive).toBe(1);
  releases.shift()();
  await initial;

  expect(loads).toBe(2);
  expect(active).toBe(0);
  expect(maximumActive).toBe(1);
});

test("failed or malformed roster refreshes preserve the prior projection", async () => {
  const { loadRoster } = agentTestApi();
  const prior = [{ control_id: "lane-prior" }];
  let displayed = prior;
  let errorBodyReads = 0;

  const hostileFetchers = [
    async () => ({
      ok: false,
      async json() {
        errorBodyReads += 1;
        return { version: "north:agent-roster:v1", agents: [] };
      },
    }),
    async () => ({ ok: true, async json() { throw new Error("malformed"); } }),
    async () => ({ ok: true, async json() {
      return { version: "north:agent-roster:v0", agents: [] };
    } }),
    async () => ({ ok: true, async json() {
      return { version: "north:agent-roster:v1", agents: {} };
    } }),
  ];

  for (const fetcher of hostileFetchers) {
    const next = await loadRoster(fetcher);
    if (next !== null) displayed = next;
    expect(next).toBeNull();
    expect(displayed).toBe(prior);
  }
  expect(errorBodyReads).toBe(0);

  const valid = await loadRoster(async () => ({
    ok: true,
    async json() {
      return {
        version: "north:agent-roster:v1",
        agents: [{ control_id: "lane-current" }],
      };
    },
  }));
  expect(valid).toEqual([{ control_id: "lane-current" }]);
});
