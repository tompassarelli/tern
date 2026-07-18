# North service image — the pinned Fram coordinator + North gateway.
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
#
# A zero-runtime audit target makes the effective .dockerignore context
# inspectable without downloading or building the service image:
#   docker build --target context-audit -t north-context-audit .
FROM scratch AS context-audit
COPY . /context

FROM docker.io/library/debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git curl ca-certificates coreutils gzip iproute2 jq \
      default-jre-headless rlwrap tar \
 && rm -rf /var/lib/apt/lists/*

# Two runtimes by design: babashka for the gateway/provisioner (fast startup);
# clojure/JVM for the long-lived coordinator daemon (JIT throughput, real
# threads, SSLServerSocket for engine-terminated mTLS).
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) bb_arch=amd64; bb_sha=7bd028cc794732ffde3da31ce4379840893c8e54f1046f92a8dfc4f4b3cddaf8 ;; \
      arm64) bb_arch=aarch64; bb_sha=e9e9190afb0dd33abbcd3aa6c1382184a88a5498800324719be3be6e1aa68302 ;; \
      *) echo "unsupported Docker architecture: $arch" >&2; exit 1 ;; \
    esac; \
    bb_asset="babashka-1.12.218-linux-$bb_arch-static.tar.gz"; \
    curl -fL --retry 5 -o "/tmp/$bb_asset" \
      "https://github.com/babashka/babashka/releases/download/v1.12.218/$bb_asset"; \
    echo "$bb_sha  /tmp/$bb_asset" | sha256sum -c -; \
    tar -xzf "/tmp/$bb_asset" -C /usr/local/bin bb; \
    rm -f "/tmp/$bb_asset"; \
    test "$(bb --version)" = "babashka v1.12.218"; \
    curl -fL --retry 5 -o /tmp/clojure-install.sh \
      https://github.com/clojure/brew-install/releases/download/1.12.5.1654/linux-install.sh; \
    echo "28f81b0833c0a072f4370ae0eb1e4c5a4f9f4a34035cd7607ea9f253a8b06da1  /tmp/clojure-install.sh" \
      | sha256sum -c -; \
    bash /tmp/clojure-install.sh; \
    rm -f /tmp/clojure-install.sh; \
    clojure -Sdescribe | grep -F '"1.12.5.1654"'; \
    mkdir -p /usr/share/licenses/babashka /usr/share/licenses/clojure-tools; \
    curl -fL --retry 5 -o /usr/share/licenses/babashka/LICENSE \
      https://raw.githubusercontent.com/babashka/babashka/v1.12.218/LICENSE; \
    curl -fL --retry 5 -o /usr/share/licenses/clojure-tools/LICENSE \
      https://raw.githubusercontent.com/clojure/brew-install/1.12.5.1654/LICENSE; \
    echo "cc07bd2bd6ba843a9a2865ed891d5a3b5835a64bab6fa90945403ee53965d46f  /usr/share/licenses/babashka/LICENSE" \
      | sha256sum -c -; \
    echo "2890ecd78ff9ee48e754e43db3d82d6ac8745170960580e7e6d458dc0d85ea66  /usr/share/licenses/clojure-tools/LICENSE" \
      | sha256sum -c -

# One Fram pointer: the exact GitHub source identity in North's flake.lock.
# The parser rejects path inputs, abbreviated revisions, and unsafe URL parts.
COPY flake.lock bin/github-flake-input-pin /tmp/north-pin/
WORKDIR /opt
RUN set -eux; \
    repository="$(/tmp/north-pin/github-flake-input-pin /tmp/north-pin/flake.lock fram repository)"; \
    revision="$(/tmp/north-pin/github-flake-input-pin /tmp/north-pin/flake.lock fram revision)"; \
    mkdir fram; \
    git -C fram init -q; \
    git -C fram remote add origin "https://github.com/$repository.git"; \
    git -C fram fetch -q --depth 1 origin "$revision"; \
    git -C fram checkout -q --detach FETCH_HEAD; \
    test "$(git -C fram rev-parse HEAD)" = "$revision"; \
    printf '%s\n' "$repository@$revision" > fram/.north-pinned-source; \
    (cd fram && clojure -P); \
    rm -rf fram/.git; \
    test ! -e fram/.git; \
    test "$(cat fram/.north-pinned-source)" = "$repository@$revision"; \
    rm -rf /tmp/north-pin
# The service image is intentionally not a copy of the development checkout.
# Keep this list identical to the deny-by-default .dockerignore: gateway policy,
# its entrypoint, and the project license are the complete North-side runtime
# closure for the two documented image roles. `provision.sh` is intentionally
# host-only: it owns host coordinator PIDs and calls North's full launcher, while
# containers consume an already-provisioned data volume/registry.
RUN mkdir -p /opt/north/out/north /opt/north/deploy/gateway
COPY out/north/gatepolicy.clj /opt/north/out/north/gatepolicy.clj
COPY deploy/gateway/gateway.clj /opt/north/deploy/gateway/gateway.clj
COPY LICENSE /opt/north/LICENSE

ENV FRAM_HOME=/opt/fram \
    PATH="/opt/fram/bin:${PATH}" \
    BABASHKA_CLASSPATH=/opt/north/out \
    FRAM_PORT=7977 \
    FRAM_LOG=/data/facts.log \
    FRAM_REQUIRE_LOG_FENCE=1 \
    FRAM_THREADS=/data/threads \
    FRAM_TIME_DIR=/data/time

RUN mkdir -p /data
VOLUME ["/data"]

# Default role: this tenant's coordinator (JVM daemon, loopback sole writer).
# Do not use a login shell here: Debian's /etc/profile replaces the image PATH
# and would hide /opt/fram/bin.
CMD ["bash","-c","exec /opt/fram/bin/fram-daemon \"$FRAM_PORT\" \"$FRAM_LOG\""]
