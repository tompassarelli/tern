# deploy/

Artifacts for running North as a service. Full architecture and the three
hosting modes are in [`../docs/hosting.md`](../docs/hosting.md); this is the
quick index.

| file | what |
|------|------|
| `gateway/` | the authenticated multi-tenant edge (token → tenant → coordinator); auth, rotation/revocation, audit log, rate limit + body cap; `provision.sh` + smoke test |
| `../Dockerfile` | one runtime image (bb + Fram + North); runs as a coordinator or the gateway |
| `docker-compose.example.yml` | example one-host topology: a gateway + one coordinator per tenant |
| `north-coordinator@.service` | systemd template — one coordinator per tenant |
| `north-gateway.service` | systemd unit — the gateway |
| `Caddyfile.example` | reverse proxy terminating TLS in front of the gateway |
| `backup.sh` + `north-backup.{service,timer}` | per-tenant `facts.log` snapshot + prune, on a daily timer |

## The shape

Each tenant is an isolated **coordinator + `facts.log`**. The gateway authenticates
a request and routes it to that tenant's coordinator. Coordinators default to
loopback (co-located); for separate hosts/containers, set `FRAM_BIND=0.0.0.0` on the
coordinator and the tenant's `:coordinator-host` in the registry (the compose example
does this on a bridge network). Every deployed coordinator also runs with
`FRAM_REQUIRE_LOG_FENCE=1`: an unfenced request is rejected before it can read or
write. Only the gateway is ever publicly exposed.

`:coordinator-log` is a protocol identity, not a gateway-local file lookup. It
must equal the coordinator host's canonical absolute `FRAM_LOG` byte for byte.
For a remote host, obtain it there with `realpath -m /var/lib/north/tenants/acme/facts.log`;
do not substitute a gateway-side mount path. `provision.sh` canonicalizes the
co-located path before it atomically publishes the route.

## Fastest real deployment (systemd, one same-trust host)

```sh
# 0. prerequisites on the box: babashka, plus Fram + North at /opt
sudo install -d -m 0755 -o root -g root /opt /etc/north
sudo install -d -m 0700 -o north -g north /var/lib/north
sudo git clone https://github.com/tompassarelli/fram     /opt/fram
sudo git clone https://github.com/tompassarelli/north /opt/north

# 1. install/configure the units and tenant directory
sudo cp /opt/north/deploy/north-coordinator@.service /etc/systemd/system/
sudo cp /opt/north/deploy/north-gateway.service       /etc/systemd/system/
sudo install -d -m 0700 -o north -g north /var/lib/north/tenants/acme
sudo -u north touch /var/lib/north/tenants/acme/facts.log
sudo chmod 0600 /var/lib/north/tenants/acme/facts.log
printf 'FRAM_PORT=7801\nFRAM_LOG=/var/lib/north/tenants/acme/facts.log\n' \
  | sudo tee /etc/north/acme.env
printf 'GATEWAY_PORT=8088\nGATEWAY_TENANTS=/var/lib/north/tenants.edn\n' \
  | sudo tee /etc/north/gateway.env
sudo systemctl daemon-reload
sudo systemctl enable --now north-coordinator@acme

# 2. prove the supervised coordinator is strict + exact-log, then register it
#    and mint its first token (printed once)
sudo -u north env GATEWAY_TENANTS=/var/lib/north/tenants.edn \
  NORTH_TENANT_ROOT=/var/lib/north/tenants \
  /opt/north/deploy/gateway/provision.sh register-existing \
  acme 7801 /var/lib/north/tenants/acme/facts.log

# 3. start the gateway only after the authenticated route exists
sudo systemctl enable --now north-gateway

# 4. put TLS in front of :8088 (Caddy one-liner): reverse_proxy 127.0.0.1:8088
```

For an unsupervised standalone trial, `provision.sh acme 7801` starts a strict
coordinator through `north-coord-up` and then publishes its route. Do not start
the systemd template on that same port: choose either the standalone owner or
the supervised start-then-`register-existing` flow.

## Security

- The raw coordinator port is **unauthenticated** — never expose it; only the
  gateway is reachable, and only through TLS.
- Coordinators fail closed on missing corpus fences
  (`FRAM_REQUIRE_LOG_FENCE=1` is fixed in the systemd unit and compose example).
- Tenant bearer tokens are stored **hashed** (sha-256). `provision.sh` prints the
  plaintext once.
- Run as a dedicated unprivileged `north` user; the units ship basic hardening.
- The template unit narrows each instance's writes to its own tenant directory,
  but all instances share the `north` Unix user. Treat it as a same-trust-host
  convenience, not hostile-tenant filesystem isolation. For mutually untrusted
  tenants, use the compose topology: each coordinator mounts only its own log
  directory and the gateway mounts only the registry directory.
