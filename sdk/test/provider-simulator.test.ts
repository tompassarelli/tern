import { expect, test } from "bun:test";
import {
  OfflineProviderSimulator, anthropicTerminal, sseEvent,
} from "./support/provider-simulator";
import { normalizeUsage } from "../src/usage";

async function eventsOf(query: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of query) events.push(event);
  return events;
}

test("offline provider simulator captures requests and emits nonstream or SSE terminals", async () => {
  const simulator = new OfflineProviderSimulator({
    openai: { kind: "response", messages: [{ type: "result", result: "nonstream" }] },
    anthropic: { kind: "sse", frames: [sseEvent(anthropicTerminal({
      input_tokens: 11, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 5,
    }))] },
  });

  expect(await eventsOf(simulator.provider("openai").query({
    prompt: "captured", options: {}, target: { id: "codex-test", provider: "openai" },
  } as any))).toEqual([{ type: "result", result: "nonstream" }]);
  expect(await eventsOf(simulator.provider("anthropic").query({ prompt: "cache", options: {} } as any)))
    .toEqual([anthropicTerminal({ input_tokens: 11, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 5 })]);
  expect(simulator.requests).toEqual([
    { provider: "openai", target: "codex-test", prompt: ["captured"], options: {} },
    { provider: "anthropic", target: undefined, prompt: ["cache"], options: {} },
  ]);
});

test("offline provider simulator distinguishes proved preaccept failures, HTTP ambiguity, and bad streams", async () => {
  const preaccept = new OfflineProviderSimulator({
    openai: { kind: "preaccept_failure", reason: "offline_provider_unsent" },
  });
  await expect(eventsOf(preaccept.provider("openai").query({ prompt: "x", options: {} } as any)))
    .rejects.toMatchObject({ retrySafeBeforeAcceptance: true, message: "offline_provider_unsent" });

  const retry = new OfflineProviderSimulator({ openai: { kind: "http_error", status: 429 } });
  await expect(eventsOf(retry.provider("openai").query({ prompt: "x", options: {} } as any)))
    .rejects.toMatchObject({ message: "offline_provider_http_429" });

  const terminal = new OfflineProviderSimulator({ anthropic: { kind: "http_error", status: 400 } });
  await expect(eventsOf(terminal.provider("anthropic").query({ prompt: "x", options: {} } as any)))
    .rejects.toThrow("offline_provider_http_400");

  for (const frames of [["data: {bad}\\n\\n"], ["data: {}"]]) {
    const malformed = new OfflineProviderSimulator({ anthropic: { kind: "malformed_stream", frames } });
    await expect(eventsOf(malformed.provider("anthropic").query({ prompt: "x", options: {} } as any)))
      .rejects.toThrow("offline_provider_malformed_stream");
  }
});

// Terminal/usage consumer, demonstrated fully offline: the messages the simulator
// emits are fed into production `normalizeUsage`, the same authoritative-token
// consumer the spawn telemetry path drives. No socket, no provider executable.
test("simulated Anthropic terminals drive the production usage consumer offline", async () => {
  const simulator = new OfflineProviderSimulator({
    anthropic: [
      { kind: "sse", frames: [sseEvent(anthropicTerminal({
        input_tokens: 11, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 5,
      }, "error_during_execution"))] },
      { kind: "sse", frames: [
        sseEvent(anthropicTerminal({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })),
        sseEvent(anthropicTerminal({ input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })),
      ] },
    ],
  });

  const errorTerminal = await eventsOf(simulator.provider("anthropic").query({ prompt: "usage", options: {} } as any));
  const exact = normalizeUsage(errorTerminal as any, "anthropic");
  expect(exact.total).toBe(21);
  expect(exact.terminalCount).toBe(1);
  expect(exact.terminalScope).toBe("anthropic_result_terminal");
  expect(exact.totalStatus).toBe("exact");

  const repeated = await eventsOf(simulator.provider("anthropic").query({ prompt: "usage", options: {} } as any));
  const ambiguous = normalizeUsage(repeated as any, "anthropic");
  expect(ambiguous.terminalCount).toBe(2);
  expect(ambiguous.totalStatus).toBe("unknown_repeated_terminal");
  expect(ambiguous.total).toBeUndefined();
  expect(simulator.requests).toHaveLength(2);
});

test("a simulated OpenAI cumulative terminal resolves an exact total through the usage consumer", async () => {
  const simulator = new OfflineProviderSimulator({ openai: { kind: "response", messages: [{
    type: "result", result: "done",
    usage: { input_tokens: 8, output_tokens: 4, cached_input_tokens: 3, reasoning_output_tokens: 1 },
    _north_usage: {
      provider: "openai", terminal_count: 1,
      scope: "codex_fresh_invocation_thread_cumulative", total_status: "exact", total_tokens: 12,
    },
  }] } });

  const terminals = await eventsOf(simulator.provider("openai").query({ prompt: "usage", options: {} } as any));
  const usage = normalizeUsage(terminals as any, "openai");
  expect(usage.total).toBe(12);
  expect(usage.terminalScope).toBe("codex_fresh_invocation_thread_cumulative");
  expect(usage.totalStatus).toBe("exact");
});
