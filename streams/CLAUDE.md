# streams/ — lossless capture + tiered distillation

The stream layer the operating manual describes. Two directories:

- `streams/raw/` — **lossless transmission events**: full session transcripts
  (Claude Code JSONL), dictated thoughts, captured conversations. **Local-only,
  gitignored** — raw transcripts carry everything (private context, tool
  output); the repo publishes projections, not the source signal. Files:
  `YYYY-MM-DD-<slug>.<session-id>.jsonl`. A copy is a snapshot — live sessions
  keep appending; re-snapshot at session end.
- `streams/distillations/` — **committed tiered compressions** of raw streams.
  Tier 1 = one session → decisions, principles, spawned threads, artifacts,
  with `@thread-id` links so the fact graph and the narrative cross-reference.
  Files: `YYYY-MM-DD-<slug>.tier1.md`.

Provenance contract: every distillation names its raw source(s) and the tern
thread minted for the session (`stream thread`), which carries `relates_to`
edges to every thread the conversation spawned. Chain: utterance → distillation
→ stream thread → spawned thread → outcome fact → commit. Queryable end to end.

Mining (retry loops, verb votes, doc re-reads) is `tern-mine`'s job, not this
layer's — raw here is its input corpus.

## Cost contract — this layer is nearly free; keep it that way

- **Raw capture = `cp`, zero tokens.** The Claude Code harness already appends
  the full transcript to `~/.claude/projects/<proj>/<session>.jsonl` in real
  time, mechanically. Never have a model regenerate conversation text into a
  file; snapshot the file the harness already wrote.
- **Distillation = cheap-tier agent** (sonnet-worker / haiku), never the
  coordinator model. Exception: if the coordinator already holds the whole
  session in context at session end, its ~1k-token summary is cheaper than a
  fresh agent re-parsing megabytes of JSONL — allowed, but that's the only case.
- **Coordinator's only job**: mint the stream thread + `relates_to` edges
  (a handful of facts).
