# North auth gateway

The network-safe edge in front of the (loopback-only, unauthenticated) coordinator.
It is the single component that takes North from *single-machine* to *remote
and multi-tenant* — without changing the fact model, the write-safety, or the
"export and walk away" guarantee.

```
client ──HTTPS──▶ reverse proxy (TLS) ──HTTP──▶ gateway ──fenced EDN──▶ tenant coordinator
                                                  │  bearer → tenant → port + exact log
```

## Why a gateway (and why per-tenant)

The coordinator is a sole-writer daemon that binds `127.0.0.1` and speaks an
**unauthenticated** line-delimited EDN protocol. That's correct for a single
operator on one machine. To serve other people you need (a) authentication and
(b) tenant isolation. The gateway adds both, and isolation is done the only safe
way: **one coordinator + one `facts.log` per tenant.** The per-assertion `frame`
is *provenance, not authorization* — never the tenancy boundary.

## Endpoints

| method | path | auth | body | does |
|--------|------|------|------|------|
| `GET`  | `/healthz` | none | — | liveness, `200 ok` |
| `POST` | `/v1/rpc`  | `Authorization: Bearer <token>` | one unfenced EDN map, e.g. `{:op :version}` | injects the registry-owned tenant corpus fence, forwards, and relays the EDN reply |

`:op` values are the coordinator's: `:version`, `:status`, `:validate`,
`:assert {:te :p :r :base}`, `:retract {…}`. Bad/missing token → `401`;
rate-limited → `429`; body over the cap → `413`; malformed body → `400`;
coordinator down → `502`.

## Config (env)

- `GATEWAY_PORT` — listen port (default `8088`). **Plain HTTP by design** — put TLS in front.
- `GATEWAY_TENANTS` — path to the registry (default `./tenants.edn`):

```clojure
{"acme"   {:tokens #{"<sha256-hex>" "<sha256-hex>"}
           :coordinator-port 7801
           :coordinator-log "/srv/north/tenants/acme/facts.log"}
 "globex" {:tokens #{"<sha256-hex>"}
           :coordinator-port 7802
           :coordinator-host "10.0.0.5"
           :coordinator-log "/srv/north/tenants/globex/facts.log"}}
```

- `GATEWAY_AUDIT_LOG` — path for structured audit lines (default: stderr).
- `GATEWAY_RATE` / `GATEWAY_BURST` — per-tenant token-bucket limit (default `20`/s, burst `40`).
- `GATEWAY_MAX_BODY` — max request body bytes (default `65536`; over it → `413`).

`:tokens` is a **set** of accepted token hashes (sha-256 hex, never plaintext) so
rotation keeps old + new valid during a grace window; the legacy `:token-sha256
"<hex>"` form is still accepted. `:coordinator-host` is optional (default
`127.0.0.1`). `:coordinator-log` is required and must be the exact canonical
absolute `FRAM_LOG` on the coordinator host. For a remote coordinator, derive it
on that host with `realpath -m`; the gateway does not reinterpret it as a local
path. Clients cannot provide a `:for-log` operation themselves. The registry is
re-read from a bounded snapshot and invalidated by its content digest, so even a
same-size, same-timestamp `provision.sh` rotate/revoke takes effect with **no
gateway restart**.

## Run it

```sh
# standalone: start a strict coordinator, then atomically register it
./provision.sh acme 7801                 # prints the bearer token ONCE

# supervised: start the systemd/container coordinator first, then prove strict
# same-log readiness and register it without claiming or restarting its process
./provision.sh register-existing acme 7801 /var/lib/north/tenants/acme/facts.log

# rotate (issue a new token; the old one keeps working until you revoke it)
./provision.sh rotate acme               # prints the new token; clients roll over
./provision.sh revoke acme <old-token>   # then drop the old one — no downtime

# start the gateway
GATEWAY_TENANTS=$PWD/tenants.edn bb gateway.clj

# call it
curl -s -H "Authorization: Bearer <token>" --data '{:op :version}' \
  http://127.0.0.1:8088/v1/rpc
```

Run `register-existing` on the coordinator host: it probes that host's loopback
listener and publishes only after fenced same-log version succeeds and an
unfenced probe returns the exact strict-policy rejection.

`./smoke_test.sh` stands up a real coordinator + gateway and asserts: authed
requests reach the coordinator, unauthed → `401`, oversized → `413`, the audit log
captures the request, a wrong corpus mapping fails closed, raw coordinator
requests are rejected, and a revoked token → `401`. This runs in CI.

## Hardening status

Built and tested here:

- [x] **Corpus-bound routing** — the registry owns the absolute log identity;
      deployed coordinators require it, the gateway injects it, and
      client-authored fences are rejected.
- [x] **Authentication** — bearer token → tenant, hashes stored not plaintext.
- [x] **Tenant isolation** — one coordinator + `facts.log` per tenant.
- [x] **Token rotation + revocation** — `:tokens` set; `provision.sh rotate/revoke`.
- [x] **Audit logging** — one EDN line per request (`:tenant :op :te :p :status`);
      **never logs the object value** `:r`. Unauthorized attempts are logged too.
- [x] **Rate limiting + body-size cap** — per-tenant token bucket; bounded read → `413`.
- [x] **TLS** — terminate in a reverse proxy; see `../Caddyfile.example`.
- [x] **Supervision** — `../north-coordinator@.service` + `../north-gateway.service`.
- [x] **Cross-host coordinators** — Fram `FRAM_BIND=0.0.0.0` + the registry's
      `:coordinator-host`; exercised by `./crosshost_test.sh` in CI.

Still ahead (see `../../docs/hosting.md`):

- [ ] **mTLS** between gateway and coordinator for untrusted networks (today: keep
      coordinators on a private network / same host).
- [ ] **Control plane** — provisioning API, quotas, key management beyond a file.

See `../../docs/hosting.md` for the full picture and roadmap.
