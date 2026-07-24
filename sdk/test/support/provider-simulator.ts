import { ProviderRetrySafeError, type AgentProvider, type AgentQuery, type ProviderId } from "../../src/providers/types";

/**
 * Hermetic provider boundary for routing and terminal tests.  It deliberately
 * models only messages North consumes; it never opens a socket or invokes a
 * provider executable.
 */
export type OfflineProviderScenario =
  | { kind: "response"; messages: readonly unknown[] }
  | { kind: "sse"; frames: readonly string[] }
  | { kind: "preaccept_failure"; reason: string }
  | { kind: "http_error"; status: number }
  | { kind: "malformed_stream"; frames: readonly string[] };

export interface CapturedProviderRequest {
  provider: ProviderId;
  target?: string;
  prompt: readonly unknown[];
  options: unknown;
}

export function anthropicTerminal(
  usage: Record<string, number>,
  subtype: "success" | "error_during_execution" = "success",
): Record<string, unknown> {
  return {
    type: "result", subtype, ...(subtype === "success" ? {} : { is_error: true }),
    result: subtype === "success" ? "simulated result" : undefined,
    usage,
  };
}

export function sseEvent(message: unknown): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

function parseSse(frames: readonly string[], complete: boolean): unknown[] {
  const messages: unknown[] = [];
  for (const frame of frames) {
    if (!frame.endsWith("\n\n")) {
      if (complete) throw new Error("offline_provider_sse_incomplete_frame");
      throw new Error("offline_provider_malformed_stream");
    }
    const lines = frame.slice(0, -2).split("\n");
    const data = lines.find((line) => line.startsWith("data: "));
    if (!data || lines.some((line) => !line.startsWith("data: ") && !line.startsWith("event: ")))
      throw new Error("offline_provider_malformed_stream");
    try { messages.push(JSON.parse(data.slice("data: ".length))); }
    catch { throw new Error("offline_provider_malformed_stream"); }
  }
  return messages;
}

async function capturePrompt(prompt: string | AsyncIterable<unknown>): Promise<unknown[]> {
  if (typeof prompt === "string") return [prompt];
  const captured: unknown[] = [];
  for await (const message of prompt) captured.push(message);
  return captured;
}

/** Deterministic, FIFO scenario source. Reusing a final scenario is intentional. */
export class OfflineProviderSimulator {
  readonly requests: CapturedProviderRequest[] = [];
  readonly closes: ProviderId[] = [];
  private readonly scenarios: Record<ProviderId, OfflineProviderScenario[]>;

  constructor(scenarios: Partial<Record<ProviderId, OfflineProviderScenario | readonly OfflineProviderScenario[]>>) {
    this.scenarios = {
      anthropic: this.queue(scenarios.anthropic),
      openai: this.queue(scenarios.openai),
    };
  }

  private queue(value: OfflineProviderScenario | readonly OfflineProviderScenario[] | undefined): OfflineProviderScenario[] {
    if (!value) return [{ kind: "response", messages: [] }];
    return Array.isArray(value) ? [...value] : [value];
  }

  provider(id: ProviderId): AgentProvider {
    const simulator = this;
    const nextScenario = (): OfflineProviderScenario => {
      const queue = this.scenarios[id];
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    };
    return {
      id,
      liveInput: id === "anthropic" ? "streaming" : "unsupported",
      probe: () => ({ provider: id, available: true, reason: "ready" }),
      query: (args): AgentQuery => {
        let closed = false;
        return {
          async *[Symbol.asyncIterator]() {
            const scenario = nextScenario();
            if (scenario.kind === "preaccept_failure") {
              throw ProviderRetrySafeError.provedUnsent(scenario.reason, {
                mode: "managed",
                source: "adapter_preflight",
                requestBytesPrepared: 0,
              });
            }
            const prompt = await capturePrompt(args.prompt);
            simulator.requests.push({ provider: id, target: args.target?.id, prompt, options: args.options });
            if (scenario.kind === "http_error") {
              const error = `offline_provider_http_${scenario.status}`;
              throw new Error(error);
            }
            const messages = scenario.kind === "response"
              ? scenario.messages
              : parseSse(scenario.frames, scenario.kind === "sse");
            for (const message of messages) yield message;
          },
          close: async () => {
            if (closed) return;
            closed = true;
            simulator.closes.push(id);
          },
        };
      },
    };
  }

  registry(): Readonly<Record<ProviderId, AgentProvider>> {
    return { anthropic: this.provider("anthropic"), openai: this.provider("openai") };
  }
}
