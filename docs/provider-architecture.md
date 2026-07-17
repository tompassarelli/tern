# Provider accounts, routing, and usage truth

North owns durable coordination, account selection, and run evidence. Provider
surfaces execute a prepared run. Gaffer remains account-blind: it chooses the
role, composition, semantic tier, reasoning, and posture; North chooses an
eligible provider target and resolves that semantic tier through the selected
provider's model catalog.

## Subscription accounts

An account is a named routing target backed by provider-owned subscription login
state. The provider CLI owns the login flow, credential format, refresh, and
revocation. North invokes that flow inside an isolated CLI home; it never asks
for or copies credential values.

```sh
north account add claude-personal anthropic
north account login claude-personal

north account add codex-personal openai
north account login codex-personal

north account status
north account status claude-personal
north account list
north account list --verbose
north account usage
north account usage claude-personal --refresh
north providers
north providers --json
```

`add` creates the isolated home and appends the target to
`~/.config/north/routing-policy.json`. Claude homes live under
`~/.local/state/north/accounts/anthropic/<id>`; Codex homes live under
`~/.local/state/north/accounts/openai/<id>` with a separate `sqlite/` child.
North links the safe shared instructions, skills, hooks, and configuration from
`~/.claude` or `~/.codex`, while provider login state remains isolated. `status`
and `list` group accounts under `Claude / Anthropic` and `Codex / OpenAI`, showing
each account ID and its live login state. `status` exits nonzero when any selected
account is not logged in; `list` is informational. `list --verbose` adds labeled
provider, profile, and storage-root diagnostics without changing the default view.
`usage` shows normalized subscription windows, resets, observation source, and
fixed unavailability reasons per account. A failed collection is printed with
its attempt timestamp separately from the last successful usage evidence, so a
fresh failure never makes stale evidence look fresh. `providers` combines authentication,
routing eligibility, headroom, and (in balanced mode) each eligible account's
effective weight and approximate normalized auto-route share. The share is a
routing estimate, never a provider quota. The human report labels that estimate
route-unspecified: model-scoped windows can change the actual share for a
specific tier/reasoning route. `providers --json` is the stable
machine-readable status boundary; automation must not parse the human report.
Its `diagnosticRouteProbe` is one deterministic health probe for a fixed key,
not a preferred provider/account and not a prediction of the next run.

Without named accounts, the existing `~/.claude` and `~/.codex` homes are the
ambient `anthropic` and `openai` targets. Named and ambient targets use the same
routing contract. Because one ambient home is one physical subscription, North
rejects multiple ambient targets for the same provider; otherwise a single
account could be double-counted as independent allocation capacity.

## Selection and pins

Provider selection is target-first. A target is one authenticated account; a
provider may therefore have multiple sibling targets.

```sh
north spawn implementer "Add the parser regression" --tier standard
north spawn integrator "Review the migration boundary" --provider anthropic
north spawn integrator "Review the migration boundary" --target claude-personal
```

- No pin, or `--provider auto`: select from every eligible target under the
  configured allocation mode.
- `--provider anthropic` or `--provider openai`: restrict selection and any
  fallback to sibling targets owned by that provider.
- `--target <id>`: select exactly that account. An exact target pin never falls
  back to a sibling account or another provider; unavailable or exhausted means
  the spawn fails before execution.

The policy is visible and editable through one surface:

```sh
north config routing
north config routing mode preferential
north config routing order claude-personal claude-work codex-personal

north config routing mode balanced
north config routing weight claude-personal 2
north config routing weight codex-personal 1

north config routing mode reserved
north config routing reserve claude-personal
```

The allocation modes are:

- **preferential** — choose the first eligible target in configured order.
- **balanced** (default) — deterministically distribute stable run keys using
  target weights adjusted by each account's observed subscription headroom.
  Weighted rendezvous hashing gives every run a stable first choice and retry
  order without maintaining a fragile shared round-robin counter.
- **reserved** — preserve the configured target for `frontier` work when an
  alternative can handle lower tiers; use the reserve for frontier work when it
  is eligible.

Pressure is per target, not merely per provider. The states are `plenty`,
`normal`, `low`, `exhausted`, and `unknown`. Automatic observations from each
provider's subscription-usage surface are primary. An `exhausted` target is
ineligible; balanced routing uses numeric remaining headroom when available and
falls back to the categorized pressure weight when it is not. Provider/model-
specific windows constrain only routes that use that model. Failed or unknown
automatic telemetry never erases a known manual exhaustion. Successful and
failed probes are cached for five minutes per account, so concurrent spawns do
not stampede provider usage surfaces. A failed refresh is explicit unknown
knowledge and cannot revive a still-live proven exhaustion; once that exhausted
window resets it becomes unknown until a successful refresh. Categorical
fallback weights use the same zero-to-one scale as numeric remaining headroom,
so telemetry loss is never rewarded with an oversized allocation weight.
Temporary manual observations are available when the automatic view is missing
context:

```sh
north config routing pressure claude-work low
north config routing pressure codex-personal exhausted --until 2026-07-20T00:00:00Z
```

A manual observation expires after 24 hours unless `--until` is supplied.
Automatic observations are stored at
`~/.local/state/north/provider-usage-observations.json`. Resource envelopes are
separate admission limits on runs, frontier runs, retries, and parallelism; they
do not replace per-target subscription pressure.

## Proof-carrying fallback

Automatic fallback is allowed only before side effects. The provider adapter
must raise the typed `ProviderRetrySafeError`, proving that the request was not
accepted and no externally observable model or tool action occurred. North also
requires that no provider event has been emitted. It never infers replay safety
from exception text or an empty event stream.

The candidate set still obeys the caller's pin:

- auto selection may advance to another eligible account or provider;
- a provider pin may advance only to a sibling account of that provider;
- an exact target pin has no fallback candidates.

On a cross-provider fallback, North resolves the same semantic tier again through
the new provider's catalog before invocation. Once execution may have produced a
side effect, the failure is surfaced instead of replaying the task.

## Identity and routing evidence

The active route is visible in both live agent identity and immutable run facts.
Agent identity carries `provider`, `provider_target`, `model`, and `effort`; the
display label includes the target, such as `anthropic:claude-personal`. Run
telemetry records the requested and resolved route separately:

- `requested_provider`, `requested_target`, and `requested_tier` describe intent;
- `provider`, `provider_target`, `model`, and `effort` describe execution;
- `provider_reason`, `allocation_mode`, and `entitlement_pressure` explain the
  initial choice;
- `fallback_count`, `fallback_path`, and `fallback_target_path` preserve every
  proof-authorized route change.

Roster composition provenance has five deliberate states:

- `gaffer:<id>` — the named Gaffer preset was selected unchanged.
- `gaffer:<id>+override(tier,reasoning)` — the named preset was selected with
  deliberate axis changes. The ordered axes and full rationale remain separate
  facts (`composition_overrides`, `composition_override_reason`); the display
  label is only their compact projection.
- `gaffer:bespoke:<id>` — a first-class bespoke composition was selected. It
  carries responsibility, deliverable, canonical capabilities,
  authority/escalation bounds, done-bars, and report contract. `nearestPreset`
  is optional reference provenance, never a
  requirement to pretend a novel composition resembles an existing preset.
- `gaffer:not-selected` — a provider-native Claude Code or Codex session did
  not pass through North staffing. This state is valid only for native sessions.
- `gaffer:legacy-debt` — a historical or malformed managed lane lacks enough
  structured facts to prove its staffing selection. The roster never guesses
  provenance by parsing an old display label.

Every bespoke run records `promotionCandidate` (false by default; nomination is
explicit). Recurrence is visible independently of nomination. Promotion reports
only surface evidence for review; they never mutate Gaffer's library or promote
a composition without an explicit source-control change.

This division keeps Gaffer reusable across account layouts. Gaffer's canonical
staffing catalog at `~/code/gaffer/staffing/catalog.json` names roles and semantic
tiers; it contains no personal account IDs or subscription state.

## Token truth

Token totals are provider-authoritative observations, not reconstructed
estimates. Every run records how many terminal usage records were observed, the
provider scope of that observation, and whether a total is exact:

- `usage_terminal_count`
- `usage_scope`
- `usage_total_status`

The aggregate `tokens` fact exists only when the provider adapter can prove an
exact total. With no terminal record, repeated terminals, incomplete terminal
components, or an unknown adapter scope, the total stays unknown rather than
becoming zero. Exact components such as `input_tokens` or `output_tokens` may
still be retained when an aggregate is unknown. Cached-input and reasoning-output
counters are subsets of their provider totals and are never added a second time.

Reports preserve that distinction: an all-unknown set displays `unknown`; a mix
of exact and unknown runs displays the exact known lower bound with incomplete
coverage; only fully covered sets display an exact total. Historical rows that
already contain an exact aggregate remain readable.

## Adapter boundary

Provider imports remain confined to `~/code/north/sdk/src/providers`. Anthropic
uses the Claude Agent SDK; OpenAI uses the authenticated Codex CLI and its ChatGPT
subscription. Both receive the target-specific environment and shared North
supervision. Live mid-run steering and model escalation remain capability-checked:
unsupported escalation fails visibly rather than pretending it succeeded.

Every managed provider turn preflights the canonical North MCP executable and a
live coordinator, including terminal workers: missing North is a blocked
preflight, never a degraded native run. The child identity and explicit topology
must agree in both the provider environment and North MCP environment. Anthropic
SDK runs do not inherit interactive global hooks, so `harnessOptions` seals its
exact PreToolUse authoring-guard callbacks by object provenance; adapter
admission rejects a copied, missing, or mutated guard chain before constructing
the Claude query. Codex independently disables its native multi-agent surface
and restricts worker-visible North tools from the canonical capability contract,
not from optional Claude-shaped deny metadata.

The escalation ladder is provider-local and projected from Gaffer's tier
catalog at run admission. It contains concrete model IDs and declared
reasoning levels only; repeated tier boundaries are deduplicated. North then
applies the active transport's live-control ceiling (the current Claude Agent
SDK cannot set `max` in flight). An unknown or pinned route is treated as a
ceiling, never silently mapped down to a cheaper default. The temporary Fable
promotion is a bounded Anthropic runtime rung and disappears at its clock gate.
An in-flight escalation can never change providers or accounts.

## Coordination authority boundary

Topology authority is enforced on every supported North control surface: the
TypeScript SDK, `north spawn`/`dispatch`/`delegate`/`steer`/`retask`, MCP,
peer-command publication, listener reaction, map fan-out, and presence control.
A managed `worker` cannot create or command another agent, and a requested child
topology cannot elevate its caller. Ordinary completion/death mail and thread
facts remain writable because workers need to report outcomes.

This is an application authorization boundary, not a same-UID security sandbox.
Code already holding an unrestricted user shell can bypass an application by
invoking Fram's coordinator protocol directly, opening North's sockets, or
editing user-owned state. Those are unsupported integrity violations and may be
detected by audit/validation; North does not claim to make them impossible.
Hostile-code isolation requires an OS/container boundary outside this harness.
