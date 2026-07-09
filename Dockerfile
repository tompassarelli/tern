# North runtime image — the Fram engine + the North life domain.
# One image, two roles (choose at run time):
#   • coordinator (default CMD): a single tenant's sole-writer daemon (runs on the JVM)
#   • gateway:                   the authenticated multi-tenant edge (runs on babashka)
#
# Coordinators default to loopback; FRAM_BIND=0.0.0.0 + engine mTLS (FRAM_TLS_*) are
# shipped, so cross-host/bridge-network deployment is supported (the gateway can front
# coordinators on other hosts). See docs/hosting.md and fram/docs/coordinator-bind-and-wire.md.
#
#   docker build -t north:latest .
#   docker run --rm --network host -v /srv/north:/data north:latest          # coordinator
#   docker run --rm --network host -v /srv/north:/srv/north \
#     -e GATEWAY_TENANTS=/srv/north/tenants.edn north:latest \
#     bash -lc 'exec bb /opt/north/deploy/gateway/gateway.clj'                   # gateway
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git curl ca-certificates iproute2 default-jre-headless rlwrap \
 && rm -rf /var/lib/apt/lists/*

# Two runtimes by design: babashka for the CLI + MCP (fast per-command startup);
# clojure/JVM for the long-lived coordinator daemon (JIT throughput, real threads,
# SSLServerSocket for engine-terminated mTLS — bb's native image lacks server TLS).
RUN curl -sL https://raw.githubusercontent.com/babashka/babashka/master/install | bash
RUN curl -sL https://github.com/clojure/brew-install/releases/latest/download/linux-install.sh -o /tmp/clj.sh \
 && bash /tmp/clj.sh && rm /tmp/clj.sh

# Pinned to the Fram commit North is built against — keep in sync with
# FRAM_VERSION (override at build with --build-arg FRAM_REF=<sha>).
ARG FRAM_REF=e78badabb43aa8ce1f507b8a8d74b86737cd34de
WORKDIR /opt
RUN git clone https://github.com/Autonymy/fram \
 && git -C fram checkout --quiet "${FRAM_REF}" \
 && (cd fram && clojure -P)   # prefetch the coordinator daemon's JVM deps (clojure + cheshire)
COPY . /opt/north

ENV FRAM_HOME=/opt/fram \
    PATH="/opt/north/bin:/opt/fram/bin:${PATH}" \
    FRAM_PORT=7977 \
    FRAM_LOG=/data/facts.log \
    FRAM_THREADS=/data/threads \
    FRAM_TIME_DIR=/data/time

RUN mkdir -p /data
VOLUME ["/data"]

# Default role: this tenant's coordinator (JVM daemon, loopback sole writer).
CMD ["bash","-lc","exec fram-daemon \"$FRAM_PORT\" \"$FRAM_LOG\""]
