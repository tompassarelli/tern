# Claim-Native Redesign — SHIPPED 2026-06-15

*Drafted then **executed** 2026-06-15. Status: **SHIPPED** — this is now a
historical design record, not a pending plan. The live corpus migrated
(173 → 406 threads, validate clean), `los` was **deleted** (not "rewritten in
lockstep" as the staging below anticipated — its `time` capability was ported to
`tern time` and the rest retired in favor of tern). The current operating
manual is `docs/operating-manual.md`. Rollback: git tag `pre-claim-native` (both repos).
Stage/Q sections below are kept verbatim as the original plan; where they say "los
in lockstep" or "nothing started yet," read them as the pre-execution plan.*

## Why

The flip made the claim graph canonical and the `.md` files a projection. But the
projection — and parts of the model — still carry **pre-claim assumptions**:

- **YAML frontmatter** — a *denormalized* record that reshapes atomic claims into
  typed fields + lists (a second, fragile serialization of claims the log already holds).
- **Entity types smuggled into string prefixes** (`thread:`/`person:`/`tag:`/`owner:`/`repo:`)
  — type as a string convention instead of structure.
- **A flat `state` enum** that crushes several *orthogonal* axes onto one line.
- **String `tags`** that point at nothing ("concepts in the clouds").
- **Run-together ids** (`20260615150040`) — opaque *and* unreadable.

The throughline of every decision below: **replace flat labels / denormalized
encodings with structure.** End state — *one shape everywhere*: the claim
`(subject predicate object)`. Conditions (active, blocked, done, …) are **derived
from structure**, never stored as labels.

---

## The model (decisions locked in conversation)

### D1 — Files are claim triples, not YAML
The on-disk file becomes the thread's claims rendered as triples + the dictated
prose body. Same shape as the log (which is already claims-as-text). Round-trip
reuses the log's EDN read/write — so the YAML quoting/injection bug class (the
`dq` mess) **cannot exist**.

```
@2026-06-15-150040  title       "Pick back up: gjoa + reference/lean work"
@2026-06-15-150040  committed   2026-06-15
@2026-06-15-150040  relates_to  @2026-06-14-140000
@2026-06-15-150040  repo        "~/code/gjoa"
---
Resume the gjoa + reference/lean work. Pick it back up today.
```

### D2 — No "fields", only claims
There is no per-field parser. `import`/`export` become **generic claim read/write**.
The denormalized machinery deletes: `parse-flat-fm`, `thread->claims` (its 21
hardcoded fields), the export frontmatter assembler. **Adding a predicate never
requires touching the parser** — there are no fields, only predicates.

### D3 — No type tags, no entity prefixes; kinds are *structural*
Drop `thread:`/`person:`/`owner:`/`tag:`/`repo:` prefixes. A "type" is not a stored
label (nominal) — it is a **shape** (structural): a saved query over claim-shape.
You can't *eliminate* the type, only move it from declared → derived; the shape is
the irreducible part, and it lives as a query, not a tag.

- **thread** = a node that has a **`title`**. (Replaces the old "has a `state`".)
- **person** = a node that has a **`name`** (keeps the rename-once interning win).
- Everything else (`owner`, `repo`, `source`, dates, estimates, outcomes) is a
  **literal**, not an entity.
- Integrity (`relates_to`/`depends_on`/`part_of` targets) = "target is a thread"
  = "target has a `title`". Structural, decidable, can't drift.
- *(Open: confirm `title` as the thread discriminator — see Q1.)*

### D4 — ref vs literal is *syntactic* (`@` sigil)
Structure can't tell whether `personal` is a ref or the literal "personal" — so
**syntax** marks it. A value is either `@<id>` (a ref to a node) or an EDN literal
(`"..."`, a number, a bare date). Orthogonal to kind.

### D5 — `tags` → `relates_to`
Relatedness is an **edge to a real thread**, validated (no dangling concept). A
former tag *becomes a thread*; grouping is the graph query "what `relates_to`
@X", not a string match. (`tag:tern` → the tern umbrella thread.)

### D6 — `state` enum dissolves into orthogonal axes (derived, not stored)
The flat enum conflated independent axes — some that *cycle*, some that *ratchet*.
It had **no honest home** for "inactive but still wanted and not done" (hence the
`paused`-is-a-tag hack). Decompose:

| axis | kind | how |
|---|---|---|
| **commitment / desire** | history (acts) | `committed` present; `abandoned` present (reason inline). desired = committed ∧ ¬abandoned |
| **completion** | history (act) | `outcome` present |
| **activity** (cycles) | derived | has a `driver` / running clock *now* → active ⇄ dormant |
| **blocked** (cycles) | derived | any `depends_on` target unresolved |

Old values are lossy shadows of the tuple:
`draft` = ¬committed · `ready` = committed ∧ ¬active ∧ deps-resolved ∧ ¬outcome ·
`active` = driver now · `done` = outcome · `canceled` = abandoned ·
**`dormant` (the homeless case)** = committed ∧ ¬active ∧ ¬outcome ∧ ¬abandoned.
There is **no `state`/`phase`/`disposition` predicate** — condition is a query.

### D7 — ids get separators, fixed-width
`2026-06-15-150040` (date human-grouped, compact time, all dash/digit → safe in
`@`-refs, filenames, EDN, grep). Not ISO `:` (collides with parsing + filenames).
Fixed-width so id↔slug splits by position, not first-dash. Opaque key, but glanceable.

### D8 — Belief-revision / staleness layer
Claims are not one temporal kind. Three classes; treat each differently:

- **History** (immutable, never stale): `created_at`, `proposed_by`,
  `committed`/`outcome`/`abandoned`. Append-only truth.
- **Derived** (recomputed, can't go stale): active, blocked, ready, dormant.
- **Judgments** (revalidate when inputs move): `estimate`, `relates_to`, priority.
  **Stale iff an input changed at `tx > assertion-tx`** — a *computed projection*
  (sibling of ready/blocked), using the log's monotonic `tx`. Never auto-flips →
  routes to a **`needs-review`** queue; the human re-decides.
- **Promotion prompts** (e.g. draft grew real structure → "commit it?"): not a
  staleness *computation* (can't derive intent) — a **change-trigger** off the
  event stream (`tern watch`), surfaced for a human call.
- `valid_until` is the **time-based special case** of a judgment (input = clock).

### D9 — Capture is prose/dictation-first, claim-first
You dictate text dumps; you don't hand-author fields. So capture = "dump → store
as body + extract claims," not "title → emit a record." Reshape `tern capture`
around the claim-native write path (the env-provenance work folds in). The current
title-first/YAML-emitting capture is replaced.

---

## Derived conditions (projections, all queries over the tuple)

`active` · `dormant` · `blocked` · `ready` (committed ∧ ¬blocked ∧ ¬active ∧ ¬outcome)
· `done` (outcome) · `abandoned` · `desired` (committed ∧ ¬abandoned) · `needs-review`
(stale judgments + materially-changed uncommitted). The existing `ready`/`blocked`/
`leverage`/`next`/`agenda`/`plate` projections re-express against the tuple.

---

## Blast radius (three systems + two corpora)

- **tern engine** — `kernel` (drop state enum + tag; add relates_to + structural
  kind + lifecycle predicates + derived conditions), `import`/`export` (generic
  triples, delete field machinery), `audit` (tag-drift/long-tail-tags die),
  `main`, `rt` (id format), `coord`.
- **`los`** (daily CLI) — `schemas/fields/*` (drop `tags.yaml`/`state.yaml`, add
  `relates_to.yaml` + lifecycle predicates), and the frontmatter parser /
  validator / display in `los-bb/src/los/{main,thread}.bclj` must learn the
  triple format. **This breaks `los` unless done in lockstep.**
- **Corpus** — all **173** live threads + **9** bundled examples: id reformat +
  tags→relates_to (+ mint topic threads) + state→lifecycle claims + YAML→triples +
  prefix-strip/`@`-refs. One coordinated rewrite.
- **Docs** — `docs/operating-manual.md` (the spec) rewritten for the new model.

This is the **biggest change since the flip.** Almost every piece couples
engine+los+corpus, so it's a *build-new + migrate + cutover*, not many tiny
independent stages.

---

## Plan (staged, each gated by round-trip + validate, git-backed)

**Stage 0 — Safety.** Tag `pre-claim-native` in tern + tern. Confirm
baseline round-trip + `tern validate` + `los validate` all green.

**Stage 1 — New engine, proven on the 9 bundled threads (zero live impact).**
Generic triple import/export; `@`-refs; structural kinds (`title`=thread);
`relates_to` + dangling validation; lifecycle predicates + derived conditions;
drop state enum + tags + prefixes + audit tag funcs. Migrate the 9 bundled
fixtures as the proof; round-trip must be claim-identical and projections sane.

**Stage 2 — Migration script** (old corpus → new). One transform: id reformat
(+ rewrite every `part_of`/`depends_on`/`relates_to` cross-ref), tags→relates_to
(auto-mint a topic thread per distinct tag; `merge` the obvious ones into existing
threads), state→lifecycle claims (`ready/active`→`committed`; `active`→ leave a
driver; `done`→`outcome`; `canceled`→`abandoned`+reason; `draft`→ no committed),
prefix-strip → `@`-refs, YAML→triples. **Dry-run on a copy**; diff; validate.

**Stage 3 — `los` in lockstep.** Triple parser, schema updates, validation +
display for the new model. Test against the migrated copy.

**Stage 4 — Cutover.** Apply the migration to the live corpus; `tern validate`
+ `los validate` green; commit. Rollback = `pre-claim-native` tag.

**Stage 5 — Capture reshape** (D9) — prose/dictation-first, claim-first.

**Stage 6 — Staleness/`needs-review`** (D8) — predicate-class map + the
tx-staleness projection + promotion prompts off `watch`.

---

## Open decisions (need your call)

- **Q1 — thread discriminator.** Propose `title` ("a thread is a node with a
  title"). Confirm, or pick another minimal structural marker.
- **Q2 — lifecycle value/predicate names.** `committed` / `outcome` / `abandoned` /
  `driver` — good, or sharpen?
- **Q3 — `@` sigil** for refs — accept, or a different marker?
- **Q4 — tag→thread mapping.** Auto-mint a stub topic-thread per distinct tag then
  `merge` the obvious ones (recommended), vs hand-curate up front.
- **Q5 — one big cutover** (Stages 1–4 together) vs land `relates_to` first as a
  smaller step. Given the coupling, I lean one cutover with the safety tag.
- **Q6 — `los` scope.** It's a full second CLI; confirm we rewrite its parser now
  (it's unavoidable once the file format changes).

## Honest notes

- This deletes more code than it adds (the field machinery, the enum, the YAML
  quoter, tag-drift) — but the **corpus + los migration is the real cost/risk**,
  and it touches your daily tooling.
- Everything is reversible via the `pre-claim-native` tag; nothing ships without
  round-trip + both validators green.
- Nothing here is started yet. This is the plan to react to.
