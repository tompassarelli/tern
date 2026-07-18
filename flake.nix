{
  description = "north — fact-native work coordination (CLI + MCP, on babashka)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Fram owns and verifies its complete runtime closure. North consumes that
    # package directly and uses its published runtime/classpath contract; it
    # must not maintain a second partial Fram packager.
    fram = {
      url = "github:tompassarelli/fram";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    beagle = {
      url = "github:tompassarelli/beagle";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    gaffer = {
      url = "github:tompassarelli/gaffer";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, fram, beagle, gaffer }:
    # nixpkgs' current Babashka no longer supports x86_64-darwin. Publish only
    # the three systems whose complete North runtime closure is evaluable.
    flake-utils.lib.eachSystem [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;
        sdkVersion =
          let
            declared = (builtins.fromJSON (builtins.readFile ./sdk/package.json))
              .dependencies."@anthropic-ai/claude-agent-sdk";
            exact = lib.removePrefix "^" declared;
          in
            if builtins.match "[0-9]+\\.[0-9]+\\.[0-9]+" exact != null then
              exact
            else
              throw "North requires an exact or caret-prefixed Claude SDK version, got ${declared}";

        # Runtime PATH for the bb-backed CLIs. util-linux supplies `setsid` for
        # managed lanes on every supported host. iproute2 supplies Linux's `ss`
        # for daemon-health probes, but has no Darwin package; keep that helper
        # out of Darwin's derivation instead of admitting an unsupported closure.
        runtimePackages = [
          pkgs.babashka
          pkgs.coreutils
          pkgs.bash
          pkgs.bun
          pkgs.findutils
          pkgs.gawk
          pkgs.git
          pkgs.gnugrep
          pkgs.gnused
          pkgs.util-linux
        ] ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [
          pkgs.iproute2
        ] ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
          pkgs.lsof
        ];
        runtimePath = lib.makeBinPath runtimePackages;
        framPkg = fram.packages.${system}.default;
        framRuntimeRoot =
          framPkg.runtimeRoot or
            (throw "Fram package must publish passthru.runtimeRoot");
        framBabashkaClasspath =
          framPkg.babashkaClasspath or
            (throw "Fram package must publish passthru.babashkaClasspath");
        beaglePkg = beagle.packages.${system}.default;
        beagleSource = beagle.outPath;
        sdkPlatform =
          if pkgs.stdenv.hostPlatform.isLinux then
            if pkgs.stdenv.hostPlatform.isx86_64 then
              {
                packageName = "@anthropic-ai/claude-agent-sdk-linux-x64";
                url = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-${sdkVersion}.tgz";
                hash = "sha512-s1lNi1cL93luoqsItH+fNO4KpIhdkvnVhWGGQUQ/8ftwa2gfmcIQnOg1hG8Ks+KzeD3UUQ8L9YEVHVADnFI/9A==";
              }
            else if pkgs.stdenv.hostPlatform.isAarch64 then
              {
                packageName = "@anthropic-ai/claude-agent-sdk-linux-arm64";
                url = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-${sdkVersion}.tgz";
                hash = "sha512-JuIq5Fnz/F1snl0aqi1gcuRZqPWoPNrL9dJ0DuievCxKkO8hnEz/Mmn5Zos7x1X8HE//ZnEvmQXoEQEZXonJew==";
              }
            else throw "North's Claude SDK package does not support ${system}"
          else if pkgs.stdenv.hostPlatform.isDarwin then
            if pkgs.stdenv.hostPlatform.isAarch64 then
              {
                packageName = "@anthropic-ai/claude-agent-sdk-darwin-arm64";
                url = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-${sdkVersion}.tgz";
                hash = "sha512-WIMM/8HRCLsTDHFTIwQvvE8WCA/oaMJtdQxsP7iNyfzIGwXbuOyU95V8vYIhZfaO2yaSpbBRncunq4CtR5H4ng==";
              }
            else throw "North's Claude SDK package does not support ${system}"
          else throw "North's Claude SDK package does not support ${system}";
        sdkSource = pkgs.fetchurl {
          url = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-${sdkVersion}.tgz";
          hash = "sha512-FVmXu9pvOMbuBKWrF8YsYQdQ/upOpv5rS8lFAnFO5jbyXT/2hN7kEPd2vd2GJpaMvNcO/KptyQUK5AxjjTz3+w==";
        };
        sdkPlatformSource = pkgs.fetchurl {
          inherit (sdkPlatform) url hash;
        };
        runtimeSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./out
            (lib.fileset.difference ./cli ./cli/tests)
            ./sdk/src
            ./bin/north
            ./bin/north-mcp
            ./bin/north-clock-audit
            ./bin/north-coord-up
            ./bin/north-stream-sync
            ./bin/concern
            ./bin/ensure-private-docs
          ];
        };
        webRuntimeSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./web-bjs/src
            ./web/priv/static/assets/css/app.css
            ./web/priv/static/favicon.ico
            ./web/priv/static/js/board-write.js
            ./web/priv/static/js/cytoscape.min.js
            ./web/priv/static/js/north-agents.js
            ./web/priv/static/js/north-app.js
            ./web/priv/static/js/north-arena.js
            ./web/priv/static/js/north-board.js
            ./web/priv/static/js/north-list.js
            ./web/priv/static/js/north-ui.js
            ./web/priv/static/js/wake-mounts.js
            ./web/priv/static/robots.txt
            ./LICENSE
          ];
        };

        # Runtime-only Gaffer contract. Generated adapters, authoring scripts,
        # skills, and private docs stay out of North's closure.
        gafferContract = pkgs.stdenvNoCC.mkDerivation {
          pname = "gaffer-runtime-contract";
          version = builtins.substring 0 12 (gaffer.rev or "local");
          src = gaffer;
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/staffing $out/providers $out/docs/deltas
            cp staffing/catalog.json $out/staffing/
            cp providers/anthropic.json providers/openai.json $out/providers/
            cp docs/roles.md docs/task-grades.md docs/topologies.md docs/postures.md docs/comms.md $out/docs/
            cp docs/deltas/opus.md docs/deltas/sonnet.md $out/docs/deltas/
            runHook postInstall
          '';
        };

        # sdk.mjs is self-contained; at runtime it needs only the public package
        # plus the exact native Claude binary for this host. Fetching those two
        # tarballs directly keeps each system's closure bounded instead of
        # prefetching every 200+ MB optional OS/architecture package in npm's
        # universal lockfile.
        sdkRuntimeDependencies = pkgs.stdenvNoCC.mkDerivation {
          pname = "north-sdk-runtime-dependencies";
          version = sdkVersion;
          dontUnpack = true;
          nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ];
          installPhase = ''
            runHook preInstall
            mkdir -p \
              $out/node_modules/@anthropic-ai/claude-agent-sdk \
              $out/node_modules/${sdkPlatform.packageName}
            tar -xzf ${sdkSource} --strip-components=1 \
              -C $out/node_modules/@anthropic-ai/claude-agent-sdk
            tar -xzf ${sdkPlatformSource} --strip-components=1 \
              -C $out/node_modules/${sdkPlatform.packageName}
            chmod +x $out/node_modules/${sdkPlatform.packageName}/claude
            runHook postInstall
          '';
        };

        # The web cockpit is compiled from Beagle/JS by the exact locked
        # compiler, but its runtime closure contains only emitted JavaScript,
        # static assets, Beagle's two small JS runtime files, and Bun.
        northWebPkg = pkgs.stdenvNoCC.mkDerivation {
          pname = "north-web";
          version = "0.1.0";
          src = webRuntimeSource;
          nativeBuildInputs = [
            beaglePkg
            pkgs.babashka
            pkgs.makeWrapper
            pkgs.nodejs
            pkgs.ripgrep
          ];
          disallowedReferences = [
            beaglePkg
            beagleSource
            pkgs.babashka
            pkgs.nodejs
          ];
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME" build
            BEAGLE_EMIT_SRCLOC=0 \
              ${beaglePkg}/bin/beagle build web-bjs/src --out build/out
            # smoke.bjs is a developer probe, not part of the boot import
            # graph. Keep the source tool while making the production graph
            # exact and reviewable.
            rm build/out/smoke.js
            actual_modules="$(${pkgs.findutils}/bin/find \
              build/out -type f -name "*.js" -printf "%P\n" \
              | LC_ALL=C ${pkgs.coreutils}/bin/sort)"
            expected_modules="$(cat <<'EOF'
north/arena.js
north/boot.js
north/dict.js
north/fram.js
north/id.js
north/presence.js
north/server.js
north/stream.js
north/threads.js
EOF
)"
            if [ "$actual_modules" != "$expected_modules" ]; then
              echo "north-web emitted module manifest drifted" >&2
              ${pkgs.diffutils}/bin/diff -u \
                <(printf "%s\n" "$expected_modules") \
                <(printf "%s\n" "$actual_modules") >&2 || true
              exit 1
            fi
            while IFS= read -r -d "" js; do
              ${pkgs.nodejs}/bin/node --check "$js"
            done < <(${pkgs.findutils}/bin/find build/out -type f -name "*.js" -print0)
            if ${pkgs.ripgrep}/bin/rg -n \
              '\bor\(|\b(?:await|if|new)[$]|delete[$]' build/out; then
              echo "north-web compiler emitted an unresolved helper" >&2
              exit 1
            fi
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p \
              "$out/bin" \
              "$out/libexec/north-web/node_modules/beagle" \
              "$out/share/licenses/north-web" \
              "$out/share/north-web/static/assets/css" \
              "$out/share/north-web/static/js"
            cp -r build/out/. "$out/libexec/north-web/"
            cp \
              ${beaglePkg}/beagle-lib/lib/beagle/core.js \
              ${beaglePkg}/beagle-lib/lib/beagle/hamt.js \
              "$out/libexec/north-web/node_modules/beagle/"
            cp web/priv/static/assets/css/app.css \
              "$out/share/north-web/static/assets/css/"
            cp \
              web/priv/static/js/board-write.js \
              web/priv/static/js/cytoscape.min.js \
              web/priv/static/js/north-agents.js \
              web/priv/static/js/north-app.js \
              web/priv/static/js/north-arena.js \
              web/priv/static/js/north-board.js \
              web/priv/static/js/north-list.js \
              web/priv/static/js/north-ui.js \
              web/priv/static/js/wake-mounts.js \
              "$out/share/north-web/static/js/"
            cp \
              web/priv/static/favicon.ico \
              web/priv/static/robots.txt \
              "$out/share/north-web/static/"
            cp LICENSE "$out/share/licenses/north-web/NORTH-LICENSE"
            cp ${beagleSource}/LICENSE \
              "$out/share/licenses/north-web/BEAGLE-LICENSE"
            # Cytoscape's vendored bundle begins with its complete MIT notice.
            # Publish that header separately while retaining it in the asset.
            ${pkgs.gnused}/bin/sed -n '1,21p' \
              web/priv/static/js/cytoscape.min.js \
              > "$out/share/licenses/north-web/CYTOSCAPE-MIT-LICENSE"
            ${pkgs.gnugrep}/bin/grep -q \
              'Copyright (c) 2016-2024, The Cytoscape Consortium' \
              "$out/share/licenses/north-web/CYTOSCAPE-MIT-LICENSE"
            test "$(${pkgs.findutils}/bin/find \
              "$out/share/north-web/static" -type f | wc -l)" -eq 12
            makeWrapper ${pkgs.bun}/bin/bun "$out/bin/north-web" \
              --add-flags "$out/libexec/north-web/north/boot.js" \
              --set-default NORTH_WEB_BIND 127.0.0.1 \
              --set-default STATIC_DIR "$out/share/north-web/static"

            impurity_pattern='/(home|Users)/|/run/current-system/sw|/code/north(?:/|\b)|~/code/north|[$]HOME/code/north|[.]m2|[.]cpcache|[.]cache/babashka'
            if LC_ALL=C ${pkgs.ripgrep}/bin/rg --hidden --no-ignore -l \
              "$impurity_pattern" "$out"; then
              echo "north-web package contains a checkout/home/cache path" >&2
              exit 1
            fi
            if LC_ALL=C ${pkgs.ripgrep}/bin/rg --hidden --no-ignore -l -F \
              '${beaglePkg}' "$out"; then
              echo "north-web package retains the Beagle compiler" >&2
              exit 1
            fi
            runHook postInstall
          '';
          doInstallCheck = true;
          installCheckPhase = ''
            runHook preInstallCheck

            # The runtime module graph must import with no HOME, PATH, checkout,
            # compiler, or ambient node_modules.
            ${pkgs.coreutils}/bin/env -i \
              PATH= NORTH_WEB_NO_AUTOSTART=1 \
              ${pkgs.bun}/bin/bun -e \
                'await import(process.argv[1])' \
                "$out/libexec/north-web/north/boot.js"

            if ${pkgs.coreutils}/bin/env -i PATH= \
              "$out/bin/north-web" \
              > "$TMPDIR/missing-corpus.out" \
              2> "$TMPDIR/missing-corpus.err"; then
              echo "north-web started without FRAM_LOG" >&2
              exit 1
            fi
            ${pkgs.gnugrep}/bin/grep -Fq \
              'FRAM_LOG must name an existing corpus before north-web can start' \
              "$TMPDIR/missing-corpus.err"

            if ${pkgs.coreutils}/bin/env -i \
              PATH= FRAM_LOG="$TMPDIR/nonexistent/facts.log" \
              "$out/bin/north-web" \
              > "$TMPDIR/nonexistent-corpus.out" \
              2> "$TMPDIR/nonexistent-corpus.err"; then
              echo "north-web started with a nonexistent FRAM_LOG" >&2
              exit 1
            fi
            ${pkgs.gnugrep}/bin/grep -Fq \
              'FRAM_LOG must name an existing corpus before north-web can start' \
              "$TMPDIR/nonexistent-corpus.err"

            smoke="$TMPDIR/north-web-smoke"
            mkdir -p "$smoke"
            : > "$smoke/facts.log"
            web_port="$(${pkgs.babashka}/bin/bb -e \
              '(with-open [s (java.net.ServerSocket. 0)]
                 (println (.getLocalPort s)))')"
            coord_port="$(${pkgs.babashka}/bin/bb -e \
              '(with-open [s (java.net.ServerSocket. 0)]
                 (println (.getLocalPort s)))')"
            web_pid=
            cleanup_web_smoke() {
              if [ -n "$web_pid" ]; then
                kill "$web_pid" 2>/dev/null || true
                wait "$web_pid" 2>/dev/null || true
              fi
            }
            trap cleanup_web_smoke EXIT
            ${pkgs.coreutils}/bin/env -i \
              PATH= \
              FRAM_LOG="$smoke/facts.log" \
              NORTH_PORT="$coord_port" \
              PORT="$web_port" \
              "$out/bin/north-web" \
              > "$smoke/server.out" 2> "$smoke/server.err" &
            web_pid=$!

            ready=0
            for _ in $(seq 1 100); do
              if ${pkgs.bun}/bin/bun -e \
                'try {
                   const response = await fetch(process.argv[1]);
                   process.exit(response.status === 200 ? 0 : 1);
                 } catch {
                   process.exit(1);
                 }' \
                "http://127.0.0.1:$web_port/"; then
                ready=1
                break
              fi
              sleep 0.05
            done
            if [ "$ready" -ne 1 ]; then
              cat "$smoke/server.err" >&2
              echo "north-web package smoke: server did not become ready" >&2
              exit 1
            fi

            ${pkgs.bun}/bin/bun -e \
              'const base = process.argv[1];
               const html = await fetch(base + "/");
               if (html.status !== 200
                   || !(await html.text()).includes("<!doctype html>")) {
                 process.exit(1);
               }
               const assets = [
                 "/assets/css/app.css",
                 "/favicon.ico",
                 "/js/board-write.js",
                 "/js/cytoscape.min.js",
                 "/js/north-agents.js",
                 "/js/north-app.js",
                 "/js/north-arena.js",
                 "/js/north-board.js",
                 "/js/north-list.js",
                 "/js/north-ui.js",
                 "/js/wake-mounts.js",
                 "/robots.txt",
               ];
               for (const path of assets) {
                 const response = await fetch(base + path);
                 if (response.status !== 200
                     || (await response.arrayBuffer()).byteLength === 0) {
                   process.exit(1);
                 }
               }
               for (const retired of [
                 "/assets/js/app.js",
                 "/hologram/runtime.js",
                 "/images/logo.svg",
                 "/js/dag.js",
               ]) {
                 if ((await fetch(base + retired)).status !== 404) {
                   process.exit(1);
                 }
               }' \
              "http://127.0.0.1:$web_port"
            kill "$web_pid"
            wait "$web_pid" 2>/dev/null || true
            web_pid=
            runHook postInstallCheck
          '';

          meta = with lib; {
            description = "North local web cockpit";
            license = [ licenses.asl20 licenses.mit ];
            mainProgram = "north-web";
            platforms = [
              "x86_64-linux"
              "aarch64-linux"
              "aarch64-darwin"
            ];
          };
        };

        # north CLI + MCP. Same relocatable layout. FRAM_HOME is baked to the
        # packaged engine so the CLI is self-contained; an explicit env override
        # still wins (the script reads ${FRAM_HOME:-...}). NORTH_BIN points the
        # MCP server at the wrapped CLI in this same out.
        northPkg = pkgs.stdenvNoCC.mkDerivation {
          pname = "north";
          version = "0.1.0";
          # Keep the package derivation tied only to files copied into the
          # runtime. Archived web sources, tests, and docs cannot invalidate or
          # leak into the closure.
          src = runtimeSource;
          # Babashka must be present while patchShebangs runs. Otherwise the
          # copied `#!/usr/bin/env bb` survives into `.north-mcp-wrapped`, where
          # the Nix build sandbox has no `/usr/bin/env` to execute.
          nativeBuildInputs = [ pkgs.makeWrapper pkgs.babashka pkgs.ripgrep ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/bin $out/out $out/sdk
            cp -r out/. $out/out/
            # bb-verb CLIs (agents/watch/trace/health/dials/dashboard/config/...)
            # route through $root/cli — without this every non-engine verb dies
            # on the packaged binary with "File does not exist: .../cli/*.clj".
            cp -r cli $out/cli
            test ! -e "$out/cli/tests"
            # Package the complete TypeScript runtime tree. Hand-maintained
            # transitive import lists inevitably rot as provider adapters grow.
            cp -r sdk/src $out/sdk/src
            ln -s ${sdkRuntimeDependencies}/node_modules $out/sdk/node_modules
            cp bin/north bin/north-mcp bin/north-clock-audit \
              bin/north-coord-up bin/north-stream-sync bin/concern \
              bin/ensure-private-docs $out/bin/
            patchShebangs $out/bin

            # The Linear route is spread across these load-bearing runtime
            # modules. Catch untracked/omitted flake sources before producing a
            # package whose `north linear` verb points at a missing entrypoint.
            for f in cli.ts north-state.ts app-server-broker.ts \
              reserve-link.clj find-bootstrap-links.clj; do
              test -f "$out/sdk/src/integrations/linear/$f"
            done

            wrapProgram $out/bin/north \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framRuntimeRoot} \
              --set-default FRAM_BIN ${framPkg}/bin \
              --set-default FRAM_OUT ${framBabashkaClasspath} \
              --set-default GAFFER_HOME ${gafferContract} \
              --set-default NORTH_HOME $out \
              --set-default NORTH_BIN $out/bin/north \
              --set-default NORTH_BB ${pkgs.babashka}/bin/bb \
              --set-default NORTH_BUN ${pkgs.bun}/bin/bun \
              --set-default NORTH_PEER_BB ${pkgs.babashka}/bin/bb \
              --set-default NORTH_MCP_BB ${pkgs.babashka}/bin/bb \
              --set-default NORTH_MCP_BUN ${pkgs.bun}/bin/bun \
              --set-default NORTH_PACKAGE_MODE nix-store \
              --set-default NORTH_PACKAGE_REV ${builtins.substring 0 12 (self.rev or self.dirtyRev or "dirty")} \
              --set-default FRAM_PACKAGE_REV ${builtins.substring 0 12 (fram.rev or fram.dirtyRev or "local")}

            wrapProgram $out/bin/north-mcp \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framRuntimeRoot} \
              --set-default FRAM_BIN ${framPkg}/bin \
              --set-default FRAM_OUT ${framBabashkaClasspath} \
              --set-default GAFFER_HOME ${gafferContract} \
              --set-default NORTH_HOME $out \
              --set-default NORTH_BIN $out/bin/north \
              --set-default NORTH_BB ${pkgs.babashka}/bin/bb \
              --set-default NORTH_BUN ${pkgs.bun}/bin/bun \
              --set-default NORTH_PEER_BB ${pkgs.babashka}/bin/bb \
              --set-default NORTH_MCP_BB ${pkgs.babashka}/bin/bb \
              --set-default NORTH_MCP_BUN ${pkgs.bun}/bin/bun

            wrapProgram $out/bin/north-clock-audit \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framRuntimeRoot} \
              --set-default FRAM_OUT ${framBabashkaClasspath} \
              --set-default NORTH_HOME $out \
              --set-default NORTH_BB ${pkgs.babashka}/bin/bb

            wrapProgram $out/bin/north-stream-sync \
              --prefix PATH : ${runtimePath} \
              --set-default NORTH_PACKAGE_MODE nix-store

            wrapProgram $out/bin/north-coord-up \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framRuntimeRoot} \
              --set-default FRAM_BIN ${framPkg}/bin \
              --set-default NORTH_HOME $out

            wrapProgram $out/bin/concern \
              --prefix PATH : ${runtimePath} \
              --set-default NORTH_HOME $out \
              --set-default NORTH_BB ${pkgs.babashka}/bin/bb

            wrapProgram $out/bin/ensure-private-docs \
              --prefix PATH : ${runtimePath} \
              --set-default NORTH_HOME $out

            impurity_pattern='/(home|Users)/|/run/current-system/sw|/code/north(?:/|\b)|~/code/north|[$]HOME/code/north|[.]m2|[.]cpcache|[.]cache/babashka'
            if LC_ALL=C rg --hidden -n "$impurity_pattern" "$out"; then
              echo "north package contains a checkout/home/cache path" >&2
              exit 1
            fi

            # Exercise every packaged TypeScript CLI entrypoint with hermetic
            # subscription/auth fixtures. These probes never make a model turn.
            smoke=$(mktemp -d)
            coord_pid=
            cleanup_smoke() {
              if [ -n "$coord_pid" ]; then
                kill "$coord_pid" 2>/dev/null || true
                for _ in $(seq 1 40); do
                  kill -0 "$coord_pid" 2>/dev/null || break
                  sleep 0.1
                done
              fi
              rm -rf "$smoke"
            }
            trap cleanup_smoke EXIT
            mkdir -p "$smoke/bin" "$smoke/home"
            cat > "$smoke/bin/claude" <<'EOF'
#!${pkgs.bash}/bin/bash
if [ "$1" = "--version" ]; then echo 'claude smoke'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi
exit 2
EOF
            cat > "$smoke/bin/codex" <<'EOF'
#!${pkgs.bash}/bin/bash
if [ "$1" = "--version" ]; then echo 'codex smoke'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
exit 2
EOF
            chmod +x "$smoke/bin/claude" "$smoke/bin/codex"
            mkdir -p "$smoke/home/.local/state/north/threads"
            : > "$smoke/home/.local/state/north/facts.log"
            client_repo="$smoke/home/code/client/smoke/widget"
            mkdir -p "$client_repo"
            ${pkgs.git}/bin/git -C "$client_repo" init -q
            printf 'package clock audit\n' > "$client_repo/probe.txt"
            ${pkgs.git}/bin/git -C "$client_repo" add probe.txt
            ${pkgs.git}/bin/git -C "$client_repo" \
              -c user.name='North Package Smoke' \
              -c user.email='north-package-smoke@example.invalid' \
              commit -qm 'exercise packaged clock audit'
            # Every public executable must work with no ambient PATH or checkout.
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= \
              $out/bin/north help > "$smoke/help.out"
            grep -q 'north — your one card' "$smoke/help.out"
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= NORTH_DASHBOARD_LIB=1 \
              $out/bin/north dashboard
            if ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= \
              $out/bin/concern > "$smoke/concern-usage.out" 2>&1; then
              echo "north package smoke: bare concern unexpectedly succeeded" >&2
              exit 1
            fi
            grep -q 'usage: concern-cli.clj' "$smoke/concern-usage.out"
            if ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= \
              $out/bin/north-coord-up --invalid \
              > "$smoke/north-coord-up-usage.out" 2>&1; then
              echo "north package smoke: invalid north-coord-up unexpectedly succeeded" >&2
              exit 1
            fi
            grep -q 'usage: north up' "$smoke/north-coord-up-usage.out"
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= \
              $out/bin/ensure-private-docs "$client_repo"
            if ! grep -qxF 'docs/private/' "$client_repo/.gitignore"; then
              echo "north package smoke: ensure-private-docs did not install its exact ignore rule" >&2
              sed -n '1,120p' "$client_repo/.gitignore" >&2
              exit 1
            fi
            # Empty PATH proves the packaged wrapper supplies bb + git itself.
            if ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= \
              $out/bin/north clock audit > "$smoke/clock-audit.out"; then
              echo "north package smoke: uncovered commit unexpectedly passed clock audit" >&2
              exit 1
            fi
            if ! grep -q '1 uncovered' "$smoke/clock-audit.out"; then
              echo "north package smoke: clock audit did not report the uncovered commit" >&2
              sed -n '1,160p' "$smoke/clock-audit.out" >&2
              exit 1
            fi

            stream_src="$smoke/source with spaces/project"
            mkdir -p "$stream_src" "$smoke/xdg"
            printf '{"type":"package-stream-probe"}\n' \
              > "$stream_src/12345678-1234-1234-1234-123456789abc.jsonl"
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" XDG_STATE_HOME="$smoke/xdg" PATH= \
              $out/bin/north stream-sync --days 30 --min-bytes 1 \
                --src-dir "$smoke/source with spaces"
            stream_raw="$smoke/xdg/north/streams/raw"
            stream_dest="$(${pkgs.findutils}/bin/find "$stream_raw" -maxdepth 1 \
              -type f -name '*.jsonl' -print -quit)"
            test -n "$stream_dest"
            ${pkgs.diffutils}/bin/cmp \
              "$stream_src/12345678-1234-1234-1234-123456789abc.jsonl" \
              "$stream_dest"
            cursor_hash="$(${pkgs.coreutils}/bin/sha256sum "$stream_raw/.cursors")"
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" XDG_STATE_HOME="$smoke/xdg" PATH= \
              $out/bin/north stream-sync --days 30 --min-bytes 1 \
                --src-dir "$smoke/source with spaces"
            test "$cursor_hash" = \
              "$(${pkgs.coreutils}/bin/sha256sum "$stream_raw/.cursors")"
            ${pkgs.diffutils}/bin/cmp \
              "$stream_src/12345678-1234-1234-1234-123456789abc.jsonl" \
              "$stream_dest"
            test ! -e "$out/streams/raw"
            # Load North's compiled namespace graph against Fram's published bb
            # classpath. This is the seam the old partial packager left untested.
            HOME="$smoke/home" FRAM_PORT=39123 \
              $out/bin/north validate > "$smoke/validate.out"
            grep -q 'no violations' "$smoke/validate.out"
            # Exercise the composed lifecycle seam, not merely namespace
            # loading: North's public revive command must start Fram's packaged
            # daemon through its public wrapper and verify the exact temp log.
            coord_port="$(${pkgs.babashka}/bin/bb -e \
              '(with-open [socket (java.net.ServerSocket. 0)] (println (.getLocalPort socket)))')"
            coord_log="$smoke/state with spaces/facts.log"
            HOME="$smoke/home" FRAM_PORT="$coord_port" FRAM_LOG="$coord_log" \
              NORTH_COORD_PID_FILE="$smoke/coord.pid" \
              $out/bin/north up > "$smoke/up.out"
            coord_pid=$(cat "$smoke/coord.pid")
            kill -0 "$coord_pid"
            HOME="$smoke/home" FRAM_PORT="$coord_port" FRAM_LOG="$coord_log" \
              $out/bin/north coord-doctor > "$smoke/coord-doctor.out"
            grep -q 'serving the canonical log' "$smoke/coord-doctor.out"
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= NO_COLOR=1 \
              NORTH_PORT="$coord_port" FRAM_PORT="$coord_port" FRAM_LOG="$coord_log" \
              $out/bin/north doctor > "$smoke/doctor.out"
            grep -Eq 'north  package rev [^? ]+' "$smoke/doctor.out"
            grep -Eq 'fram  package rev [^? ]+' "$smoke/doctor.out"
            # Cross the packaged TypeScript graph-store seam with FRAM_BIN in
            # its public form: a bin directory, never an executable path.
            HOME="$smoke/home" PATH="${runtimePath}" \
              NORTH_BIN="$out/bin/north" NORTH_PORT="$coord_port" \
              FRAM_PORT="$coord_port" FRAM_LOG="$coord_log" FRAM_BIN="${framPkg}/bin" \
              ${pkgs.bun}/bin/bun -e \
              'import {
                 CoordinatorSyncLeaseManager, LINEAR_GRAPH_VALUE_MAX_BYTES, NorthGraphStore,
               } from "'$out'/sdk/src/integrations/linear/north-state.ts";
               import { canonicalJson } from "'$out'/sdk/src/integrations/linear/normalize.ts";
               import { createLinearSyncBaseline } from "'$out'/sdk/src/integrations/linear/reconcile.ts";
               const store = new NorthGraphStore();
               const before = await store.show("package-linear-graph-store");
               if (before.length !== 0)
                 throw new Error("north package smoke: isolated graph store was not empty");
               await store.put("package-linear-graph-store", "kind", "package_smoke");
               const written = await store.show("package-linear-graph-store");
               if (!written.some((fact) => fact.predicate === "kind" && fact.value === "package_smoke"))
                 throw new Error("north package smoke: packaged graph store put was not visible");
               const bootstrapSubject = "link:linear:mcp-bootstrap-v1:linear-package:" + "a".repeat(64);
               await store.put(bootstrapSubject, "kind", "integration_link");
               await store.put(
                 bootstrapSubject,
                 "sync_manifest",
                 canonicalJson({
                   version: 1,
                   phase: "prepared",
                   baseline: createLinearSyncBaseline(
                     {
                       identityKind: "mcp-bootstrap-v1",
                       connector: "linear-package",
                       fingerprint: "a".repeat(64),
                     },
                     "package-bootstrap-thread",
                     {
                       title: "Package bootstrap smoke",
                       body: "",
                       doneWhen: [],
                       barEvidence: [],
                       repos: [],
                       lifecycle: "ready",
                     },
                   ),
                   evidence: {
                     connector: "linear-package",
                     createdAt: "2026-07-19T00:00:00.000Z",
                     initialKey: "PACKAGE-1",
                     workspace: "package",
                   },
                 }),
               );
               const found = await store.findBootstrapLinkSubjects(
                 "linear-package",
                 "2026-07-19T00:00:00.000Z",
               );
               if (found.length !== 1 || found[0] !== bootstrapSubject)
                 throw new Error("north package smoke: packaged bootstrap evidence lookup disagreed");
               const leases = new CoordinatorSyncLeaseManager();
               const lease = await leases.acquire("linear-sync:package-private-frame");
               try {
                 const unit = String.fromCharCode(34, 92, 10);
                 const value = unit.repeat(Math.floor(LINEAR_GRAPH_VALUE_MAX_BYTES / unit.length))
                   + "x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES % unit.length);
                 if (Buffer.byteLength(value, "utf8") !== LINEAR_GRAPH_VALUE_MAX_BYTES)
                   throw new Error("north package smoke: private-frame boundary fixture is the wrong size");
                 await store.putFenced(lease, "package-linear-private-frame", "note", value);
                 const privateFacts = await store.show("package-linear-private-frame");
                 if (!privateFacts.some((fact) => fact.predicate === "note" && fact.value === value))
                   throw new Error("north package smoke: maximum private frame did not round-trip");
                 let rejected = false;
                 try {
                   await store.putFenced(
                     lease,
                     "package-linear-private-frame",
                     "note",
                     "x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES + 1),
                   );
                 } catch (error) {
                   rejected = String(error).includes("exceeds " + LINEAR_GRAPH_VALUE_MAX_BYTES + " bytes");
                 }
                 if (!rejected)
                   throw new Error("north package smoke: oversized private frame was not rejected");
               } finally {
                 await lease.release();
               }'
            # The Linear identity↔thread invariant depends on the packaged
            # global-version CAS helper, not merely the TypeScript entrypoint.
            # Reserve one partial link, then prove a second identity cannot
            # claim the same thread even though the first link has no kind fact.
            linear_thread="package-linear-thread"
            linear_link_a="link:linear:uuid:22222222-2222-8222-8222-222222222222:11111111-1111-8111-8111-111111111111"
            linear_resource_a="linear-sync:identity:linear%3Auuid%3A22222222-2222-8222-8222-222222222222%3A11111111-1111-8111-8111-111111111111"
            linear_holder_a="package-linear-a"
            HOME="$smoke/home" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb "$out/cli/lease-cli.clj" "$coord_port" --json \
              acquire "$linear_resource_a" "$linear_holder_a" 300000 \
              > "$smoke/linear-lease-a.json"
            if ! linear_epoch_a="$(${pkgs.jq}/bin/jq -er '.epoch' \
              "$smoke/linear-lease-a.json" 2> "$smoke/linear-lease-a.err")"; then
              echo "north package smoke: first Linear reservation lease was invalid" >&2
              sed -n '1,80p' "$smoke/linear-lease-a.json" >&2
              sed -n '1,80p' "$smoke/linear-lease-a.err" >&2
              exit 1
            fi
            HOME="$smoke/home" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb \
              "$out/sdk/src/integrations/linear/reserve-link.clj" \
              "$coord_port" "$linear_resource_a" "$linear_holder_a" "$linear_epoch_a" \
              "$linear_link_a" "$linear_thread" "linear-package" "-" \
              > "$smoke/linear-reserve-a.json"
            if ! ${pkgs.jq}/bin/jq -e '.ok | numbers' \
              "$smoke/linear-reserve-a.json" > /dev/null; then
              echo "north package smoke: first Linear binding reservation failed" >&2
              sed -n '1,80p' "$smoke/linear-reserve-a.json" >&2
              exit 1
            fi

            linear_link_b="link:linear:uuid:22222222-2222-8222-8222-222222222222:33333333-3333-8333-8333-333333333333"
            linear_resource_b="linear-sync:identity:linear%3Auuid%3A22222222-2222-8222-8222-222222222222%3A33333333-3333-8333-8333-333333333333"
            linear_holder_b="package-linear-b"
            HOME="$smoke/home" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb "$out/cli/lease-cli.clj" "$coord_port" --json \
              acquire "$linear_resource_b" "$linear_holder_b" 300000 \
              > "$smoke/linear-lease-b.json"
            if ! linear_epoch_b="$(${pkgs.jq}/bin/jq -er '.epoch' \
              "$smoke/linear-lease-b.json" 2> "$smoke/linear-lease-b.err")"; then
              echo "north package smoke: second Linear reservation lease was invalid" >&2
              sed -n '1,80p' "$smoke/linear-lease-b.json" >&2
              sed -n '1,80p' "$smoke/linear-lease-b.err" >&2
              exit 1
            fi
            HOME="$smoke/home" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb \
              "$out/sdk/src/integrations/linear/reserve-link.clj" \
              "$coord_port" "$linear_resource_b" "$linear_holder_b" "$linear_epoch_b" \
              "$linear_link_b" "$linear_thread" "linear-package" "-" \
              > "$smoke/linear-reserve-b.json"
            if ! ${pkgs.jq}/bin/jq -e \
              '.reject | strings | contains("already reserved by")' \
              "$smoke/linear-reserve-b.json" > /dev/null; then
              echo "north package smoke: competing Linear binding was not rejected exactly" >&2
              sed -n '1,80p' "$smoke/linear-reserve-b.json" >&2
              exit 1
            fi
            # North-managed daemons require the log-fence protocol. Exercise
            # the shared CLI seam against strict mode, then prove a mismatched
            # corpus and a raw bypass are both rejected without changing either
            # file.
            HOME="$smoke/home" FRAM_PORT="$coord_port" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb $out/cli/coord.clj "$coord_port" \
              > "$smoke/strict-shared.out"
            grep -Eq ':version [0-9]+' "$smoke/strict-shared.out"
            wrong_log="$smoke/state with spaces/wrong.log"
            : > "$wrong_log"
            cp "$coord_log" "$smoke/coord.before"
            cp "$wrong_log" "$smoke/wrong.before"
            HOME="$smoke/home" NORTH_ROOT="$out" FRAM_PORT="$coord_port" \
              FRAM_LOG="$wrong_log" ${pkgs.babashka}/bin/bb -e \
              '(load-file (str (System/getenv "NORTH_ROOT") "/cli/coord.clj"))
               (prn (north.coord/append!
                     (Integer/parseInt (System/getenv "FRAM_PORT"))
                     "@package-fence" "note" "must-not-land"))' \
              > "$smoke/wrong-log.out"
            grep -q ':code :log-mismatch' "$smoke/wrong-log.out"
            NORTH_TEST_PORT="$coord_port" ${pkgs.babashka}/bin/bb -e \
              '(require (quote [clojure.edn :as edn])
                        (quote [clojure.java.io :as io]))
               (with-open [s (java.net.Socket.
                              "127.0.0.1"
                              (Integer/parseInt
                               (System/getenv "NORTH_TEST_PORT")))]
                 (let [w (.getOutputStream s)
                       r (io/reader (.getInputStream s))]
                   (.write w (.getBytes
                              (str (pr-str {:op :assert
                                            :te "@raw-package-fence"
                                            :p "note"
                                            :r "must-not-land"})
                                   "\n")))
                   (.flush w)
                   (prn (edn/read-string (.readLine r)))))' \
              > "$smoke/raw-fence.out"
            grep -q ':code :log-fence-required' "$smoke/raw-fence.out"
            ${pkgs.diffutils}/bin/cmp "$smoke/coord.before" "$coord_log"
            ${pkgs.diffutils}/bin/cmp "$smoke/wrong.before" "$wrong_log"
            ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              ${pkgs.iproute2}/bin/ss -tlnH "sport = :$coord_port" | grep -q .
            ''}
            ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
              test "$(${pkgs.lsof}/bin/lsof -nP -iTCP:"$coord_port" -sTCP:LISTEN -t)" = "$coord_pid"
            ''}
            kill "$coord_pid"
            for _ in $(seq 1 40); do
              kill -0 "$coord_pid" 2>/dev/null || break
              sleep 0.1
            done
            kill -0 "$coord_pid" 2>/dev/null && {
              echo "north package smoke: coordinator ignored SIGTERM" >&2
              exit 1
            }
            coord_pid=
            # Import the public SDK and prove npm selected an executable native
            # Claude binary for this exact Nix system. This resolves no account
            # and makes no model turn.
            (
              cd $out/sdk
              HOME="$smoke/home" ${pkgs.bun}/bin/bun -e \
                'import { query } from "@anthropic-ai/claude-agent-sdk";
                 import { constants, accessSync } from "node:fs";
                 import { createRequire } from "node:module";
                 import { dirname, resolve } from "node:path";
                 const require = createRequire(import.meta.url);
                 const manifest = require.resolve("${sdkPlatform.packageName}/package.json");
                 accessSync(resolve(dirname(manifest), "claude"), constants.X_OK);
                 if (typeof query !== "function") process.exit(1);'
            )
            now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
            reset=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
            printf '{"version":1,"observations":[{"targetId":"openai","provider":"openai","observedAt":"%s","windows":[{"usedPercent":10,"resetsAt":"%s"}]}]}\n' "$now" "$reset" > "$smoke/observations.json"
            HOME="$smoke/home" NORTH_CLAUDE_BIN="$smoke/bin/claude" NORTH_CODEX_BIN="$smoke/bin/codex" \
              NORTH_PROVIDER_OBSERVATIONS="$smoke/observations.json" $out/bin/north providers --json > "$smoke/providers.json"
            ${pkgs.jq}/bin/jq -e \
              '([.providers[].targets[] | select(.id == "anthropic")][0] | .installed and .authenticated) and
               ([.providers[].targets[] | select(.id == "openai")][0] |
                 .installed and .authenticated and .headroom == "plenty")' \
              "$smoke/providers.json" > /dev/null
            HOME="$smoke/home" NO_COLOR=1 $out/bin/north spawn implementer probe \
              --provider openai --dry-run > "$smoke/spawn.out"
            grep -q 'grade=mid tier=standard' "$smoke/spawn.out"
            grep -q 'AGENT_ROLE=implementer' "$smoke/spawn.out"
            # Runtime Gaffer reads must be hermetic: exercise exact provider/model
            # resolution against the packaged contract, with no sibling checkout.
            GAFFER_HOME=${gafferContract} HOME="$smoke/home" ${pkgs.bun}/bin/bun -e \
              'import { resolveModelAlias, resolveModelDelta, resolveTier } from "'$out'/sdk/src/providers/catalog.ts";
               const route = resolveTier("openai", "frontier");
               const opus = resolveModelAlias("anthropic", "opus");
               const delta = resolveModelDelta("anthropic", opus);
               const validDelta = delta.provider === "anthropic" && delta.model === "claude-opus-4-8"
                 && (delta.kind === "calibrated"
                   ? Boolean(delta.path?.trim() && delta.absolutePath?.trim())
                   : delta.kind === "none" && Boolean(delta.reason?.trim()));
               if (route.model !== "gpt-5.6-sol" || opus !== "claude-opus-4-8" || !validDelta) process.exit(1);'
            grep -q '^## research-grade$' ${gafferContract}/docs/task-grades.md
            grep -q '^## worker$' ${gafferContract}/docs/topologies.md
            grep -q '^## universal$' ${gafferContract}/docs/comms.md
            printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | \
              ${pkgs.coreutils}/bin/env -i HOME="$smoke/home" PATH= \
              $out/bin/north-mcp > "$smoke/north-mcp-tools.json"
            ${pkgs.jq}/bin/jq -e \
              '([.result.tools[] | select(.name | startswith("linear_")) | .name] | sort) == ["linear_get", "linear_import", "linear_plan", "linear_sync"]' \
              "$smoke/north-mcp-tools.json" > /dev/null
            mkdir -p "$smoke/home/.config/north" \
              "$smoke/home/.local/state/north/accounts/anthropic/claude-smoke"
            printf '{"version":1,"mode":"balanced","targets":[{"id":"claude-smoke","provider":"anthropic","authMode":"isolated","profile":"claude-smoke"}],"targetOrder":["claude-smoke"]}\n' \
              > "$smoke/home/.config/north/routing-policy.json"
            printf '{"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":4102444800}}}\n' | \
              HOME="$smoke/home" \
              CLAUDE_CONFIG_DIR="$smoke/home/.local/state/north/accounts/anthropic/claude-smoke" \
              NORTH_PROVIDER_OBSERVATIONS="$smoke/ingested.json" \
              $out/bin/north provider-observe claude-statusline
            test -s "$smoke/ingested.json"
            runHook postInstall
          '';

          meta = with lib; {
            description = "north — fact-native work coordination CLI + MCP server";
            mainProgram = "north";
            platforms = [
              "x86_64-linux"
              "aarch64-linux"
              "aarch64-darwin"
            ];
          };
        };
      in {
        packages = {
          default = northPkg;
          north = northPkg;
          north-web = northWebPkg;
          fram-engine = framPkg;
        };

        apps = {
          default = {
            type = "app";
            program = "${northPkg}/bin/north";
            meta.description = "North provider-neutral coordination CLI";
          };
          north = {
            type = "app";
            program = "${northPkg}/bin/north";
            meta.description = "North provider-neutral coordination CLI";
          };
          north-mcp = {
            type = "app";
            program = "${northPkg}/bin/north-mcp";
            meta.description = "North fact and coordination MCP server";
          };
          north-web = {
            type = "app";
            program = "${northWebPkg}/bin/north-web";
            meta.description = "North local web cockpit";
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # north CLI + the bjs/Bun web cockpit (web-bjs/). The Elixir/Phoenix
            # app was retired 2026-07-10 (see web-v1-archive/); beagle is provided
            # system-wide by the nixos beagle module.
            babashka
            bun
          ];
        };
      });
}
