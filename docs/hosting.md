# Hosting North

North runs three ways off **one architecture** — your laptop, a server you own,
or a multi-tenant service you host for others. There is no fork in the design; the
only thing that changes between modes is the **transport in front of the
coordinator socket**. This doc covers all three and is honest about what's built,
what's an MVP, and what's still ahead.

## The architecture (recap)

```
threads/*.md ──import──▶ facts.log (append-only) ──fold──▶ in-memory graph
                                                              │
                              coordinator daemon  ◀── clients query + assert
                              (sole writer, 127.0.0.1)        │
                                                   consumer (North) derives
                                                   ready / blocked / leverage / clock
```

- **Truth** is an append-only `facts.log` of `(subject, predicate, object)` triples.
- **The coordinator** is a single-writer babashka daemon: it folds the log into an
  in-memory graph and serves `query`/`assert`/`retract` over a **loopback** socket
  with optimistic concurrency and commit-time rule checks. It binds `127.0.0.1`
  and is **unauthenticated by design**.
- **North** is the life domain on top (lifecycle projections, clock, billing).
- **Runtime dependency is just [babashka](https://babashka.org)** — the compiled
  Clojure is committed in both repos (`out/`); Beagle is only needed to rebuild.

Everything below is about what sits *in front of* that loopback socket.

---

## Mode 1 — Self-host, single machine (works today)

The default. One operator, one box, the coordinator on `127.0.0.1`.

```sh
git clone https://github.com/tompassarelli/fram     ~/code/fram
git clone https://github.com/tompassarelli/north ~/code/north
~/code/north/bin/north up        # start the coordinator (idempotent)
~/code/north/bin/north ready     # use it
```

No build step (runs on the committed `out/`), no network exposure, no auth needed.

## Mode 2 — Self-host, remote box you own

Same as Mode 1 on a server, with one of:

- **SSH tunnel (zero new components):** run the coordinator on the box; forward the
  loopback port to your workstation: `ssh -L 7977:127.0.0.1:7977 you@box`. Before
  using the local CLI/MCP, obtain the remote corpus identity with
  `ssh you@box realpath -m /var/lib/north/facts.log`, then set local `FRAM_LOG`
  to that exact canonical absolute string. Every managed request carries this
  fence and the strict remote coordinator rejects a mismatch. If the same string
  canonicalizes differently on the workstation (for example through a local
  symlink), use the gateway instead; it injects the remote registry-owned identity.
  Good for one person.
- **The auth gateway (for non-SSH clients / an AI over HTTP):** put `deploy/gateway`
  in front (bearer token → your single tenant → the coordinator), TLS via a reverse
  proxy. This is the same component the SaaS mode uses, with one tenant.

## Mode 3 — Multi-tenant SaaS (you host for others)

**Model: instance-per-tenant.** Each account gets its own coordinator + its own
`facts.log`. An authenticated gateway routes each request to the right one.

```
                         ┌─ coordinator(acme)   + acme/facts.log
client ─HTTPS─▶ proxy ─▶ gateway ─┼─ coordinator(globex) + globex/facts.log
              (TLS)   (authn +    └─ coordinator(…)      + …/facts.log
                       tenant route)
```

Build the image, provision tenants, run it — see `deploy/README.md` and
`deploy/docker-compose.example.yml`. Provisioning mints a bearer token, starts the
tenant's coordinator, and registers it; the gateway authenticates and forwards.

Coordinators run either **co-located** with the gateway (loopback, the default) or
on **separate hosts/containers** — set `FRAM_BIND=0.0.0.0` on the coordinator and
the tenant's `:coordinator-host` in the registry. Both paths are exercised in CI
(`deploy/gateway/smoke_test.sh` loopback; `crosshost_test.sh` non-loopback).
In either topology, run the coordinator with `FRAM_REQUIRE_LOG_FENCE=1` and set
`:coordinator-log` to the coordinator host's canonical absolute `FRAM_LOG`
exactly. A remote corpus path is protocol data; the gateway must not translate
it to its own mount namespace.

### Why instance-per-tenant (not one shared graph)

- **Isolation is the only safe boundary.** The per-assertion `frame` records *who
  asserted* a fact — it's provenance, not authorization. A shared graph
  partitioned by frame would let any authenticated caller assert any frame. So
  tenancy = **separate logs + separate coordinators**, full stop.
- **The architecture makes it cheap.** A tenant is *already* just "a log + a
  coordinator on a port." Instance-per-tenant falls out for free — no shared-state
  redesign, no distributed consensus.
- **Right-sized safety.** Single-writer + optimistic concurrency is exactly the
  model you want *per tenant*; you run N small independent authorities, not one big
  contended one.
- **Scale.** Each personal graph is small and its writes serialize through one warm
  process (µs commits). You scale by adding tenant instances across hosts, not by
  scaling one graph. Very large *single* tenants would eventually swap the
  in-memory-fold + flat-log for a transactional store (XTDB/Datomic/Datahike) — the
  fact model is unchanged; only the substrate underneath swaps.

---

## Security model

- The raw coordinator protocol is **unauthenticated** — it must never be exposed.
  Only the gateway is reachable, and only behind TLS.
- Deployed coordinators require a corpus fence (`FRAM_REQUIRE_LOG_FENCE=1`).
  The gateway supplies the authenticated tenant's exact identity; raw or
  mismatched requests fail closed before a read or write.
- The gateway authenticates a **bearer token**, stored **hashed** (sha-256) in the
  registry; it maps the token to exactly one tenant's coordinator.
- Coordinators default to **loopback** (same host). To run them on separate
  hosts/containers, set **`FRAM_BIND=0.0.0.0`** and point the gateway's
  `:coordinator-host` at the private address; the raw port is still never publicly
  exposed (gateway-only ingress). Add mTLS between gateway and coordinator over
  untrusted links.
- Plain-text data, no telemetry, `export` is fact-identical — the leave-anytime
  guarantee holds in every mode, including hosted.

## Operations

- **Backups:** each tenant's `facts.log` is append-only plain text — back it up
  with `git`/snapshots/object storage. `import`/`export` round-trips are lossless.
- **Supervision:** systemd template unit per tenant (`north-coordinator@<id>`)
  + the gateway unit; both `Restart=on-failure`. The example template shares one
  `north` Unix identity, so it is a same-trust-host convenience, not a
  hostile-tenant filesystem boundary. For mutually untrusted tenants, use one
  container per coordinator with only that tenant's directory mounted; the
  gateway mounts only its registry directory. Start a supervised coordinator
  first, then use `provision.sh register-existing` to prove strict same-log
  readiness and publish its route; the standalone create mode owns its own
  daemon and must not share a port with systemd.
- **Upgrades:** pull the repos (or a new image tag) and restart; the log format is
  stable and forward-only.
- **Health:** gateway `GET /healthz`; coordinator readiness via a fenced
  `north coord-doctor`. A raw `{:op :version}` must return
  `:code :log-fence-required`; mere socket liveness is not strict readiness.

---

## Status — built vs. MVP vs. planned

| Capability | State |
|---|---|
| Fact log, fold, Datalog derivation, single-writer coordinator | **built** (Fram, tested) |
| Lifecycle/clock/billing projections | **built** (North, tested) |
| Runs on bare babashka, no build step | **built** (`out/` committed) |
| Single-machine + SSH-tunnel remote | **built** |
| Authenticated gateway (bearer → tenant → coordinator), per-tenant isolation | **built** (`deploy/gateway`, smoke-tested in CI) |
| Token rotation/revocation, audit logging, rate limit + body cap | **built** (gateway; covered by the smoke test) |
| Tenant provisioning + systemd/Docker/compose | **built** (`deploy/`) |
| TLS termination | **built** example (`deploy/Caddyfile.example`) — delegated to a reverse proxy |
| Per-tenant backups (snapshot + prune, timer) | **built** (`deploy/backup.sh` + `north-backup.{service,timer}`) |
| Cross-host coordinators (`FRAM_BIND=0.0.0.0` + `:coordinator-host`) | **built** (Fram `FRAM_BIND`; gateway routing; `crosshost_test.sh` in CI) |
| mTLS between gateway and coordinator (untrusted links) | **planned** |
| Control plane (provisioning API, quotas, key mgmt beyond a file) | **planned** |
| Self-service signup, billing, web client | **planned** (product layer) |
| Transactional store swap for very large single tenants | **planned** (model-stable) |

## Roadmap (in dependency order)

1. ~~**Harden the gateway:** token rotation/revocation, request caps, audit logging.~~ **Done** — `deploy/gateway`.
2. ~~**Configurable coordinator bind** so coordinators can live on separate hosts behind the gateway.~~ **Done** — Fram `FRAM_BIND` (default loopback); gateway `:coordinator-host`; `crosshost_test.sh` in CI.
3. **mTLS** between gateway and coordinator for untrusted networks (today: keep coordinators on a private network / same host).
4. **Control plane:** provisioning/lifecycle API, per-tenant daemon supervision,
   quotas, key management beyond a flat registry.
5. **Product layer:** self-service signup, billing, web client, teams. (See
   [`product-surface-design.md`](product-surface-design.md) for the life-verb edge.)
6. **Scale path:** transactional store option for outsized single tenants.

None of this is a foundation rewrite — it's the product layer the
[proposal](PROPOSAL.md) (Phases 4–5) already mapped.

### The engine ↔ app seam (where Fram ends and North begins)

The two repos meet at exactly one interface — the coordinator's line-delimited EDN
wire protocol. The durable contract-of-record lives in Fram at
`docs/coordinator-bind-and-wire.md` (the seam, the protocol surface, the
`FRAM_BIND` security invariant, and the topology). North consumes that protocol
through the gateway and links Fram's library API for projections (pinned via
the `fram` input in [`flake.lock`](../flake.lock)); it never reaches past the
protocol into engine internals.
