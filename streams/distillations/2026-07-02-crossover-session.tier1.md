# 2026-07-02 — the crossover session (tier-1 distillation)

- raw: `~/code/tern/streams/raw/2026-07-02-crossover-session.69b571e7.jsonl` (local-only snapshot, session still live at write time)
- stream thread: `@019f203b-e4d1-7db4-a835-c1c64c3af18e` → `relates_to` the program `@019f200f-46f6` (all spawned work reachable via `part_of`)
- participants: Tom (voice, several dictated), Claude (`cc-fram-69b571e7`, in command from ~08:00)

## What this session was

Started as loose-thread recovery (06-29 + 07-02 session dumps), became the
session where the stack turned on itself: the conversation diagnosed why the
substrate wasn't being used ("we're doing it like cavemen"), landed the fix as
protocol, and ended with this very transcript stored in the layer it designed.

## Decisions & principles (all recorded as claims; listed here as narrative)

1. **Dogfood protocol** — session state lives on threads; `SESSION-DUMP-*.md`
   is a violation; agent briefs are thread refs + delta. Law in global
   CLAUDE.md (nixos-config `9dc82da`). Trigger insight: two integrity
   regressions (person nodes, doctor ±1) sat unnoticed because nobody lived in
   the graph — "nothing watches a substrate nobody lives in."
2. **Context-to-competence** — the stack's quality metric is the tokens a
   fresh agent needs to operate it. Exapt prior art (Datalog, GTD, org-mode,
   kanban, TELL/ASK); a term needing a sentence of explanation is a bug; the
   author-agent's natural verb wins. Corollary Tom stated: ≥20k tokens of
   protocol description = optimization failure.
3. **Vocabulary verdicts** (my priors, at Tom's direction): `plate`→`board`,
   `concern shape`→fold into `overlap`, `tern-arm`→`tern listen`;
   `tell/untell` kept (accidental perfect TELL/ASK prior); `chartroom`→
   `codegraph` deferred until Move 1 releases the tooling.
4. **Falsifier ladder** — fastest radical prove/disprove: (a) Move 1 economics
   with **M1.5 def-level as the honest null**, (b) the head-to-head: one real
   gjoa feature built twice (graph-native multi-agent vs text+worktrees),
   instrumented on tokens/conflicts/interventions/defects.
5. **Graceful degradation ladder L0–L3** — Tom's "never fall to the floor"
   shower thought, formalized + shipped same session (fram `a544948`,
   nixos-config `a840c5b`, STACK.md).
6. **Wrong guesses are vocabulary votes** — hallucinated tool names are
   empirical priors; telemetry loop mines them (`tern-mine`, in flight).
7. **Quality mandate** — quality 100× speed; adversarial verification before
   any thread closes; Move 1 gets full design+data review.

## The promised-land articulation (kept verbatim-ish; conversation-only until now)

Graph-native authoring loop as it exists on gjoa today: ask the graph
(blast/query) → author claims (`add-def`/`set-body`, ~200 tokens) → engine
mints permanent ids, renders text as deterministic projection, runs the warm
repair loop → identity survives every edit → coordination on the same graph
(concern footprints as defn ids, pre-edit overlap warnings). Why agents still
edit raw `.clj`: coverage (ingest is Beagle-only; tern CLI/fram engine are
plain Clojure), wiring (verbs arrive per-project via `.mcp.json`), enforcement
(claim-canonical registry nearly empty). Crossover = four fronts: plans→threads
(done), session-state→claims (done, this session), live coordination (L1 now,
Move 2 upgrades), authoring (gated on Move 1 economics + registry + bootstrap).

## Landed during the session (verified, pushed)

fram: `409f7b9` export fixes · `60d2ff9` qualified module-of · `526ccaf`
schema #lang restore · `a03bfee` pinned-racket-only · `a544948` fram-code-status.
tern: `cb79048` TTL 30min · `aa15fbd` @ sigil · `2596b03` doctor ≥ fix ·
`6fcae6b` display_name manual fix. nixos-config: sonnet-5 policy + 2.1.198
overlay pin + harness polish (3 commits) + `9dc82da` dogfood + `a840c5b` ladder.
after-text: `820cc9e` evidence.sh green · `27aacce` make talk-receipts (6/6).
gjoa flipped: 57 modules, 429k claims, coordinator :48942. tern validate
770→0. Doctor honest. Receipts one command.

## Open questions the conversation raised but did not settle

- Does the crossover shape hold at n≥10, against the M1.5 null? (Move 1, running)
- Is the 6–14× reasoning win graph-unique or index-generic? (graphify control, queued)
- Where exactly does the head-to-head's text baseline win? (expect: small edits
  in unflipped repos — the honest answer shapes the talk)
- `tern ask` surface; whether MCP core collapse changes the CLI too.

## Session close state (appended at /clear; the program thread's ENTRY POINT
note is canonical — this is the narrative copy)

Back half of the session, after this file was first written:
- **MCP collapse landed**: fram 188 tools/~11.8k tok → 10-tool TELL/ASK core
  (~1.1k tok, 10.8×) — receipt #1 for context-to-competence (fram `1e151e2`).
  Telemetry later showed agents had hallucinated `mcp__fram__tell` BEFORE it
  existed — first verb-vote confirmation.
- **Telemetry loop live**: `tern-mine` baselined 1.9GB of transcripts (top
  finding: 367 consecutive StructuredOutput failures unstopped → escalation
  thread). Claim engine exonerated: 3 rejects corpus-wide.
- **Stream layer completed**: `tern-stream-sync` cursor-based log shipping
  (zero-AI); session-end flush live, 5-min timer awaits firn rebuild.
- **Tripwire shipped + soaking** (nixos-config `87d5fcf`): 85/85 matrix, 7ms;
  flip to bypassPermissions for SDK lanes gated on zero false denies.
- **"fleet" eradicated** from the living estate (5 repos + 14 thread retitles
  + ~/code/fleet-coord → ~/code/coord-lab); swarm/pin/family replacements;
  msa excluded (client), pins/archives/recorded-data verbatim by design.
- **Move 1 PAUSED at trial boundary, 6/36 grid + 6/6 pilot, ALL PASS
  attempt-0.** Interim curve: M1 out-tokens ∝ module size (20–38× vs M2 at
  1,893 lines; 10× wall). HONEST CAVEAT: M1.5 def-level null ≈ M2 on output
  tokens; M2's edge is input-side (~3×, grows with size) — final verdict =
  total-cost analysis. 3 substrate bugs found under load (1 fixed+pushed,
  fram `2cbc8fd`; 2 threaded). Resume: "resume move 1" → thread
  019f200f-6c8d + macro/RESULTS.md steps (~$8–12 opus-4-5).

Supersedes the markdown-dump era (last dump: fram docs/private
SESSION-2026-07-02-consolidated-landing.md — content absorbed into threads +
this distillation; the file stays as historical artifact of the old protocol).
