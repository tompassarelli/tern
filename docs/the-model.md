# The Model — Tern as one scalable graph (Tom + agents)

*Design settled 2026-06-21. Architecture: **one shared ontology, separate write
jurisdictions, one unified read view** (federated write model, unified semantic view).
Governing values are Tom's: don't conflate orthogonal concerns, and keep only metadata
that earns a function. This doc is the target; the schema deltas at the end are the diff
from today's live model.*

---

## 0. The architecture in one line

**One shared reality, separate write jurisdictions, one unified board.** ("Same map,
different traffic lanes, shared dashboard.") This is what makes it scale to hundreds
of agents *and* feel like one brain — they are not a trade-off.

- **Shared — the kernel (ontology + identity).** Node-ids, the vocabulary itself,
  validation rules, the lifecycle classifier semantics. A thread means the same thing
  everywhere; `@tom` and `@claude-code` are the same identities everywhere. One
  ontology, one identity space.
- **Separate — the write logs (jurisdictions).** Human-intent facts (your life-os:
  `committed`/`outcome`/`driver`/`owner`) live in *their* log. Swarm machine-runtime
  facts (`lease`/`heartbeat`/`epoch`/`fencing` — high-churn, disposable) live in
  *their own* log. Different lanes. **Machine churn never pollutes your canonical
  intent log** — the exact bug the review caught (a `driver` cell overloaded between
  "Tom is pushing this" and "agent holds a mutex") is structurally impossible across
  a jurisdiction boundary.
- **Unified — the read view.** You and every agent query one materialized board that
  joins all jurisdictions over the shared identities: *what's ready? what's blocked?
  what is Tom driving? what are agents holding?* — one query, one coherent graph.

You scale by adding **lanes** (write jurisdictions), never by adding contention on one
log. The graph is shared reality; the logs are jurisdictions; the board is derived
from all of them.

---

## 1. The discipline: keep orthogonal concerns orthogonal

The whole model is an exercise in *not* collapsing independent axes onto one line —
the mistake nearly every task system makes. The conflations we refuse:

| commonly conflated | kept separate here |
|---|---|
| a single `status` enum (todo/doing/blocked/done) | **separate axes**: commitment, completion, activity, blocked, schedule (§3) |
| the fact vs. its interpretation | facts are **stored**; conditions (active/ready/blocked/done) are **derived** queries, never stored labels |
| human **intent** vs. machine **mechanism** | `driver` (an actor is pushing a thread) is *not* a `lease` (a machine holds exclusive access). Different predicates, different node kinds (§4) |
| durable intent vs. ephemeral bookkeeping | threads are durable; leases/heartbeats are a TTL'd **tier** (§4) — never permanently written into the intent log |
| loose grouping vs. hard dependency | `relates_to` (association) is *not* `depends_on` (execution block). Never merged |
| composition vs. association | `part_of` (hierarchy) is *not* `relates_to` (loose) |
| identity vs. attributes | the id is an opaque stable key; the real date is `created_at`; a rename is an attribute edit on a stable id |

If a future predicate would blur one of these, that's the signal it's wrong.

---

## 2. Kinds are shapes, not labels

A node's *kind* is structural — a saved query over its shape — never a stored
`type:` field. Three kinds:

- **thread** = a node with a `title`. The unit of work or intent. (A "project" is
  just a thread with children via `part_of`; a "topic" is just a thread other
  threads `relates_to`. No separate types — same shape, different role.)
- **person / agent** = a node with a `display_name`. The actor: Tom, or an agent.
  (`name` is reserved by the kernel for the schema/predicate vocabulary, so persons
  use the domain predicate `display_name`.)
- **coordination node** = machine bookkeeping with *no title and no name* — a lease,
  a session/heartbeat. Not intent. Ephemeral. (§4)

Same graph; the shape tells you what you're looking at.

---

## 3. The thread shape — orthogonal axes, derived conditions

A thread carries several **independent** facts. None is a status; each is its own
queryable axis. A thread can be committed *and* blocked *and* scheduled-for-tomorrow
at once, and each is true separately.

| axis | the fact (stored) | the condition (derived) |
|---|---|---|
| **commitment** | `committed` (date) / `abandoned` (reason) | desired = committed ∧ ¬abandoned; canceled = abandoned |
| **completion** | `outcome` (what came of it) | done = outcome present |
| **activity** | `driver` (which actor is pushing it *now*) | active = driver present |
| **blocked** | `depends_on` (thread refs) | blocked = any target non-terminal |
| **schedule** | `do_on` (start date), `valid_until` (expiry) | dormant-until = future do_on; stale = past valid_until |
| **composition** | `part_of` (parent thread) | — (a project = thread with children) |
| **relatedness** | `relates_to` (thread refs, replaces tags) | grouping = the query "what relates_to @X" |

**The one rule the axes need (the review's soundness fix):** the axes are
orthogonal when *stored*, but a single-bucket view (`plate`, `ready`, `next`) must
pick *one* bucket per thread — so it applies one fixed **precedence**:

> terminal (`outcome`/`abandoned`) → blocked → active → ready → dormant → draft

One shared classifier function; every view calls it; two views can never disagree
(today `blocked` and `plate` disagree by 18 threads because there's no precedence —
this fixes that). Orthogonal storage, totally-ordered display.

---

## 4. The coordination tier — machine, not intent (same graph, own shape)

The swarm's *mechanics* are genuinely a different concern from a thread, so they get
their own node kind **and their own write log (the swarm jurisdiction)** — sharing the
kernel's identities and surfacing in the unified view, but never written into your
canonical intent log. They are **ephemeral** (TTL'd, garbage-collected, never durable
history).

- **lease** = `@lease:<resource>` · `holder` (agent), `epoch`, `expires_at`.
  Mutual exclusion with liveness + fencing. Replaces agentchat's BUILD-LOCK.
  **This is where the `driver`/lease conflation gets fixed: a lease is its own node
  with its own predicates; `driver` stays the activity signal on threads. They never
  share a cell again.**
- **session** = `@session:<agent>` · `agent`, `started_at`, `heartbeat`, `task`.
  Liveness/presence (online = fresh heartbeat). Replaces agentchat presence files.

These never carry `title` or `name`, so they're never mistaken for threads or
people, and a query for "real work" structurally excludes them. The scratch/probe
junk that polluted the canonical log (59 stray `driver` cells) was exactly this tier
leaking into the durable one — it goes to a scratch log, never the durable graph.

---

## 5. Pointing agents at the work (the work queue)

This is the capability you care about most, and it already exists — it *is* the
thread model:

- Agents pick up work by asking the graph **"what's `ready` and unresolved?"** —
  `ready` / `next` / `plate`, the same projections you use, filtered to a lane
  (by `owner`, or by `relates_to @some-topic`, or by `lead @themselves`).
- An agent **acquires** a thread by setting `driver @itself` (→ active). It records
  progress as it goes and `outcome` when done. `depends_on` gives execution order
  for free.
- Because the work *is* the shared graph, most of agentchat's message bus
  **dissolves** — agents coordinate *stigmergically* through thread state (acquire,
  resolve, depend) rather than by mailing each other. Directed messages shrink to a
  thin residual (a dispatch, a question) — not the backbone.

"Here's all the threads in their states of completion that need picking up" = one
query. No new primitive.

---

## 6. Why it scales — jurisdictions, not one log

Separate write logs are the scaling *mechanism*, not an afterthought:

- **Each jurisdiction is its own bounded write log + coordinator** (your life-os, the
  swarm, later a per-project domain). Adding agents = adding/load-balancing swarm-side
  write capacity — never more contention on your intent log. This is what removes the
  "buckles at ~32 hammering writers" ceiling: you don't make one log faster, you stop
  routing machine churn through it at all.
- **The high-churn tier lives in the swarm log** (heartbeats/leases at machine pace),
  TTL'd and disposable. Your durable thread log moves at human/agent *thought* pace
  and stays small.
- **Peer-local union views** — a reader (you, an agent) materializes the shared kernel
  + whatever jurisdictions it subscribes to into its own in-process index and queries
  locally. No central read bottleneck, no RPC at query time. This is the "one board."
- **The kernel is tiny** — shared identities + the vocabulary itself (predicates +
  cardinality, as facts). Jurisdictions hang off it as leaves.

You never see the lanes. You see one board that doesn't care whether it's holding 8
agents or 800. *(The substrate plumbing — per-jurisdiction logs, subject-striped
writes, retraction-aware union views — is the roadmap, tasks #2–#7, net-new and not
yet built. The model + the jurisdiction discipline are adoptable now: the swarm
already writes its own scratch log, never your canonical one.)*

---

## 7. Every predicate earns a function

"Use metadata that has gained a function." Each predicate must *do* something — gate
a derivation, answer a query, or trigger a behavior. The audit:

**Keep (load-bearing):** `title` (kind), `committed`/`outcome`/`abandoned` (lifecycle
axes), `driver` (activity), `depends_on` (blocked+order), `part_of` (hierarchy),
`relates_to` (grouping — most-used, 587), `valid_until` (staleness), `estimate_hours`
(planning), `lead` (accountability), `created_at`/`updated_at` (chronology), `repo`
(navigation), `name` (person kind), `clarifies`/`amends` (belief-revision →
needs-review).

**Make it earn it (currently has no wired function — fix):**
- `do_on` → wire to the dormancy derivation (future `do_on` ⇒ dormant, drops out of
  `ready` until its date). Today it's documented but unwired.
- `superseded_by` → wire to the terminal axis (superseded ⇒ closed) or fold into
  `abandoned`. Today it participates in no derivation.
- `name` → **materialize the ~10 real person/agent nodes** so `lead`/`driver`/
  attribution refs resolve, then turn the integrity check on. Today 0 nodes have a
  name, so every person-ref dangles and `validate` falsely passes.
- `owner` → make `personal` the *implicit default* (store `owner` only when it's a
  billable/client owner). Today it's 98.8% the constant `personal`; it earns its
  function only on the ~5 exceptions.
- `source` → keep `{tom, ai, bug}` (`ai` triggers extra scrutiny — a real function);
  drop the `migrated` value (it's history, not a fact about the thread) and the 4
  phantom unused enum members.

**Drop (no function):** `created_by` (the mechanical author is always the AI and is
already recorded by the engine's own write-provenance — merge into `proposed_by`,
the one that actually varies); `coordination` (1 use, a free-text note that belongs
in a body).

---

## 8. The changeover — agents move into the graph

Killing agentchat = relocating its three primitives into the one graph, each into
its correct kind:

| agentchat today | → its home in the graph |
|---|---|
| `mbox/` messages | the **thread graph** (acquire/resolve/depend) + a thin residual for true direct messages |
| `presence/*.md` files | **session** coordination nodes (heartbeat-derived liveness) |
| `acquire/BUILD-LOCK-*` | **lease** coordination nodes (holder/epoch/expiry/fencing) |
| swarm tasks (in agent task-trackers) | **threads** in the one graph (owner = the project, `lead`/`driver` = an agent) |

Sequence: settle the schema (this doc) → stand up the durable shared coordinator/log
→ move the swarm's coordination onto it (lease/session/threads) → cut agents off
agentchat → rip agentchat via nixos-config. The mechanism is already proven (lease,
presence, messaging, watch all built + validated); this is wiring, in order.

---

## 9. What stays exactly as you built it (affirmed)

- The **derived-lifecycle decomposition** — orthogonal axes, conditions derived not
  stored. Completeness holds (0 "homeless" threads). This is the model's spine.
- The **edge predicates** `part_of` / `depends_on` / `relates_to` — standards-aligned,
  three distinct meanings, never merged.
- **`needs-review`** (the staleness/belief-revision queue) — the soundest piece;
  it's the template for the precedence classifier.
- **Structural kinds** (title ⇒ thread, name ⇒ person) — type as shape, not label.

The defects the review found were *overlaps* (missing precedence) and *long-tail
noise* (unearned predicates, dangling refs), never the spine. The spine is right.
