# Lodestar runtime image — babashka + the Fram engine + the Lodestar life domain.
# One image, two roles (choose at run time):
#   • coordinator (default CMD): a single tenant's sole-writer daemon
#   • gateway:                   the authenticated multi-tenant edge
#
# Coordinators bind loopback, so the gateway and the coordinators it fronts must
# share a network namespace (run with `--network host`, or the compose example).
# Multi-host / bridge-network deployment needs a configurable coordinator bind —
# see the roadmap in docs/hosting.md.
#
#   docker build -t lodestar:latest .
#   docker run --rm --network host -v /srv/lodestar:/data lodestar:latest          # coordinator
#   docker run --rm --network host -v /srv/lodestar:/srv/lodestar \
#     -e GATEWAY_TENANTS=/srv/lodestar/tenants.edn lodestar:latest \
#     bash -lc 'exec bb /opt/lodestar/deploy/gateway/gateway.clj'                   # gateway
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git curl ca-certificates iproute2 \
 && rm -rf /var/lib/apt/lists/*

# babashka is the only runtime dependency — the compiled Clojure is committed.
RUN curl -sL https://raw.githubusercontent.com/babashka/babashka/master/install | bash

# Pinned to the Fram commit Lodestar is built against — keep in sync with
# FRAM_VERSION (override at build with --build-arg FRAM_REF=<sha>).
ARG FRAM_REF=e6978b5b2959e4cd3ad9d209d94400e3e5e0d153
WORKDIR /opt
RUN git clone https://github.com/tompassarelli/fram \
 && git -C fram checkout --quiet "${FRAM_REF}"
COPY . /opt/lodestar

ENV FRAM_HOME=/opt/fram \
    PATH="/opt/lodestar/bin:/opt/fram/bin:${PATH}" \
    FRAM_PORT=7977 \
    FRAM_LOG=/data/claims.log \
    FRAM_THREADS=/data/threads \
    FRAM_TIME_DIR=/data/time

RUN mkdir -p /data
VOLUME ["/data"]

# Default role: this tenant's coordinator (loopback, sole writer).
CMD ["bash","-lc","exec fram-daemon \"$FRAM_PORT\" \"$FRAM_LOG\""]
