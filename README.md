# Lodestar

The life app — what you steer by. Capture an intention; query what's **ready**,
**blocked**, and the highest-leverage keystone. The board is *derived* from a
graph of claims, never hand-maintained.

Lodestar is a **consumer of the [Fram](https://github.com/tompassarelli/fram)
engine** (a domain-neutral claim substrate). It supplies the *life domain*: the
lifecycle projections, the cardinality vocab (`FRAM_SINGLE_VALUED`), capture
conventions, time tracking, and the operating manual.

Run it three ways off one architecture — **on your laptop, on a server you own,
or as a multi-tenant service you host for others.** No fork in the design; only
the transport in front of the coordinator changes. See **[docs/hosting.md](docs/hosting.md)**
and **[deploy/](deploy/)**. The conventions are still shaped around how one
operator works — adapt the wrapper to your own setup.

## Shape

- **Engine** → [Fram](https://github.com/tompassarelli/fram) (`~/code/fram`):
  claims, Datalog, the coordinator daemon. The hard substrate.
- **Life domain** → `src/lodestar/{projections,clock,clockify,staleness,audit}.bclj`:
  the lifecycle derivations, billing projection, and staleness layer that make
  the engine a life app.
- **CLI** → `bin/lodestar`: aims the Fram engine at your data and sets capture
  provenance defaults. Life verbs (`ready`/`blocked`/`leverage`/`next`/`agenda`/
  `plate`/`capture`/`clock`/…) route to `lodestar.main`; engine verbs
  (`import`/`export`/`show`/`validate`/`tell`/`untell`/…) route to Fram.
- **MCP** → `bin/lodestar-mcp`: the AI-facing edge — every tool maps to a tested
  CLI op through the coordinator write path.
- **Data** → your own private store (the canonical `claims.log`, projected to
  `~/.local/state/lodestar/` at runtime). Data is **not** part of this repo.

## Hosting

- **[docs/hosting.md](docs/hosting.md)** — the three modes (self-host single box,
  self-host remote, multi-tenant SaaS), the instance-per-tenant model, security,
  ops, and the roadmap.
- **[deploy/](deploy/)** — `Dockerfile`, `docker-compose.example.yml`, systemd
  units, and the authenticated **[gateway](deploy/gateway/)** (bearer token →
  tenant → that tenant's coordinator) with `provision.sh` + an integration test.

## Docs

- `docs/operating-manual.md` — the working manual: thread model, claim format,
  derived lifecycle, the CLI surface, and session behavior.
- `docs/claim-native-redesign.md` — the design record for the claim-native model.
- `docs/PROPOSAL.md` — the original vision and architecture.

## Running and building

**Running needs only [babashka](https://babashka.org)** — the compiled Clojure is
committed in `out/` (no Beagle required at runtime), same as Fram. You need the
Fram engine checked out too (`FRAM_HOME`, default `~/code/fram`); `bin/lodestar`
puts both on the classpath.

Lodestar links Fram's library API, so it's **pinned** to a specific Fram commit in
[`FRAM_VERSION`](FRAM_VERSION) (CI and the Dockerfile read it). Fram's `main` moves
independently; bump the pin deliberately when you rebuild `out/` against a newer
engine.

To **rebuild** from the `.bclj` sources you also need
[Beagle](https://github.com/tompassarelli/beagle) (the Lisp Lodestar is written
in). `build.sh` links the engine sources in (`src/fram`, gitignored) and compiles
the life-domain modules into `out/`; commit the result when sources change. Set
`FRAM_HOME`/`BEAGLE_HOME` if they aren't at `~/code/fram` / `~/code/beagle`.

## Tests

```sh
CP="out:$FRAM_HOME/out"
bb -cp "$CP" clock_test.clj
bb -cp "$CP" staleness_test.clj
FRAM_LOG="$FRAM_HOME/claims.log" bb -cp "$CP" cnf_lifecycle_test.clj
bash deploy/gateway/smoke_test.sh        # gateway auth + routing
```

## License

MIT — see [LICENSE](LICENSE).
