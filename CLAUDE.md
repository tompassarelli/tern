# CLAUDE.md — tern

tern is the fact-native life/work app on the **fram** engine. This file is the
always-loaded surface: load-bearing rules + thin pointers. Detail lives in what it points to.

## The model in one breath
- **fram** (`~/code/fram`) = the engine. Store layer: every fact is a `(subject predicate object)` triple of interned value-ids (subject/predicate/object share ONE flat content-interned id-space — purer than RDF/Datomic); lifecycle is DERIVED from facts, never a stored status.
- **tern** = the app: the durable thread/intent ledger served by the canonical coordinator on **:7977** (data `~/code/tern-data` → `~/.local/state/tern`).
- **One branch, always `main`** (all repos consolidated 2026-06-23 — no feature branches; a pin is a SHA, never a branch).

## Agent dispatch — SDK + thread-driven posture

Agent coordination uses the **TypeScript SDK** (`~/code/tern/sdk/`), not bash scripts.

- **Dispatch**: `bun run ~/code/tern/sdk/src/dispatch.ts <thread-id>` — reads thread facts, derives posture (unplanned/atomic/composite), injects the right prompt + tool set, streams to the web client.
- **Spawn**: `bun run ~/code/tern/sdk/src/spawn.ts <prompt>` — direct agent spawn with SDK `query()`.
- **Parallel**: `spawnParallel()` in `~/code/tern/sdk/src/spawn.ts` — `Promise.all` over multiple agents.
- **Work queue**: tern threads on **:7977** — `ready`/`next`/`leverage` to pick; acquire a thread with `driver @agent`.
- **Observe/steer**: web client on **:8088** — tails each agent's stream, `/steer`.
- **Concurrency lives in the engine** (the DB owns it): write-serialization + OCC + the **lease** primitive in fram's `coord.clj`.

## Write safely (fact-backed, concurrent agents)
- Session start: `tern doctor` → `tern up` if down.
- New work: `tern capture` — coordinator-native (asserts through the daemon, renders the `.md` FROM the log; no file-first stranding, no driver-at-birth).
- Field changes: `tern tell`/`untell` (serialized, rule-checked) — **never `tern set`** (races the log).
- **Never `tern export` under concurrent work** (`import` is idempotent/safe). The log is the source of truth; thread `.md` files are a regenerable projection — `doctor` distinguishes benign log-ahead lag from a real file-ahead conflict.

## Pointers
- tern thread `2026-06-23-132319` — store-layer purity + tern-as-client architecture.
- `~/code/fram` — the engine (fact model, coordinator, lease primitive).
