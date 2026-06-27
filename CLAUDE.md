# CLAUDE.md — lodestar

lodestar is the claim-native life/work app on the **fram** engine. This file is the
always-loaded surface: load-bearing rules + thin pointers. Detail lives in what it points to.

## The model in one breath
- **fram** (`~/code/fram`) = the engine. CNF: every fact is a `(subject predicate object)` triple of interned value-ids (subject/predicate/object share ONE flat content-interned id-space — purer than RDF/Datomic); lifecycle is DERIVED from claims, never a stored status.
- **lodestar** = the app: the durable thread/intent ledger served by the canonical coordinator on **:7977** (data `~/code/lodestar-data` → `~/.local/state/lodestar`).
- **One branch, always `main`** (all repos consolidated 2026-06-23 — no feature branches; a pin is a SHA, never a branch).

## Agent dispatch — SDK + thread-driven posture

Agent coordination uses the **TypeScript SDK** (`~/code/lodestar/sdk/`), not bash scripts.

- **Dispatch**: `bun run ~/code/lodestar/sdk/src/dispatch.ts <thread-id>` — reads thread claims, derives posture (unplanned/atomic/composite), injects the right prompt + tool set, streams to lodestar web.
- **Spawn**: `bun run ~/code/lodestar/sdk/src/spawn.ts <prompt>` — direct agent spawn with SDK `query()`.
- **Parallel**: `spawnParallel()` in `~/code/lodestar/sdk/src/spawn.ts` — `Promise.all` over multiple agents.
- **Work queue**: lodestar threads on **:7977** — `ready`/`next`/`leverage` to pick; claim a thread with `driver @agent`.
- **Observe/steer**: lodestar web on **:8088** — tails each agent's stream, `/steer`.
- **Concurrency lives in the engine** (the DB owns it): write-serialization + OCC + the **lease** primitive in fram's `cnf_coord.clj`.

## Write safely (claim-backed, concurrent agents)
- Session start: `lodestar doctor` → `lodestar up` if down.
- New work: `lodestar capture` — coordinator-native (asserts through the daemon, renders the `.md` FROM the log; no file-first stranding, no driver-at-birth).
- Field changes: `lodestar tell`/`untell` (serialized, rule-checked) — **never `lodestar set`** (races the log).
- **Never `lodestar export` under concurrent work** (`import` is idempotent/safe). The log is the source of truth; thread `.md` files are a regenerable projection — `doctor` distinguishes benign log-ahead lag from a real file-ahead conflict.

## Pointers
- `~/code/fleet-data/RUNBOOK.md` — fleet operating runbook (spawn/assign/steer/supervise).
- lodestar thread `2026-06-23-132319` — CNF purity + lodestar-as-client architecture.
- `~/code/fleet-consolidation-runbook.md` — engine/app/data seam-cut; remaining: the `:7978` daemon swap onto canonical-fram-with-lease (human/sudo step).
- `~/code/fram` — the engine (claim model, coordinator, lease primitive).
