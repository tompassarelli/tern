# threads/ — manual

> **⚠️ MODEL CHANGED 2026-06-15 — fact-native cutover.** This manual now
> describes the current model. What changed (full spec:
> `docs/fact-native-redesign.md`):
> - **One project/CLI/engine: `north`.** `los thread`/`los validate` are
>   **retired** — use `north` (ready/blocked/next/agenda/board/show/leverage/
>   validate/capture/tell/retract/import/export/audit/doctor/up). Time tracking is
>   **`north clock`** (fact-native sessions; `los time` and the JSON clock-in
>   are gone — Clockify is just a sync target now).
> - **Thread files are FACT TRIPLES, not YAML.** `@<id>` subject + `predicate
>   object` lines + `---` + prose body. Refs are `@id`; literals are EDN.
> - **No `state` enum.** Lifecycle is *derived* from facts: `committed`,
>   `outcome` (done), `abandoned` (canceled, reason inline), `driver` (active),
>   `depends_on` (blocked). A thread = any id with a `title`.
> - **No `tags`.** Relatedness is `relates_to @<thread>` (former tags are now
>   `@topic-*` threads).
> - **ids** are `2026-06-15-150040` (dashed, fixed-width).
> - Rollback: git tag `pre-fact-native` (both repos).

This directory is the canonical thread layer for north. Read this before
creating, mutating, or interpreting any thread file here. The full spec lives at
`docs/fact-native-redesign.md`; this file is the working manual — the
rules an editor (human or AI) needs in front of them to act correctly.

---

## What this directory is

A flat directory of files, one per thread, each rendering a thread's **fact
triples** plus a prose body. Filenames are for navigation; the `@<id>` subject
line is canonical identity.

**The source of truth is the North fact graph** (`north-data/facts.log`), not the
files. The `threads/*` files are a *faithful projection* of the facts, regenerated
by `north export`; the import↔export round-trip is lossless (fact-identical), so
you can still edit a file and `north import` folds the edit back into the graph.
If a tool and the files disagree, reconcile through the fact log — `import` to
absorb file edits, `export` to regenerate files — and the fact graph wins.
(Pre-cutover state is recoverable at git tag `pre-fact-native`;
the pre-graph markdown era is at `pre-north-flip`.)

This is not a project-management app. It is a thought-to-state substrate for a
solo operator. Most "tasks" in normal PM tools are too small to be threads. Most
"projects" are too big. The thread primitive sits in between and scales both
directions.

---

## The primitive is `thread`

There is no `task`, no `project`, no `epic`. A thread is a durable record of
intended or possible action. A thread may be:

- task-sized
- project-sized
- a research thread
- a deliverable
- a life intention
- a speculative idea
- a container for other threads
- a **topic** (a `@topic-*` node former-tags point at — see below)

**Structurally, a thread is any node that has a `title`.** There is no type tag,
no prefix, no `type:` field. "thread" is a *shape* (has a title), not a stored
label. Likewise a **person** is a node that has a `display_name` (the `@handle` nodes; `name` is a reserved engine/schema predicate).

A "project view" is *derived* from threads, not modeled as a distinct thing:

- root threads (no `part_of`) under a given owner
- the subtree rooted at one thread via `part_of`
- everything that `relates_to @X` — the graph query that replaces tag-grouping

Resist the urge to add taxonomy. If a new predicate or edge type seems
necessary, the rule is **complexity must be earned** — observe the need across
multiple real cases before adding it. (And note: adding a predicate is *free* in
the new model — there is no field parser to touch — so the bar is "is this a real
recurring fact," not "can the tool hold it.")

---

## File format

Each thread is one file: a leading `@<id>` subject line, then `predicate object`
lines (two spaces between), then a `---` separator, then the prose body. Same
shape as the fact log.

```
@2026-06-15-150040
title       "Pick back up: gjoa + reference/lean work"
owner       personal
lead        @tom_passarelli
source      tom
proposed_by @tom_passarelli
created_by  @claude-code
created_at  2026-06-15
updated_at  2026-06-15
committed   2026-06-15
do_on       2026-06-15
repo        ~/code/gjoa
relates_to  @2026-06-14-140000

## Goal

Resume the gjoa + reference/lean work. Pick it back up later today.

## Log

2026-06-15 — captured via `north capture`.
```

### Refs vs literals (`@` sigil)

A value's *kind* is syntactic, marked by the `@` sigil — orthogonal to its role:

- **`@<id>`** is a **ref** to a node (a thread, a person, a topic). Examples:
  `lead @tom_passarelli`, `relates_to @topic-gjoa`, `part_of @2026-05-27-041352`.
- **anything else is an EDN literal**: a bare token (`owner personal`,
  `source tom`), a bare date (`committed 2026-06-15`), a number
  (`estimate_hours 3`), a path (`repo ~/code/gjoa`), or a quoted string when it
  needs spaces/punctuation (`title "Pick back up: gjoa work"`,
  `abandoned "superseded by the new plan"`).

Quote a literal only when it contains spaces or characters EDN would otherwise
choke on. Titles, multi-word reasons, and free prose objects get quotes;
single-token values don't. Round-trip uses the log's EDN reader/writer, so the
old YAML quoting/injection bug class cannot occur — but get the quoting right so
`import` reads what you meant.

### The predicate vocabulary

Predicates are just facts; there is no fixed schema of "fields." These are the
ones in live use (run `north show <id>` on a few real threads to see them):

| predicate      | object kind         | meaning                                                            |
|----------------|---------------------|--------------------------------------------------------------------|
| `title`        | string literal      | human-readable title. **Its presence is what makes a node a thread.** |
| `owner`        | literal             | the entity the thread serves (`personal`, a client like `acme`, …) |
| `lead`         | person ref `@h`     | person accountable for the thread landing                          |
| `driver`       | person/agent ref    | who is *currently* pushing it (presence ⇒ derived **active**)      |
| `source`       | literal             | where it originated (`tom`, `ai`, `stakeholder`, `client`, `bug`, `observation`, `system`, `migrated`) |
| `proposed_by`  | person ref(s)       | conceptual originator(s); repeat the line for shared authorship    |
| `created_by`   | person/agent ref    | mechanical author of the record                                    |
| `created_at`   | bare date           | when the thread was created (the *real* date; the id is opaque)    |
| `updated_at`   | bare date           | last substantive edit                                              |
| `committed`    | bare date           | **accepted / in-play.** Present ⇒ desired (unless abandoned). The default for a fresh capture. |
| `outcome`      | string literal      | **done.** The object states what came of it. Presence ⇒ derived **done**. |
| `abandoned`    | string literal      | **canceled.** The object is the reason, inline (`abandoned "migrated: canceled"`). Presence ⇒ derived **abandoned**. |
| `depends_on`   | thread ref(s)       | execution dependency. Blocked while any target is non-terminal.    |
| `part_of`      | thread ref          | composition edge; parent thread. A "project" is a thread with children. |
| `relates_to`   | thread ref(s)       | loose relatedness — an edge to a **real** thread (often `@topic-*`). Replaces tags. |
| `repo`         | path literal(s)     | `~/code/<dir>` paths tied to the thread; repeat the line per repo  |
| `do_on`        | bare date           | day Tom intends to act; thread is dormant before it                |
| `valid_until`  | bare date           | expiry; thread is stale/expired past it if not terminal           |
| `estimate_hours`| number             | the only size signal                                               |
| `superseded_by`| thread ref          | replaced by another thread                                         |

To assert a **multi-valued** predicate (`relates_to`, `depends_on`, `repo`,
`proposed_by`), repeat the line — one fact per value. There are no YAML lists.

There is **no** canonical field order to memorize and no required-field
ceremony beyond `title`. `north export` writes a stable order; hand-edits
that go through `import` get re-normalized on the next `export`.

### Schema-as-facts: predicates are entities

Predicate metadata is **not** a fixed table or an env list — it lives IN the log
as facts about the predicate, which is itself an entity with subject `@<pred>`:

- `@<pred> cardinality single|multi` — a single-valued predicate replaces its
  value on re-assert; a multi-valued one accumulates. Default (no fact) is
  **multi**.
- `@<pred> value_kind ref|literal` — `ref` objects are `@`-prefixed thread refs;
  `literal` is the default (its fact is omitted).
- `@<pred> acyclic true` — the edge may not form a cycle (`depends_on`, `part_of`).

Precedence when the engine classifies a predicate is **fact > env > legacy
fallback**: a `cardinality` fact in the log wins over the `FRAM_SINGLE_VALUED`
env list, which wins over the built-in default. Read a predicate's metadata the
same way you read any thread — `north show <pred>` (e.g. `north show title`).

`north schema-seed` derives the seed set from today's vocab + the live log, then
prints it (`--dry-run`, the default) or writes it through the coordinator
(`--execute`): `cardinality single` for every `FRAM_SINGLE_VALUED` predicate,
`acyclic true` for `depends_on`/`part_of`, and `value_kind ref` for predicates
whose live objects are all `@`-refs. It aborts loudly if a predicate name
collides with a live thread id (writing `@title` metadata onto a real thread
titled "title" would pollute it). This is the migration path off the env list:
seed the facts once, and the log carries what `FRAM_SINGLE_VALUED` used to.

`north schema` is the **read** side — a standing vocabulary census that answers
"what schemas exist in north?" from one live fold. It groups every subject into an
**entity kind** and reports per-kind subject + live-fact counts, the top
predicates in each, and the declared predicate metadata
(`cardinality`/`value_kind`/`acyclic`). Kind is derived by: an explicit `kind`
fact wins; else a reserved namespace in the subject id (`concern-`, `agent:`,
`msg:`, `topic-`, `mine:`, and the `session:`/`run-`/`sess-`/… telemetry
prefixes); else a `title` means `thread`; else a schema-as-facts subject is a
`predicate`; else `other`. Buckets sort by fact count, so the biggest blobs name
themselves — today the `session-telemetry` bulk dwarfs the work graph, which is
the number that drives the log split below.

The AI tool surface reflects this. `north tools` lists NORTH's **curated** verbs
(the MCP surface: `ready`/`next`/`board`/…/`tell`/`show`/`dispatch`/`spawn`);
the fram engine core underneath is **10 tools** (`tell`/`retract`/`show`/`ask`/
`validate` + 5 graph-edit verbs). Vocabulary is data, not tools — there is no
per-predicate tool catalog to memorize; `north show <pred>` reveals a predicate.

### The log split — telemetry stays out of the coordination log

Facts are written to one of **two append logs**. The coordination log (this
directory's `facts.log`) holds work/intent threads and their schema. Experiment
runs, telemetry, benchmark samples, and other high-volume machine output are
routed to a **separate** telemetry log, never the coordination log. Mixing them
would bury the work graph under machine noise and drag every fold/validate over
data that isn't about coordination. Keep the coordination log small and
human-meaningful; give telemetry its own log.

Every new entity **self-identifies its kind at birth**: `north capture` stamps
`kind thread` in the same coordinator write batch (`kind` is single-valued;
concern-cli already stamps `kind concern`, telemetry writers `kind run`/`session`).
No backfill — old subjects stay un-kinded and fall to the census's prefix
heuristic; the kinded set grows forward. This is the seam the log split rides
on: once entities carry their kind, `north schema` counts each log's mass
exactly, and moving telemetry to its own log is a filter on a fact, not a guess.
(One open overlap to reconcile: reflection entities also use `kind`
document/decision/observation — see the reflections section — so a reflection
captured via `north capture` starts `kind thread` and must be re-told its
reflection kind; a follow-up should decide whether entity-kind and reflection-kind
are one predicate or two.)

### ids and filenames

The id is `2026-06-15-150040` — `yyyy-MM-dd-HHmmss`, dash-separated,
fixed-width. It is **safe inside `@`-refs, filenames, EDN, and grep**, and
glanceable, but it is an **opaque key**: the date you care about is `created_at`,
not the id. Fixed width means the id↔slug split is by position, not first-dash.

- The `@<id>` subject line inside the file is the dashed form.
- The on-disk filename pairs the id with a snake_case slug. (Current corpus
  filenames render the id run-together —
  `20260615150040-pick_back_up_gjoa_reference_lean_work.md` — while the `@id`
  *inside* is dashed. The id inside the file is canonical; let `north export`
  own filenames rather than hand-renaming.)
- The id never changes. The slug portion may be renamed (rare); the id stays put.
- Hand-minting an id: `date +%Y-%m-%d-%H%M%S`. But prefer `north capture`,
  which mints it for you.
- `north show <input>` resolves by id, then slug, then substring — so
  `north show gjoa` finds the gjoa thread.

References in `part_of`/`depends_on`/`relates_to`/`superseded_by` are `@<id>`
refs. Prose in the body can reference another thread however reads best
(`[[2026-06-15-040220]]` is common); the engine doesn't parse the body, but
readers do.

---

## Lifecycle is derived, not stored

**There is no `state` enum.** `draft`/`ready`/`active`/`done`/`canceled` are
*not* values you write anywhere. A thread's condition is a **query over its
facts** along orthogonal axes:

| axis                     | how it's derived                                                     |
|--------------------------|---------------------------------------------------------------------|
| commitment / desire      | `committed` present (and no `abandoned`) ⇒ accepted and wanted       |
| completion               | `outcome` present ⇒ done                                             |
| cancellation             | `abandoned` present ⇒ canceled (reason is the object)               |
| activity (cycles)        | a `driver` set / a clock running *now* ⇒ active; else dormant       |
| blocked (cycles)         | any `depends_on` target not yet terminal ⇒ blocked                  |

The derived conditions you'll actually use (all `north` projections):

- **ready** = committed ∧ not blocked ∧ not active ∧ no outcome
- **blocked** = a `depends_on` target is still open
- **active** = has a `driver` (or a live clock) now
- **dormant** = committed ∧ not active ∧ not done ∧ not abandoned (the "wanted but
  resting" case the old enum had no honest home for)
- **done** = `outcome` present
- **abandoned** = `abandoned` present
- **desired** = committed ∧ not abandoned

So lifecycle is moved by **adding facts**, not by editing a status field:

- Capturing creates a `committed` thread (accepted, in-play) by default.
- To pick it up, add a `driver` → it's active. To set it down, drop the driver
  → it goes dormant; the commitment survives. (No `paused` state — dormant *is*
  paused, derived.)
- To finish: add `outcome "<what came of it>"`.
- To cancel: add `abandoned "<reason>"`. The reason lives inline in the object.
- For a speculative capture you haven't accepted yet, simply **omit
  `committed`** (the old `draft`). Once it earns commitment, add `committed`.

---

## Done-bars

A thread is "done" when `outcome` is present — but **done is a judgment, and
judgments need evidence.** Done-bars make the evidence model explicit.

### Schema

Two predicates, both `cardinality multi`, `value_kind literal`:

| predicate      | cardinality | phrasing convention                                          |
|----------------|-------------|--------------------------------------------------------------|
| `done_when`    | multi       | "probe + expected result" — e.g. `"north validate exits 0"`, `"firn build + validate green"`, `"smoke test passes on staging"` |
| `bar_evidence` | multi       | observed probe result — e.g. `"north validate → exit 0 2026-07-11"` |

One fact per criterion; repeat the line for multiple bars. `north schema thread`
shows these predicates' metadata once declared in the log.

### Friction gradient

| moment            | behavior                                                                                         |
|-------------------|--------------------------------------------------------------------------------------------------|
| **capture**       | Zero ceremony — no bars required. A thought deserves a shelf without bureaucracy.                |
| **commit/dispatch** | Bars expected. `north dispatch` warns visibly when a committed thread has no `done_when` facts and injects "define your own done bar as first act" into the worker contract. Barred threads get their bars injected verbatim into the worker brief. |
| **outcome**       | `north tell <id> outcome ...` on a barred thread **echoes the bars** at write time — a reminder, never a reject. The gate teaches; it never blocks a human closing their own thread. |
| **needs-review**  | Surfaces (i) committed+driven threads without any `done_when`, and (ii) outcomes written on barred threads whose bars lack evidence — each bar marked ✓/○. |

### Evidence model

A bar is EVIDENCED in the human thread review view when some `bar_evidence` fact
quotes the bar. That mutable projection is useful context, but it is not managed
delivery proof. Its review grammar is:
`"<exact bar> → <nonempty observed result>"`. The exact bar must begin the
evidence string; incidental substring overlap is not review evidence.

`needs-review` (and the outcome-time echo) mark each bar ✓ (quoted by evidence)
or ○ (open); an outcome over any ○ bar surfaces as `n/m bar(s) evidenced`.
Partial evidence surfaces but never blocks a human judgment.

Managed lanes preserve a stronger run-scoped delivery projection:

1. North generates the run ID and a random capability **before** provider
   execution. It commits a fresh reservation naming the exact run, title-bearing
   thread, and
   reporter, plus the canonical starting `done_when` set and whether that
   contract is `accepted` or `worker-defined`; only the capability hash enters
   the graph. The capability reaches the exact child and its North MCP process
   through an explicit per-run environment, never by mutating the parent process
   environment; nested children scrub all parent run bindings before receiving
   a fresh explicit context or none. If reservation publication fails, North does not reuse that
   possibly partial subject: the child receives no delivery capability,
   delivery remains `unverified`, and final telemetry rotates to a fresh
   telemetry-only run ID.
2. Existing `done_when` facts are the accepted reservation contract. Reported
   finalization requires the current canonical set to equal that exact baseline;
   if none existed at dispatch, the worker may define bars as its first act and
   the proof records
   `contractOrigin=worker-defined` explicitly.
3. After running a probe, the managed worker records the exact bar and observed
   result:

   ```sh
   north evidence record "<exact done_when>" "<observed result>"
   ```

   Run, thread, and reporter are not command arguments. The writer derives them
   from the managed environment, checks the reservation capability, confirms the
   bar is active on the reserved thread, and records a strict-timestamped
   `run_bar_evidence` object on that run. Those scoped checks and the evidence
   append share one version-bound commit seam; once `kind=run` publishes, the
   supported writer can no longer add new evidence. An exact replay remains
   idempotently available to heal the non-authoritative thread projection.
4. When every immutable bar has exact evidence from that run/reporter, North
   commits a v2 snapshot on the lane and run:
   `delivery=reported`. The snapshot contains only mechanically bound proof:
   exact run/thread/reporter, reservation-bound contract origin and starting
   `done_when`, the current canonical bars, and their stored run evidence.
   Mutable thread evidence, thread outcomes, capture timestamps, and other
   narrative context are deliberately absent. Before exposing the lane terminal
   marker, the writer captures a coordinator version, re-reads the named
   reservation and current canonical thread contract, and commits the marker
   only against that exact version. A racing graph write rejects the marker and
   forces the complete validation to run again. The run writer uses the same
   compare-and-commit boundary before its own marker. Both refuse
   baseline/origin drift plus missing, fabricated, or cross-agent cited records.
   If the reservation is missing or invalid at finalization, North rotates final
   telemetry to a fresh unreserved run instead of losing the run to a poisoned
   reserved subject.
   This proves equality at reservation and each terminal commit boundary; it
   does not claim that a remove-and-readd transient absent from the current fact
   set never occurred. The supported writer and terminal validator reject
   cross-run/thread/reporter credit. A successful process without this proof is
   `delivery=unverified`; a failed process is `delivery=blocked`.
5. `reported` is currently the highest mechanically enforceable state. Managed
   lanes share one OS uid and Fram's loopback wire accepts generic assertions.
   The reservation capability therefore prevents accidental/generic North CLI
   misuse and supplies scoped correlation; it is not an unforgeable boundary
   against another same-UID process, which can inspect peer state or speak the
   coordinator protocol directly. `reported` is explicitly same-UID
   self-report and never qualifies a Gaffer promotion. Likewise, `AGENT_ID` is
   provenance rather than an unforgeable independent-verifier identity, so
   `north delivery attest` fails closed. Historical attestation envelopes may
   be inspected as legacy data, but they do not validate a current `verified`
   terminal. An isolated daemon-issued verifier capability or parent-verifiable
   protected record operation is required before that state can return.

Routing reports join a reported lane terminal to a run only when the snapshot
names that exact run, thread, and reporter. Historical/current mutable thread
facts remain review context; they never silently upgrade delivery.

### Example

```
north tell 2026-07-11-120000 done_when "north validate exits 0"
north tell 2026-07-11-120000 done_when "firn build + validate green"
north tell 2026-07-11-120000 bar_evidence "north validate exits 0 → exit 0, 2026-07-11"
north tell 2026-07-11-120000 bar_evidence "firn build + validate green → both green, 2026-07-11"
north tell 2026-07-11-120000 outcome "shipped done-bars schema + docs"
```

---

## Owner, lead, driver

Three independent dimensions:

- **`owner`** — the *entity* the thread serves, a **literal**: `personal` (Tom's
  own work, the default catchall), a client owner like `acme` (billable
  contract work), and others as they arise. Threads that used to live in
  `space: system` are
  `owner personal` with a `relates_to @topic-system` edge.
- **`lead`** — the person accountable for the thread landing, a **person ref**
  (`@tom_passarelli`). Most threads are `lead @tom_passarelli`; a thread that
  exists because someone else is responsible names them.
- **`driver`** — whoever is *currently* pushing the thread forward, a person or
  agent ref — often the same as `lead`, but for AI-driven work it's the agent
  handle (`@claude-code`, `@claude`). **Presence of a `driver` is what makes a
  thread derive as active.**

Canonical dispatch exclusively owns the automatic driver claim for dispatched
agent work. It claims the declared-single `driver` fact atomically before
admission or provider side effects, and releases it on every terminal path. A
second dispatch of the same thread fails before side effects, even if it names
the same agent. MCP claims
before acknowledging a background launch and the SDK verifies that handoff;
discovery calls dispatch directly and has no second lock. Parallel work belongs
on child threads/spawns rather than multiple drivers on one thread. If a process
is hard-killed before its `finally`, the liveness reaper marks the lane after the
30-minute lapse bar and retracts only that dead lane's exact driver refs. There
is one earlier crash window: MCP may commit the driver claim before the child has
published its `kind=lane` identity. New SDK agent ids carry their mint timestamp
and a full UUID, so the reactor can recover an unpublished claim only after the
same 30-minute bar. It retracts the exact thread/holder pair; legacy, malformed,
future-dated, and already-published lane ids fail closed and are never inferred
dead from their spelling.

Person/agent handles are `@`-refs to real person nodes (nodes with a `display_name` — `name` is reserved by the engine).
Don't invent a handle inline; the node must exist. `north validate` rejects
refs that don't resolve.

### source vs proposed_by

- `source` is categorical (a small set of literals). Where did this thread
  originate? `source ai` triggers extra scrutiny regardless of which AI.
- `proposed_by` is specific — the agent or person, as a ref; repeat the line for
  shared authorship (`proposed_by @tom_passarelli` + `proposed_by @claude`). The
  first is the primary author.
- `created_by` is the mechanical author of the record (distinct from the
  conceptual `proposed_by`).

### AI-proposed threads

Threads with `source ai` carry habits (not enforced):

- Give them a near-term `valid_until` (`created_at + ~14 days`) unless promoted —
  AI proposals expire fast.
- Don't put a `driver` on them at birth — active is a deliberate pickup Tom owns.
- Record the human review in `## Log`.

---

## Edges

Three edge predicates, all `@`-ref objects to **real threads** (the engine
validates targets resolve — no dangling refs).

- **`part_of @<id>`** — composition. The thread is structurally part of a larger
  thread. A "project" is just a thread with children. Acyclic.
- **`depends_on @<id>`** — execution ordering. A thread is *blocked* while any
  dependency is non-terminal (not done/abandoned). Acyclic, no self-deps. Use
  this for real execution-blocking, not loose relatedness.
- **`relates_to @<id>`** — loose relatedness. An edge to a real thread, often a
  `@topic-*` node. This **replaces tags**: if two threads are "kind of related,"
  relate them; don't depend.

---

## relates_to and topic threads (former tags)

**There are no `tags`.** Relatedness is an *edge to a real thread*, so it can't
dangle and grouping is a graph query, not a string match. A former tag is now a
**`@topic-*` thread** — a thin node that exists to be pointed at:

```
@topic-gjoa
title  gjoa
owner  personal
source migrated
committed 2026-06-15

Topic thread (migrated from tag `gjoa`). Threads relate_to this.
```

To "tag" a thread, add `relates_to @topic-<name>`. To find everything in a
group, query what `relates_to @topic-<name>`. To merge two topics (or fold an
obvious topic into a real thread), use `north merge <from> <to>` — the
rename-once interning means refs follow.

Don't reach for a free-string tag; mint or reuse a `@topic-*` thread.

---

## Body convention

After the `---`, the prose body. Use these headings when they apply. None is
strictly required, but `## Log` is the one to never skip.

```markdown
## Goal

What is this thread asserting should happen?

## Why this matters

Why is this worth attention now?

## Acceptance

What would make this done? Concrete, ideally testable.

## Outputs

What the thread produced (see "Outputs section" below).

## Log

2026-05-27 — created.
2026-05-29 — picked up; driver set.

## Notes

Loose reasoning, links, caveats.
```

**`## Log` is the most important section.** It's where decisions, pickups,
hand-offs, and reviews accumulate as dated, append-only entries. Lifecycle is now
derived from facts, but the *narrative* of why a fact changed still belongs here.
Don't invent an event database; the Log is it.

### Outputs section

`## Outputs` records what the thread produced. It is intentionally structured for
**mechanical aggregation** — future tooling rolls outputs up across the corpus.
Stick to the shape:

```markdown
## Outputs

- kind: document
  path: streams/distillations/some-doc.md
  summary: one-line description

- kind: decision
  summary: chose Cyclone over Chicken for the backend
  rationale: see body section "Decision rationale"

- kind: code
  commit: abc123def
  repo: beagle
  summary: added emit-scheme scaffolding

- kind: observation
  summary: Wednesday client meetings consistently drain energy

- kind: thread-stub
  id: 2026-05-27-203000
  summary: spun off audit-tooling follow-up

- kind: none
  summary: explored X↔Y; no actionable output, recorded for instrumentation
```

`kind` is open. Common values: `document`, `decision`, `code`, `observation`,
`reframe`, `thread-stub`, `none`. Add kinds as they earn their place; resist
proliferation. Consistency is the whole point — if `kind` is sometimes `document`
and sometimes `doc` and sometimes a sentence, the "everything I shipped this
week" query is impossible.

(Note: the body is prose the engine stores verbatim, not parsed facts. The
`Outputs` shape is a *convention* for future tooling, not fact triples — so its
ids appear as plain text, not `@`-refs.)

---

## Reflection-style threads

Morning reflections, weekly reviews, three-good-things, end-of-day examens,
retrospectives — **these are ordinary threads that `relates_to` reflection
topics**, not a separate substrate. (The journal-as-primitive direction was
tried and abandoned; threads absorbed the use case.)

Conventions:

- **One thread per session.** A morning reflection on 2026-05-27 is its own
  thread; on 2026-05-28, a separate thread. That's what makes the rolled-up
  history queryable — the corpus is the history, not edits to one file.
- **Relate to reflection topics** consistently: `@topic-reflection` for any
  reflective work; cadence topics (`@topic-morning`, `@topic-evening`,
  `@topic-daily`, `@topic-weekly`, `@topic-monthly`); shape topics
  (`@topic-review`, `@topic-retrospective`, `@topic-examen`). Combine: a
  Sunday-night weekly review relates to `@topic-reflection`, `@topic-weekly`,
  `@topic-review`. Mint the topic thread if it doesn't exist.
- **Owner**: usually `personal`. Reflection on client work is
  `owner <client>` + `relates_to @topic-reflection`.
- **Outputs**: reflections almost always have `kind: observation` outputs —
  observation *is* the work product.

Don't reach for a journal substrate or a `reviews/` directory. Threads handle it.

---

## When to create a new thread

Create one when a thought needs a stable shelf. The bar is low. A fresh capture
is **`committed`** by default — accepted and in-play. Omit `committed` only when
the capture is genuinely speculative and needs triage before commitment (the old
`draft`).

Things that **should** be threads:
- anything that recurs in working memory
- anything with a deadline
- anything blocked on something else
- anything worth resuming with context

Things that **should not** be threads (yet):
- a one-line note ("call mom") that fits in a daily list
- the same idea expressed in three files — merge them

If a thread is small and atomic, fine. If it grows children via `part_of`, also
fine. The system handles both.

---

## The CLI: `north`

One binary. Run it via the north wrapper: **`~/code/north/bin/north`**.
The wrapper aims the Fram engine (`~/code/fram`) at north's private data
(`FRAM_THREADS`/`FRAM_LOG` under `~/.local/state/north/`, projected from the
canonical `north-data/facts.log`) and sets capture provenance defaults.
`~/code/north/bin/north-mcp` materializes the same instance selectors once from
its captured parent environment before launching children: explicit selectors
win; otherwise it supplies canonical `FRAM_LOG`, `FRAM_THREADS`, and
`NORTH_PORT` defaults. It selects the split coordination/telemetry logs only
when no log is pinned and the seeded coordination log already exists.

`los` is **gone entirely** — `los thread`/`los validate` retired (use `north`),
and time tracking is now **`north clock`** (fact-native; see Clock management).
One CLI.

Run `~/code/north/bin/north` with no args for the authoritative usage line;
don't trust an enumeration here over the binary. The surface:

**Reads (instant off the warm daemon, ~1ms):**

```sh
north ready       # curated: top 15 work threads by leverage (--all = every ready thread)
north blocked     # waiting on a depends_on target
north next        # the recommended next pull
north agenda      # calendar projection: buckets by do_on (overdue/today/next N)
north board       # curated: active drivers + top-15 ready + counts (--all = full kanban; alias: plate)
north leverage    # high-leverage threads (most unblocks downstream)
north schema      # vocabulary census: subjects/facts by entity kind + predicate metadata
north show <id>   # one thread's facts + body; resolves id/slug/substring
north validate    # integrity check (see below)
north audit       # corpus-health report
north needs-review # belief-revision queue: judgments whose inputs moved
north tools       # NORTH's curated tool surface (the MCP verbs) + the engine core
north schema-seed # derive predicate-metadata facts (--dry-run default | --execute)
```

`needs-review` is the staleness view (a pure projection — it never auto-flips a
fact): an expired `valid_until`, a `relates_to`/`clarifies`/`amends` edge whose
target was abandoned, or an `estimate_hours` that predates a later scope edit.
It also lists **promotable** drafts — uncommitted threads that grew real
structure (deps/estimate/driver/relations) and are ready to `commit`.

`agenda` is the "calendar" — a query over `do_on`, not a separate substrate, the
same way a "project" is just a thread with children. `board` (alias: `plate`) is
the replacement for the old per-state lists: it buckets threads by *derived*
condition.

`board` and `ready` **default to signal, not the full dump.** Bare `board` shows
the active drivers (who's on what, rendered by `display_name`), the top ~15 ready
threads by leverage, and a counts line (open/active/ready/blocked + open-concern
count); it scopes to `kind thread`, so the ~200 concerns and telemetry subjects
that also carry a `title` no longer drown the work graph. Bare `ready` is the top
15 by leverage. `--all` on either restores the complete unscoped dump unchanged.

**Writes:**

```sh
north capture "<title>" [owner]              # mint a new thread (fact-first)
north tell   <id> <pred> <value>             # add/replace a fact, via the coordinator
north retract <id> <pred> <value>            # retract a fact, via the coordinator (untell = legacy alias)
north merge  <from> <to>                     # fold one node into another
north import                                 # fold file edits into the fact log
north export <out-dir>                       # regenerate files from the log
```

**Coordination / daemon:**

```sh
north coord-doctor # the coordinator SAFETY handshake: tell/untell safe? daemon
                   # state matches the on-disk log? (the raw engine check)
north doctor      # the cockpit health sweep — leads with coord-doctor, then
                  # daemons, rev skew, env hygiene, guard hooks (see Cockpit)
north up          # start/revive the coordinator on the canonical log
north watch       # event stream (change triggers; promotion prompts)
north listen <agent-id>   # arm the real-time interrupt listener, as a background
                         # task; dormant until a peer pings you (alias: bin/north-arm)
```

A listener is the coordinator of work it executes, not the identity of each
child. Every spawn or dispatch command receives a fresh timestamped full-UUID
SDK identity, while `AGENT_COORDINATOR` records the listener. Listener children
never inherit `AGENT_ID` or an MCP preclaimed-driver marker; deeper MCP spawns
receive the immediate child's identity from the harness environment.

**Cockpit — see and drive the stack:**

```sh
north             # THE CARD: one screen of every significant incantation, grouped
                  # "type this → do this" (north help is the same screen)
north dashboard   # the cockpit: live agents, concerns by repo, board counts,
                  # daemon health, condensed `north health`, profile rung per layer
north doctor      # is everything healthy (the health sweep above)
north account status      # provider-owned subscription login, per isolated target
north account list        # named account targets and their isolated CLI homes
north account usage       # per-account subscription windows, resets, fixed failures
north providers           # auth/headroom + approximate balanced routing shares
north providers --json    # stable machine status; automation uses this, not prose
north config routing      # allocation mode, configured order, reserve, pressure, envelopes
north templates           # Gaffer's reusable stock templates and routing defaults
north routing report performance       # complete current managed-run evidence
north routing report performance --all # include legacy/incomplete historical rows
north routing report usage             # observed-token lower bounds + exact coverage
```

`north dashboard` and `north doctor` folded in from convoy (2026-07-10). The
**division of labor** the fold preserves: **Gaffer answers WHO does the work**
(role, composition, semantic tier, reasoning, and posture); **North answers WHERE
it runs and HOW you see and drive it** (account target, subscription pressure,
dashboard, spawn, watch, steer, profile). Gaffer is account-blind. `north spawn`
reads `~/code/gaffer/staffing/catalog.json`, then North selects an eligible target
and resolves the semantic tier through that provider's catalog. Generated agent
markdown and `~/code/gaffer/docs/adapters/north.md` remain provider-adapter
artifacts, never North's metadata source.

`north templates` is the human view of Gaffer's stock library. It deliberately
says **template** while the versioned machine contract retains `presets`,
`composition.kind="preset"`, and `nearestPreset`. Templates are reusable
starting points, not limits: select an exact template, justify an axis override,
or author a complete bespoke composition. Routing performance defaults to
complete current v4 managed-run evidence: an explicit terminal reason and
proof-valid process/delivery outcomes plus the applied role, capabilities, and
every routing axis. The applied role must match the composition ID, preset IDs
must still exist in the current stock catalog, and bespoke compositions need
matching fingerprint evidence. `--all` exposes legacy and unattributed history.
Empirical Gaffer promotion qualification is paused until North has an
independently enforceable verifier boundary. Current `reported` runs and
historical same-UID `verified` projections cannot manufacture qualified
recurrence; the promotions report labels this
`verification-boundary-unavailable`. Thread review counters use `thread*`
names and never imply independent verification.
Usage totals are exact
only when every included run has exact token evidence; otherwise the displayed
sum is a lower bound with its exact-run coverage.

`north account add|login|status|list|usage` manages provider-owned subscription login
inside isolated homes under `~/.local/state/north/accounts`. `--target <id>` is
an exact account pin with no fallback. `--provider <name>` permits only sibling
accounts of that provider; the default auto route may use any eligible target.
Preferential mode follows target priority. In balanced mode the report presents
the accounts as an **unordered configured candidate set**, because the policy file's
shared `targetOrder` storage field is not selection priority in that mode.
Balanced mode re-ranks both primary and retry targets per run key, applies
stable weighted distribution adjusted by per-target numeric headroom, and
prints each eligible account's normalized approximate share; reserved mode preserves a
configured target for frontier work. A runtime fallback requires typed proof
that the provider never accepted the request and occurs before any emitted event;
North never decides replay safety from exception text. Agent/run facts preserve
the requested target, resolved target, selection reason, pressure, and fallback
path. Token reports likewise preserve evidence: exact totals remain exact,
unknown coverage never becomes zero, and mixed coverage is labeled as a known
lower bound plus incomplete coverage. Full contract:
`~/code/north/docs/provider-architecture.md`.

Provider severity is not numeric usage. A categorical rate-limit warning may
temporarily impose a labeled routing-only conservative floor, but
`north providers` / `--json` keep that derived floor distinct from any
provider-measured percentage. Cross-source measurements are joined only when
their canonical limit ID and reset boundary identify the same subscription
window.

The final `north providers` route probe uses one fixed diagnostic key. It is a
health check, not a provider preference and not the next route prediction.

Explicit spawn axes override Gaffer defaults independently, so a staffing change
in Gaffer requires no North edit and an account-policy change requires no Gaffer
edit.

Delegation intake makes dependency shape explicit without asking North to guess
from prose. An intelligent chat adapter maps the single user-facing `/delegate`
verb to exactly one mechanical form:

```sh
north delegate "<task>" --role <worker-role> [spawn options]  # atomic
north delegate "<task>" --composite [spawn options]           # 2+ independent pieces
north delegate "<task>" --thread <id> ...                     # bind an existing thread
```

There is no unclassified default. Atomic handoff forwards every normal spawn
axis and bespoke-composition option, so it starts exactly one selected terminal
worker. Composite handoff alone hydrates the director, which then owns fan-out
and reduction. Context carriage remains orthogonal via `--context <file>`.

Every executed delegation has one durable, exact thread before a provider is
invoked. `--thread` wins and must resolve to a title-bearing thread. Without it,
North inherits a managed parent thread only when the ambient run reservation,
reporter, and capability all verify; stray or stale environment variables never
count as proof. Otherwise North mechanically captures one committed thread. Its
title is a deterministic, bounded label derived from the first meaningful task
line; the complete task remains in the spawn brief. Structured capture is
transaction-like at this boundary: a partial write is retracted and absence is
proved, or delegation fails closed before provider execution.

The dedicated delegate-thread environment binding is adapter input, not
heritable authority: the SDK consumes it once, while managed child environments
scrub it along with parent run credentials. A composite thread records only the
aggregate reduction/checkpoint contract. Each child receives its own
title-bearing thread linked with `part_of`, its own run reservation, and its own
evidence. A successful orchestrator terminal additionally requires an explicit
child settlement result **and** a completed parent reduction turn for the exact
nonempty settled child-set signature. Child terminality is not reduction: the
first observation of each new settled set injects a provider continuation, and
only the subsequent successful provider result acknowledges that signature.
Live children cause a bounded continuation (real state progress resets the
bound); an unavailable settlement source, a no-progress cap, or an
unacknowledged settled set records a blocked, never-ran terminal. North repeats
the settlement/reduction gate immediately before publication to narrow the
late-child race window to that publication seam. Terminal workers retain the
loud early-exit notification behavior.

**Ownership rule** (2026-07-09): a cockpit verb earns its place ONLY when it
COMPOSES multiple tools (`dashboard`, `doctor`, `profile`, `spawn` = gaffer dials
× north SDK) or fixes a hostile invocation (`watch`, `steer`, `retask` over raw
`msg-cli`/`tail`). If ONE tool already owns the concern, the cockpit TEACHES that
tool's command — it never re-badges it. `north board` is typed as `north board`,
not wrapped. Every composed call PRINTS the primitive it runs (the `»` line):
teach the tool, don't hide it. State beyond `~/.cache/north/*` is never owned; no
new daemons.

### Writing safely under concurrent agents

north is fact-backed and **other agents may be editing concurrently**. The
rules (also in the global CLAUDE.md):

1. **Session-start handshake:** run `north coord-doctor` (the fast coordinator
   safety check; `north doctor` runs it too, inside the full cockpit sweep). If
   DOWN/DEGRADED, run `north up` to start the coordinator on the canonical log.
2. **New threads:** `north capture "<title>"` (fact-first) — or create the
   file and run `north import`. Distinct files don't collide, so file-edit +
   `import` is safe for whole new threads.
3. **Field changes on existing threads:** go through the coordinator with
   `north tell` / `retract` (serialized, rule-checked, retries on conflict).
   **Do NOT use `north set`** — it appends the log directly and races. (`set`
   exists; it's for single-writer/offline situations only.)
4. **Do NOT run `north export` during concurrent work** — it regenerates
   `threads/` from the log and would clobber another agent's un-imported edits.
   (The engine refuses if files diverge, but don't rely on it.) `import` is
   idempotent and safe anytime.

Reads are instant off the warm daemon (`north serve`); writes serialize
through the coordinator.

### Concern liveness — decay, handoff, and reaping

A **concern** (`concern declare …`) is a feature + footprint an agent is
building. Concerns coexist; declaring never blocks. Their liveness is **derived
from the owner's presence lease** — the same renewable-lease rule the presence
roster uses — never a stored status. Three mechanisms keep the board honest when
an owner dies without running `concern done`:

1. **Read-time decay (no write).** `concern ls` / `concern overlap` judge each
   concern's owner live-or-lapsed at render time:
   - owner **online** → rendered normally.
   - owner **lapsed**, still `building` → **STALE** (dimmed, `owner lapsed
     <ago>`). Shown, not hidden — a hidden stale concern is what let dead-agent
     work linger invisibly *and* misroute a live lane.
   - owner **lapsed**, `likely-to-land` → **HANDOFF** (prominent). A
     near-landing concern *survives* owner death: it is a signal to the next
     agent to adopt, not stranded WIP.
   `<ago>` uses the lease-expiry lapse, or the concern's own declare-age when a
   pre-presence owner never held a lease.

2. **Reactor auto-abandon (fact write).** The reactor (`cli/north-reactor.clj`)
   sweeps on its cadence (every 5 min): a `building` concern whose owner has
   been lapsed **>24h** gets `reached=abandoned-stale` written through :7977
   (auditable, reversible — a later `landed` still wins). `likely-to-land` is
   **exempt** (it's a handoff). Abandoned concerns are retired from `concern ls`
   (shown with `--all`). Test one-shot: `bb cli/north-reactor.clj sweep-once
   [--dry-run] [--repo <repo>]`.

3. **Stuck-fork reaping.** The same sweep finds `kind=lane` agents whose
   presence lapsed **>30min** with no `outcome` fact → writes
   `outcome=died-unreported`, prefixes `display_name` with `✝ `, and pings the
   lane's coordinator (if any) over the fact feed. Zombie forks surface instead
   of lingering. It also retracts an exact SDK driver claim whose timestamped
   full-UUID holder was minted at least 30 minutes ago but never published a lane
   identity. This closes the claim-before-identity crash window without guessing
   about older id formats.

4. **Managed-worktree janitor.** The reactor's same sweep reclaims a registered
   lane worktree only after the canonical full lane-terminal/committed-run join
   resolves it, its graph registration exactly names `repo`, `worktree`, and the
   derived `lane-<agent-id>` branch, and real Git proves that provenance plus a
   clean status. Cleanup is only non-force `git worktree remove` followed by
   `git branch -d`, with exit codes and postconditions checked. Dirty trees stay
   byte-for-byte intact and gain one idempotent `worktree_orphaned` fact.
   Liveness, torn terminals, hostile facts, and uncertainty proved before any
   cleanup mutation keep the tree. After a removal command runs, only an exact
   path-present + registration-present postcondition can still say `KEEP`;
   changed or unknown state and branch-delete failures report `PARTIAL cleanup`.
   Later sweeps recognize a fully absent tree + registration + branch as already
   reclaimed, while an absent tree with a surviving/unknown branch remains
   partial. The janitor never describes an already-removed worktree as kept. The
   one-shot probe is the normal reactor surface:
   `bb ~/code/north/cli/north-reactor.clj sweep-once [--dry-run]`.

The **activity heartbeat** that powers all of the above: the `north-on-tooluse`
PostToolUse hook renews the owner's presence lease on tool calls, **throttled to
once per 60s** (marker in `XDG_RUNTIME_DIR`). A renewal therefore *means*
"this agent ran a tool recently" (IS-WORKING), so lease expiry is a real death
signal — not merely "never registered".

---

## Validation rules

`north validate` checks the graph, not a YAML schema:

- every file parses as facts (subject line + `predicate object` lines + body)
- ids are unique and well-formed (`yyyy-MM-dd-HHmmss`)
- every node referenced by `part_of`/`depends_on`/`relates_to`/`superseded_by`
  resolves to a **real thread** (has a `title`) — no dangling refs
- every person/agent ref (`lead`/`driver`/`proposed_by`/`created_by`) resolves
  to a real person node (has a `display_name`)
- no cycles in `part_of`, no cycles in `depends_on`, no self-dependency
- dates parse; literals are valid EDN

Validation never auto-repairs. On failure it exits non-zero with a list. Run it
after any batch of edits.

---

## Working with this directory as an AI

If you are an AI (Claude or otherwise) editing this directory:

1. **Read this file first.** Yes, again.
2. **Run the handshake** (`north coord-doctor`, `north up` if needed) before
   coordinating threads.
3. **Default `source ai`** for anything you originate, not `tom`. Add yourself
   to `proposed_by` (`@claude`, `@claude-code`). The `bin/north` wrapper
   defaults capture provenance to Tom; when *you* originate, override via env:
   `NORTH_SOURCE=ai NORTH_AUTHOR=claude-code NORTH_DRIVER=claude-code
   NORTH_PROPOSED_BY=claude-code north capture "..."` (lead stays Tom).
4. **Default `created_by`** to your own handle, **`lead`** to `@tom_passarelli`,
   **`owner`** to `personal`, unless told otherwise.
5. **A fresh capture is `committed`** by default. Omit `committed` only for
   speculative captures that need triage. **Never set a `driver` at birth** —
   making a thread active is a deliberate pickup Tom owns.
6. **Add a `## Log` entry** noting that you created the thread and why.
7. **Prefer the coordinator for field changes** — `north tell`/`retract`, not
   `north set`. Run `north validate` after a batch.
8. **Do not invent predicates lightly.** Adding a predicate is cheap mechanically
   (no parser to touch), but the *bar is a real recurring fact*, surfaced across
   cases — raise it in conversation first. Same for handles: don't reference an
   `@handle` or `@topic-*` that doesn't exist; mint the node first (topics with
   `capture`/`merge`; people with Tom's sign-off).
9. **Do not nest by directory.** All threads live flat here; structure lives in
   facts (`part_of`/`relates_to`).
10. **Preserve the body verbatim** when changing facts. Facts go through `tell`;
    leave the prose alone unless you mean to edit it.

---

## Anti-patterns

- **Writing a `state` / `phase` / `status` predicate.** Condition is derived from
  `committed`/`outcome`/`abandoned`/`driver`/`depends_on`. There is no status
  field.
- **Adding a `paused` value.** Drop the `driver` — dormant is derived.
- **Free-string tags.** Relate to a `@topic-*` thread (`relates_to @topic-x`).
- **Dangling refs.** Every `@`-ref must point at a node that exists; `validate`
  rejects otherwise.
- **`north set` under concurrency.** Use `tell`/`retract` through the
  coordinator.
- **`north export` during concurrent work.** It clobbers un-imported edits.
- **A `project` field or `projects/` subfolder.** A project is a thread with
  `part_of` children.
- **Treating the id as the creation date.** The id is an opaque collision-safe
  key; `created_at` is the real date. Don't edit `created_at`; move `updated_at`.
- **`depends_on` for loose relatedness.** That's `relates_to`. `depends_on` means
  execution-blocking.

---

## Working during a session

The sections above cover editing this directory. This covers behavior during an
actual work session — what an AI does when Tom starts *doing* something.

1. **At session start, try to match a thread.** Check in roughly this order:
   - `relates_to @topic-*` against the apparent domain (`@topic-beagle`,
     `@topic-gjoa`, `@topic-acme`, …)
   - `owner` against any entity explicitly named
   - `repo` against the active checkout / cwd
   - title and body grep against the topic of recent messages

   If one matches, surface its title, derived condition (ready/active/blocked/
   dormant), and the relevant body sections (`## Acceptance`, open `## Log`). If
   several match, list and ask. If none match, ask whether to create one — only
   if the work looks substantive. One-off chores don't need threads.

2. **Activate on engagement, not on mention.** A committed-but-dormant thread Tom
   starts actually executing should become active by setting a `driver` — but
   not silently. Offer it; `north tell <id> driver @claude-code` (or his
   handle) is the act.

3. **Small things go in the body, not as new threads.** A discrete to-do that
   fits an existing thread's scope goes in its `## Log` or an open list, not a new
   thread file. The bar for a new thread is "this needs a stable shelf."

---

## Clock management

Time has two orthogonal axes. Do not make either axis impersonate the other:

1. **Human client billing** is one loose, owner-scoped session for Tom's working
   context (`kind client_session` / `owner` / `clocked_by user` / `rate` /
   `start_time` / `end_time`). It normally spans many tickets and many managed
   lanes. Start it when client work begins; stop it only when the client context
   actually changes.
2. **Managed task timing** is one `kind run` telemetry entity per agent run,
   carrying exact `thread`, `agent`, and `duration_ms`. Runs overlap freely and
   preserve per-task estimation evidence. Managed lanes never start, stop, or
   adopt the human billing clock; before client writes they only verify that the
   matching human owner session is open.

Both are fact-native and live in the graph, but only the human axis feeds
invoices. Historical human `session_of @thread` rows remain readable and
billable; an explicit non-user `clocked_by` is legacy agent timing and is
audit-only. `los time` and the old JSON clock-in are gone.

```sh
north clock in <owner>          # open the one human client session (e.g. msa)
north clock out                 # close it and report the duration
north clock status              # current client owner/session + elapsed
north clock report              # est vs actual per thread + calibration %
north clock today | week        # logged time per thread over a date window

# Compatibility for historical/manual per-thread human calibration:
north clock start <thread-id>
north clock stop
```

`actual` is *derived* (summed from sessions, never stored). `clock report`'s
calibration % across completed threads is the honest-estimate signal (>100% ⇒
you under-estimate) — exactly what `needs-review`'s `estimate_hours` flag points
at: re-estimate using what the work *actually* took.

### Clockify is a projection, not a second store

Billing flows *out of* the sessions — Clockify is a derived sync target, not a
parallel ledger:

```sh
north clock map <owner> <project-id>   # owner -> Clockify project (config)
north clock sync                        # push closed, billable sessions
north clock projects | workspaces       # list Clockify projects/workspaces
```

A session is **billable** iff it is a human owner-scoped client session, or a
compatible legacy human thread session, and that owner is mapped to a Clockify
project (so `owner personal` is never billed). `sync` pushes closed, unsynced,
billable sessions and writes the returned id back as a `clockify_id` fact, so
it's idempotent. Mapping lives in `~/code/north/time/projects.json`; the API key
comes from `$CLOCKIFY_SECRET_FILE` (wired by the wrapper). **Sync is on-demand
only — never automatic** (it touches real client billing).

This section is when an AI should act on the human clock (`clock in`/`out`).

1. **Clock is required for non-`personal` owners.** Whenever work is detected
   against a client, a human session for that owner must be open (`clock in
   <owner>`). If none is running and Tom starts client work, prompt before
   continuing. Billing is settled later via `clock sync`.
2. **One human client clock at a time; many run clocks.** The human session
   represents client context, not a ticket or agent. Do not stop/start it as Tom
   moves among tickets for the same client. Every managed run independently
   records its exact task duration, and those run records may overlap.
3. **`owner personal` is clock-optional.** Tom may track personal threads (a
   Beagle session, a writing block) for calibration but isn't required to. Offer
   once at the start of substantive personal work, then drop it.
4. **Shift detection on signal, not on timer.** Re-evaluate the active session
   when a different client becomes the focal context, the conversation clearly
   leaves client work, or Tom states a switch. Going off-topic may warrant a
   warning, but ticket changes inside the same client do not. High-confidence
   client shifts switch with a notification; ambiguous shifts ask.
5. **Wall-clock counts while context is preserved.** AI generation waits, long
   compiles, reading docs, and work across several tickets all count while the
   client context remains active. A full client-context switch is a `clock out`
   moment.
6. **Clockify sync is on-demand.** `clock sync` runs when Tom asks. Never automatic.

---

## What lives elsewhere

- `~/code/north/streams/raw/` — lossless transmission events (conversations,
  dictated thoughts, captured sessions).
- `~/code/north/streams/distillations/` — tiered AI compressions of raw
  streams. See `streams/CLAUDE.md`.
- `~/code/north/north-data/facts.log` — the canonical fact graph (source
  of truth; `threads/` is its projection).
- `~/code/north` — the generic engine (public source of truth); `bin/north`
  is north's consumer wrapper.
- `git log` — history of edits to threads.

If something does not fit those or `threads/`, push back before inventing a new
home for it.
