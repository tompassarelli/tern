# Product surface: exposing the life verbs to remote clients

> **STATUS: DESIGN — not built.** This is design/analysis for how the hosted
> Tern product should expose its real "life verbs" (`ready`, `plate`,
> `capture`, `clock`, …) to remote clients. Nothing here is implemented yet.
> It is also deliberately **sequenced behind Fram's current churn** — see
> §5. Treat the recommendation as the intended path, not a shipped capability.
> Companion to [`hosting.md`](hosting.md) (transport/tenancy + the engine↔app
> seam) and Fram's `docs/coordinator-bind-and-wire.md` (the wire contract).

## 1. Problem statement

The hosted product today exposes **the engine, not the app.**

Walk the seam as it actually is:

- A tenant instance is **one `fram-daemon` + one `facts.log`** (see
  `deploy/tern-coordinator@.service`, `deploy/docker-compose.example.yml`).
  There is no Tern process in a tenant — only the Fram coordinator.
- The gateway (`deploy/gateway/gateway.clj`) authenticates a bearer token, maps
  it to a tenant, and forwards **one raw EDN coordinator op** to that tenant's
  coordinator socket: `:assert` / `:retract` / `:version` / `:status` /
  `:validate`. That's the whole `POST /v1/rpc` contract. It runs **no Tern
  projections** — it relays bytes to Fram and relays the reply back.
- But the real life verbs — `ready`, `blocked`, `next`, `plate`, `agenda`,
  `leverage`, `show`, `needs-review`, `capture`, `clock start/stop/status/report`,
  `presentation` — live in `tern.main` (and the MCP server that wraps it),
  **not in the engine.** Reads *fold the tenant's `facts.log` locally* and
  derive lifecycle (`cmd-ready`, `cmd-plate`, etc. all do
  `(fold/fold (fram.rt/read-log log))` then project); writes (`capture`, `clock`)
  go through the coordinator via `coord-assert`/`coord-retract`.

**The gap:** a remote client hitting the gateway can do raw engine asserts and
reads, but **cannot get `ready` / `plate` / `capture` / `clock`.** Those require
running Tern's projections over the tenant's folded log, and nothing on the
hosted path does that.

What a real remote client actually needs:

- **A chat AI** wants the MCP tool surface that already exists (`bin/tern-mcp`):
  `capture`, `tell`, `plate`, `next`, `clock_*`, with the cheatsheet/presentation
  contract — over a *remote* transport, authenticated, per tenant. Today that MCP
  server is **stdio-only and local** (its own header says "HTTP/SSE + auth is the
  next layer").
- **A web app** wants stable HTTP endpoints returning the structured JSON the CLI
  already emits (`json plate|ready|blocked|needs-review|clock-report|show|presentation`
  → the `JThread`/`JClockReport`/… records in `main.bclj`).

Both need the **app domain**, hosted and authenticated. The engine RPC the
gateway forwards is necessary plumbing but is not the product.

## 2. Options for the product surface

All three keep the tenancy model from `hosting.md` intact (instance-per-tenant,
gateway authenticates + routes, coordinator is the sole writer). They differ in
**where the projection fold runs** and **how warm it is.** Note the shared
constraint: projections fold *that tenant's log* — so every option is
tenant-scoped, and any folding process must run with that tenant's `FRAM_LOG`.

### (a) Gateway shells out to the tenant's `tern` CLI per request

New life-verb HTTP routes on the gateway (e.g. `POST /v1/verb/{name}`) that
`proc/sh` the tenant's `tern` binary with the tenant's env (`FRAM_LOG`,
`FRAM_THREADS`, provenance vars), exactly like `bin/tern-mcp` already does
locally, and return the (JSON) stdout.

- **+** Smallest possible design. Reuses every tested verb verbatim; the MCP
  server is already this pattern (`call-tool` → `proc/sh engine argv`).
- **+** Stateless — no new long-lived per-tenant process; composes cleanly with
  the existing gateway and the systemd/compose topology.
- **−** **Babashka cold-start per call.** Each verb spawns a fresh `bb -m
  tern.main`, which re-reads and re-folds the whole `facts.log` every time.
  Fine at personal-graph size and low call rates; visibly bad for a chatty AI or
  a web UI that fans out several reads per view.
- **−** Reads bypass the warm coordinator graph entirely — the CLI folds the log
  off disk. Correct, but redundant work the coordinator already did in memory.

### (b) Warm per-tenant Tern service

One long-lived Tern process per tenant that holds the **folded graph** in
memory and serves life verbs over a socket; the gateway routes to it the same
way it routes to the coordinator. Effectively: promote the projection layer to a
resident server (a "read replica / app head" beside each coordinator).

- **+** **Fast reads** — fold once, project on a warm index; no per-call
  cold-start, no re-read. This is the natural home for `ready`/`plate`/`leverage`
  at interactive latency.
- **+** Can subscribe to the coordinator's event stream (`{:op :subscribe}` in
  the wire contract) to stay fresh without re-reading the log.
- **−** **More moving parts and memory:** a second resident process per tenant,
  its own supervision unit, its own liveness/freshness story (it can go stale vs
  the log — the same hazard `cmd-doctor` already guards against locally).
- **−** Writes still must go through the coordinator (sole writer) — so this
  process is a *read/derivation head*, not a second writer. Clear, but it means
  two daemons per tenant doing related work.
- **−** Heaviest coupling to Fram's **library** API (`fram.kernel`/`fold`/`rt`),
  because it embeds the fold loop as a server. Most exposed to Fram churn.

### (c) MCP-over-HTTP per tenant, behind the gateway

Take the existing `bin/tern-mcp` tool surface and serve it over the standard
**remote-MCP HTTP transport** (Streamable HTTP / SSE) instead of stdio, fronted
by the gateway for auth + tenant routing. Per tenant, the MCP server runs with
that tenant's env and reaches the verbs the same way it does now (shelling the
`tern` engine, i.e. it inherits whichever read path (a) or (b) provides).

- **+** **Reuses the entire MCP tool surface** that exists and is shaped for AI
  clients — tools, `inputSchema`, the cheatsheet (`instructions`), the
  presentation contract. A chat AI connects to a URL with a bearer token and gets
  the same tools it gets locally today.
- **+** It's a *transport swap*, not a redesign — the header of `tern-mcp`
  literally says this is "the next layer."
- **+** Composes with (a) or (b): the MCP server's read latency is whatever the
  underlying verb path gives it.
- **−** Doesn't itself solve cold-start; it's an edge over (a)/(b).
- **−** Adds an MCP HTTP listener per tenant (or one multiplexed MCP edge that
  routes by token) — auth must integrate with the gateway's token→tenant map so
  there isn't a second auth system.
- **−** This is exactly where the **Fram-MCP collision** has to be resolved (§4):
  there must be a clean answer to "engine MCP vs app MCP."

## 3. Recommendation

**Primary path: (c) MCP-over-HTTP per tenant, started on top of (a) shell-out,
with (b) as the performance upgrade we grow into.**

Rationale:

- The **product surface that matters first is the AI client**, and the MCP tool
  surface for it **already exists and is tested** (`bin/tern-mcp`). Shipping
  it remotely is a transport + auth job, not new domain code. That is the
  cheapest path to "a remote chat AI can actually run the life verbs."
- Underneath it, **start with (a) shell-out** for the verb implementations: zero
  new resident state, reuses every verb verbatim, and is correct at personal-graph
  size. Cold-start is the only cost and it's tolerable at MVP traffic.
- **Grow into (b)** — the warm per-tenant Tern head — *only when read latency
  or call volume demands it.* When it lands, it slots in **under** the same MCP/HTTP
  edge: the edge contract (tools, JSON shapes) doesn't change, only what's behind
  it. So (b) is a non-breaking performance swap, not a fork.

What it composes with:

- The **web app** gets the same thing for free via the MCP server's structured
  results, or via a thin parallel set of `GET /v1/verb/*` JSON routes backed by
  the identical verb path. Either way it's the same projection code.
- **Writes** in all cases still funnel to the coordinator (sole writer) — the
  gateway's existing `:assert`/`:retract` path is reused unchanged; `capture` and
  `clock` already drive it. We are adding a **read/derivation edge**, not a second
  write path.
- The gateway stays the **one auth point.** The MCP/HTTP edge authenticates by
  reusing the gateway's token→tenant registry (one auth system, not two).

Net: one new component (a per-tenant, gateway-fronted MCP/HTTP edge over the
existing verb path), an upgrade path (warm head) that doesn't change the contract,
and no second auth or second writer.

## 4. The MCP seam — engine MCP vs. app MCP

Fram has added its **own engine-level MCP + structured-query surface**; Tern
already has an MCP server. They must not duplicate or fight. The rule mirrors the
repo seam (see `hosting.md` → "The engine ↔ app seam"): **Fram owns the neutral fact engine; Tern
owns the life domain.** MCP-wise:

| | **Engine MCP (Fram)** | **App / life MCP (Tern)** |
|---|---|---|
| Mental model | "query/assert facts" | "run my work + life" |
| Audience | tools reasoning about the *fact graph* generically | a chat AI / app reasoning about *threads, plates, time* |
| Surface | neutral query (datalog/structured), `assert`, `retract`, `validate`, `version`, `status` | `ready`, `next`, `plate`, `blocked`, `agenda`, `leverage`, `show`, `needs_review`, `capture`, `tell`, `untell`, `clock_*`, `presentation` |
| Semantics | knows triples; **no lifecycle, no clock, no presentation** | derives lifecycle (committed/outcome/abandoned/driver/depends_on), clock roll-up, emoji contract |
| Where it folds | the coordinator's in-memory graph | folds the tenant's `facts.log` (today via the CLI verbs) |
| Vocabulary | engine-generic (subject/predicate/object) | life vocab (`@topic-*`, `do_on`, `estimate_hours`, `session_of`, …) |
| Owns | Fram repo | Tern repo |

Boundary rules:

1. **No life verbs in the engine MCP.** `ready`/`plate`/`clock` are derivations
   over the *life* vocabulary; they stay in Tern. Fram exposing them would
   pull domain code into the engine — the exact complecting the engine↔app
   seam forbids.
2. **No raw-fact manipulation duplicated in the life MCP.** Tern's `tell`/
   `untell`/`capture` are *opinionated, provenance-stamped* writes (see
   `capture-facts` — it stamps `source`/`created_by`/`lead`/`committed`/…). The
   engine MCP's `assert`/`retract` are the *neutral* primitive. Tern's writes
   ultimately bottom out on the same coordinator ops, but the life MCP should not
   re-expose a bare `assert` as a "Tern" tool — that's the engine's job.
3. **One does not proxy the other.** The life MCP reaches facts by folding the
   tenant log / driving the coordinator directly (as it does now), **not** by
   calling the engine MCP. The two MCP servers are siblings over the same
   coordinator, layered by altitude, not stacked.
4. **If both are offered to one AI client, advertise them as distinct servers**
   (`fram` = engine, `tern` = life) so tool names don't collide and the model
   picks by altitude. Default product posture: **expose the Tern/life MCP**;
   the engine MCP is for graph-level tooling, not the everyday "run my life" client.

This keeps the wire contract intact: the two repos meet only at
the coordinator wire protocol; the two MCPs are just two clients of it at two
altitudes.

## 5. Dependencies and sequencing

**What is Fram-coupled (build *after* the churn settles, against a pinned Fram):**

- Anything that **runs projections** is coupled to Fram's **library** API
  (`fram.kernel` / `fold` / `import` / `export` / `clock` / `json` / `rt`) —
  `main.bclj` `require`s all of them and `declare-extern`s the `fram.rt/coord-*`
  bridge. So:
  - Option **(a)** shell-out: coupled only indirectly (it spawns the CLI, which is
    coupled) — least exposed, but still needs a stable CLI/lib.
  - Option **(b)** warm head: **most** coupled — it embeds the fold loop as a
    resident server against the lib API. Build this last, against a **pinned Fram
    version**, after Fram's in-flight changes (incl. its new engine MCP / query
    surface) settle.
- The **wire-protocol contract** (Fram's `coordinator-bind-and-wire.md`): if Fram's "big
  updates" change `:assert`/`:retract`/`:subscribe`/`:status`, that is a breaking
  change for the gateway *and* for any warm head subscribing to events. Pin it;
  version it if it moves.

**What is NOT Fram-coupled (can be designed/started independently):**

- The **MCP-over-HTTP transport + auth integration** (option (c)'s edge): it's
  JSON-RPC over HTTP/SSE plus the gateway's existing token→tenant map. Pure
  Tern/gateway work; touches no engine internals.
- The **gateway life-verb routing** (auth, tenant lookup, rate limit, audit,
  body caps) — all already exist in `gateway.clj` and are reused.
- The **MCP seam definition** (§4) — a design/coordination artifact; settle it
  with the Fram agent now so neither side builds the wrong surface.

**Phased plan:**

- **Phase 0 (now, no code): coordinate the seam.** Agree §4 with the Fram agent so
  the two MCPs are siblings by altitude, and confirm the wire contract Fram will
  pin to. (This doc is that artifact.)
- **Phase 1: remote transport over shell-out (least Fram risk).** Put the existing
  MCP tool surface behind the gateway over HTTP/SSE, authenticated by the existing
  token→tenant registry, with verbs implemented by shelling the tenant's
  `tern` CLI (option a+c). Ships "a remote AI can run the life verbs" with no
  engine change. Add parallel `GET /v1/verb/*` JSON routes for the web app off the
  same path if/when needed.
- **Phase 2 (after Fram churn settles, against a pinned Fram): warm per-tenant
  head.** Introduce the resident Tern projection process (option b) as a
  non-breaking performance swap under the same edge — fold once, subscribe to the
  coordinator event stream, serve warm reads. Reuse `cmd-doctor`'s freshness logic
  as the staleness guard.
- **Phase 3: product polish.** Supervision (a per-tenant head unit alongside the
  coordinator unit), quotas/observability on the life-verb edge, and the
  control-plane hooks already on the `hosting.md` roadmap.

This adds the **app** to the hosted surface without touching the engine until the
churn settles, keeps **one** auth point and **one** writer, and leaves the
leave-anytime / plain-text / fact-identical-export guarantees from `hosting.md`
untouched in every mode.

---

### Status — built vs. planned (this surface)

| Capability | State |
|---|---|
| Gateway: auth, token→tenant route, raw engine RPC (`:assert`/`:retract`/`:version`/`:status`/`:validate`) | **built** (`deploy/gateway`) |
| Local MCP tool surface (life verbs over stdio) | **built** (`bin/tern-mcp`) |
| Remote life verbs for a hosted client (`ready`/`plate`/`capture`/`clock` over HTTP) | **planned — this doc** |
| MCP-over-HTTP + gateway auth integration (Phase 1) | **planned** (not Fram-coupled) |
| Warm per-tenant Tern head (Phase 2) | **planned** (Fram-coupled — after churn, pinned Fram) |
| Engine-MCP vs life-MCP seam (§4) | **design agreed here; coordinate with Fram before building** |
