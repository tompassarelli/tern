import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, ProviderAvailability } from "./types";

export const anthropicProvider: AgentProvider = {
  id: "anthropic",
  probe(): ProviderAvailability {
    if (process.env.NORTH_DISABLE_ANTHROPIC === "1") {
      return { provider: "anthropic", available: false, reason: "disabled" };
    }
    // The Claude Agent SDK can use Claude Code subscription auth as well as API
    // credentials. Avoid guessing quota here: runtime quota errors update routing.
    return { provider: "anthropic", available: true, reason: "ready" };
  },
  query(args) {
    return query(args) as any;
  },
};
