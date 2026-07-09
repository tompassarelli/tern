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
does this on a bridge network). Only the gateway is ever publicly exposed.

## Fastest real deployment (systemd, one host)

```sh
# 0. prerequisites on the box: babashka, plus Fram + North at /opt
sudo install -d /opt /var/lib/north /etc/north -o north -g north
sudo git clone https://github.com/tompassarelli/fram     /opt/fram
sudo git clone https://github.com/tompassarelli/north /opt/north

# 1. provision a tenant (mints a token, starts its coordinator, registers it)
sudo -u north env GATEWAY_TENANTS=/var/lib/north/tenants.edn \
  NORTH_TENANT_ROOT=/var/lib/north/tenants \
  /opt/north/deploy/gateway/provision.sh acme 7801

# 2. install the units
sudo cp /opt/north/deploy/north-coordinator@.service /etc/systemd/system/
sudo cp /opt/north/deploy/north-gateway.service       /etc/systemd/system/
printf 'FRAM_PORT=7801\nFRAM_LOG=/var/lib/north/tenants/acme/facts.log\n' \
  | sudo tee /etc/north/acme.env
printf 'GATEWAY_PORT=8088\nGATEWAY_TENANTS=/var/lib/north/tenants.edn\n' \
  | sudo tee /etc/north/gateway.env
sudo systemctl daemon-reload
sudo systemctl enable --now north-coordinator@acme north-gateway

# 3. put TLS in front of :8088 (Caddy one-liner): reverse_proxy 127.0.0.1:8088
```

## Security

- The raw coordinator port is **unauthenticated** — never expose it; only the
  gateway is reachable, and only through TLS.
- Tenant bearer tokens are stored **hashed** (sha-256). `provision.sh` prints the
  plaintext once.
- Run as a dedicated unprivileged `north` user; the units ship basic hardening.
