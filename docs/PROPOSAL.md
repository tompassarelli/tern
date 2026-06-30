# Proposal: Claim-Native Coordination System

**Working codename:** Tern *(placeholder — rename at review)*
**Status:** Draft for internal review
**Author:** Tom + Claude
**Date:** 2026-06-14

---

## 1. Summary

A self-hosted, agent-native system for coordinating work and life. The
canonical store is a **claim graph** (relational assertions), not text files
and not rows. The primary interface is an **agent you talk to** ("what's on my
plate?", "what should I work on?") that returns structured answers and keeps
the graph true with near-zero manual upkeep. It is multi-writer safe by design
so **many agents (target: 10+) can operate on the same state concurrently**.
Personal and work coordination live in one substrate, separated by *frame*, not
by a second app.

It is, bluntly, a Linear/Jira replacement whose moat is that the board stays
**grounded, auditable, and repairable** — nobody hand-maintains it; the agent
does, from your actual prose and work. Not "never wrong" — wrong only in
*recoverable, provenanced* ways, which no incumbent offers.

## 2. Why this wins (the wedge)

1. **Agent-maintained truth.** Every PM tool rots because updating it is manual
   toil. Kill the toil: you *talk*, the agent writes/updates claims. The #1
   failure mode of the category disappears.
2. **Personal + work unified.** Same claim store; `owner`/context is a *frame*
   you query from, not a separate product. One familiar way to coordinate, at
   work and at home.
3. **Relational substrate fits the domain.** PM *is* dependencies, ownership,
   blocking, provenance, "who decided what." Incumbents bolt that onto rows
   badly. We store it natively, with provenance and obligation-checking. The
   non-fungible win over "agent edits frontmatter + git" is **interning**
   (rename a person/repo once, not in 100 files) and **cross-cutting claims**
   (one decision referenced by many threads is one object, not N drifting copies).

## 3. Goals / Non-goals

**Goals**
- Claims as the single source of truth; text is anchored, never the primary key.
- Safe concurrent multi-agent operation (10+ writers) on one machine.
- Agent-native interface first; thin CLI; HTTP for clients later.
- Self-hostable, single-tenant first, multi-tenant later.
- 98%-correct prose→structure extraction is acceptable **because** text is
  always anchored and claims are re-derivable.

**Non-goals (explicit guardrails)**
- **No sentence atomization as source of truth.** We do *targeted* extraction
  into a small controlled schema, not open-ended "every clause becomes claims."
  Prose is stored as a text value; claims are a derived index over it.
- No drag-and-drop board as the primary UX.
- No distributed consensus / multi-machine write coordination in v1 (one
  coordinator process; single machine).
- No multi-tenant SaaS infra until the single-user dogfood is undeniably better
  than Linear for one real user.

## 4. Architecture

```
   agents (10+)            human (you)
       │  talk/ask              │
       ▼                        ▼
  ┌─────────────────────────────────────┐
  │  Agent interface (LLM + tools/MCP)   │  prose ⇄ structured ops
  └───────────────┬─────────────────────┘
                  │  query / assert(base_version)
                  ▼
  ┌─────────────────────────────────────┐
  │  COORDINATOR  (one warm process)     │
  │   • in-memory fold (current state)   │  ← single writer, serialized
  │   • indexes (by l / p / r)           │
  │   • entity/predicate registry        │  ← entity-linking on write
  │   • conflict + obligation rules      │  ← accept / reject at commit
  └───────────────┬─────────────────────┘
                  │ append
                  ▼
  ┌─────────────────────────────────────┐
  │  claims.log  (append-only, on disk)  │  ← persistence + full history
  │  + out-of-line text blobs (by hash)  │
  └─────────────────────────────────────┘
```

**Log = persistence. Coordinator = coordination.** Two parts, one job each.
The log is the durable truth; the coordinator is the only thing that writes to
it and the single authority on "what's true now."

## 5. Data model

```
Object   = addressable identity
Entity   = object only                       (a thread, a person, a predicate)
Value    = object + interned literal         (canonical; "Tom" is one object)
Claim    = object + (left predicate right)   ; identity = hash(l,p,r)
Assertion (log event) = (tx, op, claim-hash, frame, timestamp)
   op    = assert | retract
   frame = asserter + context (e.g. personal | client:acme)
```

- **Claims are interned by `hash(l,p,r)`** → identical content is the same claim →
  dedup, rename-in-one-place, conflict detection all work.
- **Truth is a fold, not a stored bit.** Current state = fold over assertions
  under a chosen frame/policy (default: latest-assert-wins + supersession).
- **Provenance is first-class** via `frame` on every assertion (this is also
  the personal/work seam).
- **A thread is a view, not a record:** the entity of kind `thread` plus its
  claims (`deliverable`, `owner`, `state`, `depends_on`, …) and anchored body
  text. `.md` files become a one-time import and an optional render target.

**Log line (conceptual):**
`tx42 assert <hash> thread:2026… owner person:tom personal 2026-06-14T…`
Large text values are stored out-of-line by content hash so log lines stay
small and the fold stays fast. Only the coordinator ever writes the log — there
is no multi-process append path to reason about.

## 6. Coordination & concurrency (the core requirement)

One coordinator process owns the fold and is the sole writer. Agents are
clients. "Safe" decomposes into three guarantees:

| Failure mode | Guarantee | Mechanism |
|---|---|---|
| Corruption (interleaved/torn writes) | none | single-threaded write loop; only writer |
| Staleness (acting on old state) | none | agents read the live fold, not their own copy |
| Incoherence (two valid writes → contradiction) | rejected | validate against current state + rules at commit |

**Protocol (coordinator API):**
- `query(pattern, frame) → {claims, version}`
- `assert(claims, base_version, frame) → {ack, version} | {reject, reason, current}`
- `subscribe(pattern) → stream` *(optional; live updates for agents)*

**Optimistic concurrency:** an `assert` carries the `base_version` it assumed.
If a conflicting change landed since, the coordinator rejects with the current
state; the agent re-reads and retries. No locks held across agent think-time.

**Throughput:** agents *think* in parallel (seconds); they *commit* through one
point (microseconds). Serialized commit is not a bottleneck at any realistic
agent count. (Validated in prior CNF experiments: shared daemon + serialized
writes eliminated cross-agent coordination bugs with real agents.)

## 7. Extraction pipeline (prose → claims)

Extraction is done by the LLM, **constrained**, not free-form:

1. **Targeted schema only.** Extract into a small closed operational schema
   (§8), not arbitrary triples. A small closed set is far easier to hit reliably
   than open triple extraction (the synonym-soup trap, which is banned) — but the
   real accuracy is a number to **measure, not assert** (exactly what P1.5 does),
   not a given.
2. **Entity-linking at write time.** The coordinator hands the extractor the
   **live entity/predicate registry**; new prose resolves "the auth refactor"
   to the *existing* entity instead of minting a synonym. This is the actual
   hard part, and it is load-bearing for multi-agent safety (10 agents
   extracting blind = instant fragmentation).
3. **Text is always anchored.** The verbatim prose is stored as a value;
   claims are a derived, re-buildable index over it. Therefore 98% is *safe*:
   the 2% is recoverable, auditable, and re-derivable. Never reason
   claims→claims drifting from the anchor (telephone-game / drift guard).

## 8. Operational schema (starter, controlled vocabulary)

**Entity kinds:** `thread`, `person`, `repo`, `tag`, `predicate`.

**Thread predicates (closed set, v1):**
`title`, `body`(text anchor), `state`, `owner`, `lead`, `driver`,
`depends_on`(multi), `part_of`, `deliverable`, `do_on`, `valid_until`,
`estimate_hours`, `value_financial`, `value_joy`, `tag`(multi), `source`,
`proposed_by`(multi), `created_at`, `updated_at`.

**States:** `draft | ready | active | done | canceled`.

**Conflict / obligation rules (starter):**
- *Single-valued* (`owner`, `state`, `title`, `part_of`, …): differing
  concurrent set = conflict → optimistic reject unless `base_version` matches.
- *Multi-valued* (`depends_on`, `tag`): additive; no conflict.
- *Referential integrity:* `depends_on`/`part_of` must reference existing
  entities.
- *No cycles* in `depends_on` / `part_of`.
- *Obligations:* `active` thread must have a `driver`; `depends_on` must not
  point at a `canceled` thread; (extensible).

## 9. Interfaces

- **Agent-native (primary):** tool/MCP surface the LLM calls — `query`,
  `assert`, plus high-level intents ("what's on my plate", "what should I work
  on", "mark X done"). Returns structured data; the LLM narrates.
- **CLI (secondary):** thin client for power/scripted ops over the same
  coordinator API. (Evolution of today's `los`.)
- **HTTP API (product phase):** same protocol over HTTP for web/multi-client.

## 10. Projections (derived, read-only)

Computed from the fold; never stored as truth:
- **Ready set** — non-terminal threads with all deps satisfied (actionable now).
- **Blocked** — transitive, with the upstream blockers.
- **Leverage** — threads ranked by how many stuck threads they transitively
  unblock (the "do the boring keystone first" list).
- **Agenda** — ready + leverage + scheduled (`do_on`), value-weighted (§ later).
- **Thread view / tree / by-frame (personal vs client).**

*(Phase-0 proof of these already runs over the current 142-thread corpus.)*

## 11. Tech stack

- **Language:** Beagle (emits Clojure today).
- **Coordinator:** long-lived JVM process (startup cost amortized; warm). Owns
  log + fold + rules.
- **CLI client:** native (GraalVM) for fast per-invocation startup; talks to the
  coordinator over a local socket.
- **Store, v1 (single-tenant / self-host):** append-only `claims.log` file +
  in-memory fold. Git is backup. *No database.*
- **Store, product (multi-tenant):** the **same claim model** over a real
  transactional store (Datomic / XTDB / Datahike) — earns its place only at
  multi-tenant durability scale. Model is unchanged; substrate swaps underneath.
- **Extraction:** Claude, constrained to the schema, registry-grounded.

## 12. Delivery plan

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0 — Proof** *(done)* | Graph queries over current files | ready/blocked/leverage run on 142 real threads |
| **1 — Substrate** | Claim kernel + append log + in-memory fold + coordinator (single proc, local socket); import 142 threads → claims | All Phase-0 queries run over *claims*; optimistic `assert`/reject works; round-trips to a rendered view |
| **2 — Agent + extraction** | Tool/MCP interface; targeted, registry-grounded extraction; text anchoring; "plate/next" intents | Tom runs real client + personal work through it for 2 weeks; board stays current with zero manual upkeep |
| **3 — Concurrency hardening** | Prove 10 concurrent agents safe | Conflict tests: 0 corruption, contradictions rejected, obligations enforced under load |
| **4 — Self-host** | Packaging, auth, frames (personal/work), HTTP API | A second person self-hosts and coordinates a shared thread |
| **5 — Product** | Multi-tenant store, web client, teams, billing | Design-gated; not started until Phase-2 dogfood beats Linear for Tom |

## 13. Success metrics

- **Dogfood:** Tom prefers it to Linear for real work (board-staleness ≈ 0;
  decisions surfaced — e.g. leverage list — that a flat tool can't produce).
- **Concurrency:** 10 agents, sustained concurrent asserts, 0 corruption, all
  logical conflicts detected, all obligations held.
- **Upkeep:** % of state changes authored by talking vs. manual keying → ~100%
  by talking.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Extraction reference-drift (synonym soup) | Entity-linking against live registry at write; controlled schema |
| 98% error compounding | Text always anchored; claims re-derivable; never claims→claims |
| Scope creep into sentence-atomization | Explicit non-goal; targeted schema only |
| Product is 80% non-tech (distribution, trust, workflow depth) | Dogfood-first; scope v1 ruthlessly; incumbents are the real risk, not the data model |
| Single coordinator = SPOF/bottleneck | Fine at single-node scale; product store handles durability; replication later |
| Building a product on a personal language (Beagle) | Real risk — track Beagle maturity; coordinator is the only hard dependency |
| Data loss of real work | Append-only log + anchored text + git backup; nothing overwritten |

## 15. Open decisions for review

1. **Product name** (codename Tern is a placeholder).
2. **Multi-tenant store** choice — defer to Phase 5, but flag preferences.
3. **Per-predicate conflict policy** details beyond the starter set.
4. **Value model** (`value_financial` / `value_joy`) — how/when elicited; this
   is what turns the agenda from "ready set" into "ranked happy path." Proposed:
   separate later sub-proposal; Pareto-ranked, not scalarized.
5. **Hosting posture** — self-host-first (assumed) vs. SaaS-first.
6. **Beagle vs. drop to Clojure** for the coordinator if Beagle blocks velocity.

---

*Phase 0 is done. Phase 1 is the first build: claim kernel + log + coordinator +
import. Recommend starting there on approval.*
