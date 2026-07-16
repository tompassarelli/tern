# Agent provider architecture

North owns durable coordination; providers only execute a prepared agent run.

## Selection

`AGENT_PROVIDER=auto|anthropic|openai` selects a provider. In `auto`,
`NORTH_PROVIDER_ORDER` (default `anthropic,openai`) determines preference among
healthy adapters. `NORTH_DISABLE_ANTHROPIC=1` and `NORTH_DISABLE_OPENAI=1` are
explicit availability controls. `north providers` reports the effective state.

`anthropic` uses the Claude Agent SDK. `openai` uses the authenticated Codex CLI,
so it can use the same ChatGPT/Codex entitlement as an interactive Codex session
without requiring an OpenAI API key.

## Safety

An automatic Anthropic-to-OpenAI fallback occurs only for a quota, credit,
billing, or rate-limit error before the primary adapter emits an event. Once an
event is emitted, North cannot prove the run had no side effects and will surface
the failure instead of replaying the task.

## Contracts

Provider imports are confined to `sdk/src/providers`. The boundary is temporarily
query-shaped so North's mature watchdog, streaming, budget, clocks, worktree, and
death paths remain shared. Provider identity and the selection reason are written
to run telemetry.

The Codex CLI adapter supports local execution, streaming text/result events,
interrupt, model override for explicit OpenAI model IDs, cwd/worktrees, global
AGENTS instructions, hooks, and MCP through normal Codex configuration. Live
mid-run steering/model escalation is an Anthropic-only capability; unsupported
escalation terminates visibly rather than pretending it succeeded.
