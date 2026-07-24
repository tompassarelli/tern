import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  readAnthropicControlObservation,
  type StartAnthropicControl,
} from "../src/providers/anthropic-control";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function usageResponse() {
  return {
    subscription_type: "max", rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" },
    },
  };
}

test("usage and supportedModels share one zero-prompt isolated warm Query", async () => {
  const home = mkdtempSync(join(tmpdir(), "north-anthropic-control-home-"));
  temporary.push(home);
  let startups = 0;
  let queries = 0;
  let usageCalls = 0;
  let modelCalls = 0;
  let promptMessages = 0;
  let capturedOptions: any;
  let promptSettled: Promise<void> | undefined;
  const start: StartAnthropicControl = async ({ options }) => {
    startups++;
    capturedOptions = options;
    return {
      query(prompt: AsyncIterable<SDKUserMessage>) {
        queries++;
        promptSettled = (async () => {
          for await (const _message of prompt) promptMessages++;
        })();
        return {
          async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
            usageCalls++;
            return usageResponse();
          },
          async supportedModels() {
            modelCalls++;
            return [{ value: "fable" }];
          },
          close() {},
        };
      },
      close() {},
    };
  };
  const result = await readAnthropicControlObservation({
    target: { id: "claude-work", provider: "anthropic", authMode: "isolated", profile: "work" },
    env: { HOME: home, ANTHROPIC_API_KEY: "PRIVATE CANARY", CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE CANARY" },
    usage: true, models: true, start,
  });
  await promptSettled;
  expect({ startups, queries, usageCalls, modelCalls, promptMessages })
    .toEqual({ startups: 1, queries: 1, usageCalls: 1, modelCalls: 1, promptMessages: 0 });
  expect(result.usage?.ok).toBe(true);
  expect(result.models).toMatchObject({ ok: true, value: [{ value: "fable" }] });
  expect(capturedOptions.persistSession).toBe(false);
  expect(capturedOptions.settingSources).toEqual([]);
  expect(capturedOptions.mcpServers).toEqual({});
  expect(capturedOptions.tools).toEqual([]);
  expect(capturedOptions.systemPrompt).toBe("");
  expect(capturedOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(capturedOptions.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(capturedOptions.env.CLAUDE_CONFIG_DIR).toContain("/accounts/anthropic/work");
});

test("usage schema retry stays on the same warm Query and deadline", async () => {
  let startups = 0;
  let queries = 0;
  let calls = 0;
  const start: StartAnthropicControl = async () => {
    startups++;
    return {
      query() {
        queries++;
        return {
          async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
            calls++;
            return calls === 1 ? { transient: true } : usageResponse();
          },
          async supportedModels() { return [{ value: "fable" }]; },
          close() {},
        };
      },
      close() {},
    };
  };
  const result = await readAnthropicControlObservation({
    target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
    usage: true, models: true, start,
  });
  expect({ startups, queries, calls }).toEqual({ startups: 1, queries: 1, calls: 2 });
  expect(result.usage?.ok).toBe(true);
  expect(result.models?.ok).toBe(true);
});

test("control surfaces fail independently on the shared Query", async () => {
  const withMethods = (
    usage: () => Promise<unknown>,
    models: () => Promise<unknown>,
  ): StartAnthropicControl => async () => ({
    query: () => ({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
      supportedModels: models,
      close() {},
    }),
    close() {},
  });
  const modelSurvives = await readAnthropicControlObservation({
    target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
    usage: true, models: true,
    start: withMethods(async () => { throw new Error("PRIVATE USAGE FAILURE"); },
      async () => [{ value: "fable" }]),
  });
  expect(modelSurvives.usage).toMatchObject({ ok: false, reason: "anthropic_control_probe_failed" });
  expect(modelSurvives.models).toMatchObject({ ok: true, value: [{ value: "fable" }] });

  const usageSurvives = await readAnthropicControlObservation({
    target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
    usage: true, models: true,
    start: withMethods(async () => usageResponse(),
      async () => { throw new Error("PRIVATE MODEL FAILURE"); }),
  });
  expect(usageSurvives.usage?.ok).toBe(true);
  expect(usageSurvives.models).toMatchObject({ ok: false, reason: "anthropic_control_probe_failed" });
  expect(JSON.stringify([modelSurvives, usageSurvives])).not.toContain("PRIVATE");
});

test("an external abort reaches startup and both control surfaces without leaking its reason", async () => {
  const supervisor = new AbortController();
  let startups = 0;
  let promptSettled: Promise<void> | undefined;
  const start: StartAnthropicControl = async () => {
    startups++;
    return {
      query(prompt) {
        promptSettled = (async () => {
          for await (const _message of prompt) { /* no user message */ }
        })();
        return {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
            () => new Promise<never>(() => {}),
          supportedModels: () => new Promise<never>(() => {}),
          close() {},
        };
      },
      close() {},
    };
  };
  setTimeout(() => supervisor.abort(new Error("PRIVATE SUPERVISOR REASON")), 10);
  const result = await readAnthropicControlObservation({
    target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
    usage: true,
    models: true,
    timeoutMs: 1_000,
    signal: supervisor.signal,
    start,
  });
  await promptSettled;
  expect(startups).toBe(1);
  expect(result.usage).toMatchObject({
    ok: false, reason: "anthropic_control_probe_aborted",
  });
  expect(result.models).toMatchObject({
    ok: false, reason: "anthropic_control_probe_aborted",
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("pre-aborted and abort-during-startup probes retain exact fixed abort evidence", async () => {
  for (const phase of ["before", "during"] as const) {
    const supervisor = new AbortController();
    let startups = 0;
    if (phase === "before") supervisor.abort(new Error("PRIVATE PRE-ABORT"));
    const start: StartAnthropicControl = async () => {
      startups++;
      return await new Promise<never>(() => {});
    };
    if (phase === "during")
      setTimeout(() => supervisor.abort(new Error("PRIVATE STARTUP ABORT")), 10);
    const result = await readAnthropicControlObservation({
      target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
      usage: true,
      models: true,
      timeoutMs: 1_000,
      signal: supervisor.signal,
      start,
    });
    expect(startups).toBe(phase === "before" ? 0 : 1);
    expect(result.usage).toMatchObject({
      ok: false, reason: "anthropic_control_probe_aborted",
    });
    expect(result.models).toMatchObject({
      ok: false, reason: "anthropic_control_probe_aborted",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
});

test("an unproved lifecycle settlement invalidates otherwise successful surfaces", async () => {
  const start: StartAnthropicControl = async () => ({
    query: () => ({
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        return usageResponse();
      },
      async supportedModels() { return [{ value: "fable" }]; },
      close() {},
    }),
    close() {},
  });
  let caught: unknown;
  try {
    await readAnthropicControlObservation({
      target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
      usage: true,
      models: true,
      start,
      createLifecycle: () => ({
        spawnClaudeCodeProcess: () => { throw new Error("not used"); },
        settle: async () => { throw new Error("PRIVATE REAP FAILURE"); },
        forceKill() {},
        started: () => false,
      }),
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("anthropic_control_lifecycle_settlement_failed");
  expect((caught as Error).message).not.toContain("PRIVATE");
});
