{
  description = "north — fact-native work coordination (CLI + MCP, on babashka)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Codex moves faster than the general runtime package set. Keep its package
    # source explicit so consumers such as Firn can make this input follow their
    # own canonical nixpkgs-master pin without changing North's package graph.
    nixpkgs-master.url = "github:NixOS/nixpkgs/master";
    flake-utils.url = "github:numtide/flake-utils";

    # Fram owns and verifies its complete runtime closure. North consumes that
    # package directly and uses its published runtime/classpath contract; it
    # must not maintain a second partial Fram packager.
    fram = {
      url = "github:tompassarelli/fram";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    gaffer = {
      url = "github:tompassarelli/gaffer";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, nixpkgs-master, flake-utils, fram, gaffer }:
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
        codexPkgs = nixpkgs-master.legacyPackages.${system};
        codexPatch = ./patches/codex-0.144.4/managed-hook-failure-mode.patch;
        codexExpectedIdentity = {
          version = "0.144.4";
          owner = "openai";
          repo = "codex";
          rev = "refs/tags/rust-v0.144.4";
          tag = "rust-v0.144.4";
          srcHash = "sha256-NmYZxjNFPkRWN4rw+eeka10pJt6/oU3ZoLXBxj3dPRU=";
          cargoHash = "sha256-S4dsZXfmKvJItL2XYKyxfhqdCMATEG6oPjrtVRwkuYc=";
          patchSha256 = "36e07d12702e31bffb82fbfe577a6f22c81424f1510a78ea3a2add9ca0879bc3";
        };
        codexUpstreamPkg =
          codexPkgs.codex or
            (throw "nixpkgs-master does not provide Codex for North's supported system ${system}");
        codexObservedIdentity = {
          version = codexUpstreamPkg.version or null;
          owner = codexUpstreamPkg.src.owner or null;
          repo = codexUpstreamPkg.src.repo or null;
          rev = codexUpstreamPkg.src.rev or null;
          tag = codexUpstreamPkg.src.tag or null;
          srcHash = codexUpstreamPkg.src.outputHash or null;
          cargoHash = codexUpstreamPkg.cargoHash or null;
          patchSha256 = builtins.hashFile "sha256" codexPatch;
        };
        codexPkg =
          assert lib.assertMsg
            (codexObservedIdentity == codexExpectedIdentity)
            ("North's managed Codex patch source identity drifted; expected "
              + builtins.toJSON codexExpectedIdentity + "; observed "
              + builtins.toJSON codexObservedIdentity);
          codexUpstreamPkg.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ [ codexPatch ];
            postPatch = (old.postPatch or "") + ''
              grep -Fq 'pub enum ManagedHookFailureMode' protocol/src/config_types.rs
              grep -Fq 'PreToolUseBlockSource::ManagedTechnicalFailure' core/src/hook_runtime.rs
              grep -Fq 'does not change `PostToolUse`' \
                app-server-protocol/schema/typescript/ManagedHookFailureMode.ts
              test "$(sha256sum Cargo.lock | cut -d' ' -f1)" = \
                175793a40a3147db1fee08fd9db0acc59312c344b3513dd7ee316f5446d8119e
            '';
            passthru = (old.passthru or { }) // {
              northManagedHookFailurePolicy = {
                version = 1;
                scope = "administrator-managed-pre-tool-use";
                defaultMode = "continue";
                enforcedMode = "block";
                patchSha256 = codexObservedIdentity.patchSha256;
                upstreamIdentity = codexObservedIdentity;
              };
            };
          });
        codexVersionSmoke = pkgs.runCommand
          "north-codex-version-smoke-${codexPkg.version}"
          { nativeBuildInputs = [ codexPkg ]; }
          ''
            expected='codex-cli ${codexPkg.version}'
            actual="$(${codexPkg}/bin/codex --version)"
            if [ "$actual" != "$expected" ]; then
              echo "North Codex package version mismatch" >&2
              echo "expected: $expected" >&2
              echo "actual:   $actual" >&2
              exit 1
            fi
            touch "$out"
          '';
        codexManagedHookFailureSmoke = pkgs.runCommand
          "north-codex-managed-hook-failure-smoke-${codexPkg.version}"
          {
            nativeBuildInputs = [
              pkgs.bash
              pkgs.coreutils
              pkgs.python3
            ];
          }
          ''
            bash ${./bin/tests/codex-managed-hook-failure-smoke.sh} \
              ${codexPkg}/bin/codex \
              ${pkgs.libredirect}/lib/libredirect.so \
              ${pkgs.python3}/bin/python3
            touch "$out"
          '';
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
        # for daemon-health probes and procps supplies lifecycle-hook `pgrep`;
        # neither has a Darwin package, where the corresponding host utilities
        # are part of the platform runtime.
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
          pkgs.python3
          pkgs.util-linux
        ] ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [
          pkgs.iproute2
          pkgs.procps
        ] ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
          pkgs.lsof
        ];
        runtimePath = lib.makeBinPath runtimePackages
          + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin
            ":/usr/bin:/bin:/usr/sbin:/sbin";
        framPkg = fram.packages.${system}.default;
        framRuntimeRoot =
          framPkg.runtimeRoot or
            (throw "Fram package must publish passthru.runtimeRoot");
        framBabashkaClasspath =
          framPkg.babashkaClasspath or
            (throw "Fram package must publish passthru.babashkaClasspath");
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
            ./bin/north-actor-key
            ./bin/north-mark-delegated
            ./bin/north-on-spawn
            ./bin/north-on-stop
            ./bin/north-on-tooluse
            ./bin/north-clock-audit
            ./bin/north-coord-up
            ./bin/north-stream-sync
            ./bin/concern
            ./bin/ensure-private-docs
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

        # sdk.mjs is self-contained; at runtime it needs the public package and
        # the exact native Claude binary for this host. Fetching those tarballs
        # directly keeps each system's closure bounded instead of prefetching
        # every 200+ MB optional OS/architecture package in npm's universal
        # lockfile.
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

        # north CLI + MCP. Same relocatable layout. FRAM_HOME is baked to the
        # packaged engine so the CLI is self-contained. Package-owned code and
        # provenance selectors are exact wrapper values; only public data/store
        # selectors remain caller-configurable. NORTH_BIN points the MCP server
        # at the wrapped CLI in this same out.
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
          nativeBuildInputs = [
            pkgs.makeWrapper
            pkgs.babashka
            pkgs.python3
            pkgs.ripgrep
          ];
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
            cp bin/north bin/north-mcp bin/north-actor-key \
              bin/north-mark-delegated bin/north-on-spawn bin/north-on-stop \
              bin/north-on-tooluse bin/north-clock-audit bin/north-coord-up \
              bin/north-stream-sync bin/concern bin/ensure-private-docs \
              $out/bin/
            patchShebangs $out/bin

            # The Linear route is spread across these load-bearing runtime
            # modules. Catch untracked/omitted flake sources before producing a
            # package whose `north linear` verb points at a missing entrypoint.
            for f in cli.ts north-state.ts app-server-broker.ts \
              reserve-link.clj reserve-schema-fact.clj \
              find-bootstrap-links.clj; do
              test -f "$out/sdk/src/integrations/linear/$f"
            done
            test -f "$out/sdk/src/strict-json.ts"

            wrapProgram $out/bin/north \
              --prefix PATH : ${runtimePath} \
              --set FRAM_HOME ${framRuntimeRoot} \
              --set FRAM_BIN ${framPkg}/bin \
              --set FRAM_OUT ${framBabashkaClasspath} \
              --set GAFFER_HOME ${gafferContract} \
              --set NORTH_HOME $out \
              --set NORTH_BIN $out/bin/north \
              --set NORTH_BB ${pkgs.babashka}/bin/bb \
              --set NORTH_BUN ${pkgs.bun}/bin/bun \
              --set NORTH_GIT_BIN ${pkgs.git}/bin/git \
              --set NORTH_MKFIFO_BIN ${pkgs.coreutils}/bin/mkfifo \
              --set NORTH_PEER_BB ${pkgs.babashka}/bin/bb \
              --set NORTH_MCP_BB ${pkgs.babashka}/bin/bb \
              --set NORTH_MCP_BUN ${pkgs.bun}/bin/bun \
              --set NORTH_MANAGED_CODEX_BIN ${codexPkg}/bin/codex \
              --set NORTH_PACKAGE_MODE nix-store \
              --set NORTH_PACKAGE_REV ${builtins.substring 0 12 (self.rev or self.dirtyRev or "dirty")} \
              --set FRAM_PACKAGE_REV ${builtins.substring 0 12 (fram.rev or fram.dirtyRev or "local")}

            wrapProgram $out/bin/north-mcp \
              --prefix PATH : ${runtimePath} \
              --set FRAM_HOME ${framRuntimeRoot} \
              --set FRAM_BIN ${framPkg}/bin \
              --set FRAM_OUT ${framBabashkaClasspath} \
              --set GAFFER_HOME ${gafferContract} \
              --set NORTH_HOME $out \
              --set NORTH_BIN $out/bin/north \
              --set NORTH_BB ${pkgs.babashka}/bin/bb \
              --set NORTH_BUN ${pkgs.bun}/bin/bun \
              --set NORTH_GIT_BIN ${pkgs.git}/bin/git \
              --set NORTH_MKFIFO_BIN ${pkgs.coreutils}/bin/mkfifo \
              --set NORTH_PEER_BB ${pkgs.babashka}/bin/bb \
              --set NORTH_MCP_BB ${pkgs.babashka}/bin/bb \
              --set NORTH_MCP_BUN ${pkgs.bun}/bin/bun \
              --set NORTH_MANAGED_CODEX_BIN ${codexPkg}/bin/codex

            for hook in north-mark-delegated north-on-spawn north-on-stop \
              north-on-tooluse; do
              wrapProgram "$out/bin/$hook" \
                --prefix PATH : ${runtimePath} \
                --set NORTH_HOME $out
            done

            wrapProgram $out/bin/north-clock-audit \
              --prefix PATH : ${runtimePath} \
              --set FRAM_HOME ${framRuntimeRoot} \
              --set FRAM_OUT ${framBabashkaClasspath} \
              --set NORTH_HOME $out \
              --set NORTH_BB ${pkgs.babashka}/bin/bb

            wrapProgram $out/bin/north-stream-sync \
              --prefix PATH : ${runtimePath} \
              --set NORTH_PACKAGE_MODE nix-store

            wrapProgram $out/bin/north-coord-up \
              --prefix PATH : ${runtimePath} \
              --set FRAM_HOME ${framRuntimeRoot} \
              --set FRAM_BIN ${framPkg}/bin \
              --set NORTH_HOME $out

            wrapProgram $out/bin/concern \
              --prefix PATH : ${runtimePath} \
              --set NORTH_HOME $out \
              --set NORTH_BB ${pkgs.babashka}/bin/bb

            wrapProgram $out/bin/ensure-private-docs \
              --prefix PATH : ${runtimePath} \
              --set NORTH_HOME $out

            impurity_pattern='/(home|Users)/|/run/current-system/sw|/code/north(?:/|\b)|~/code/north|[$]HOME/code/north|[.]m2|[.]cpcache|[.]cache/babashka'
            # Two audited exceptions to the store-external scan, and only these:
            # sdk/src/trusted-runtime.ts's NixOS entry-hint pointers
            # /run/current-system/sw/bin/{git,bb}. They are root-managed runtime
            # symlinks, NOT baked store paths — trustedStoreExecutable() still
            # forces each to canonicalize (realpathSync) into the immutable
            # /nix/store and be executable, so they never widen trust. They are
            # required because managed spawns don't always inherit the wrapper's
            # NORTH_GIT_BIN / NORTH_BB. The exemption is line-exact: any other
            # path in that same file, any other system-profile target, and every
            # match in every other file stays fatal.
            sanctioned='(^|/)sdk/src/trusted-runtime\.ts:[0-9]+:[[:space:]]*"/run/current-system/sw/bin/(git|bb)",$'
            residual=$(LC_ALL=C rg --hidden -n "$impurity_pattern" "$out" \
              | LC_ALL=C rg -v "$sanctioned" || true)
            if [ -n "$residual" ]; then
              printf '%s\n' "$residual" >&2
              echo "north package contains a checkout/home/cache path" >&2
              exit 1
            fi

            # Exercise every packaged TypeScript CLI entrypoint with hermetic
            # subscription/auth fixtures. These probes never make a model turn.
            smoke=$(mktemp -d)
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/poison-home" \
              NORTH_HOME="$out" \
              WORKTREE_MODULE="$out/sdk/src/worktree.ts" \
              EXPECTED_NORTH_BIN="$out/bin/north" \
              ${pkgs.bun}/bin/bun -e '
                const module = await import(process.env.WORKTREE_MODULE);
                const actual = module.worktreeNorthExecutable(process.env);
                if (actual !== process.env.EXPECTED_NORTH_BIN)
                  throw new Error("packaged worktree North CLI mismatch: " + actual);
              '
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
            # The managed OpenAI surface is an exact nixpkgs-master package,
            # never the ambient PATH fixture used by account/auth probes below.
            test -e ${codexVersionSmoke}
            expected_codex_export="export NORTH_MANAGED_CODEX_BIN='${codexPkg}/bin/codex'"
            expected_mkfifo_export="export NORTH_MKFIFO_BIN='${pkgs.coreutils}/bin/mkfifo'"
            for wrapper in "$out/bin/north" "$out/bin/north-mcp"; do
              test "$(grep -Fxc "$expected_codex_export" "$wrapper")" -eq 1
              test "$(grep -Fc 'NORTH_MANAGED_CODEX_BIN=' "$wrapper")" -eq 1
              test "$(grep -Fxc "$expected_mkfifo_export" "$wrapper")" -eq 1
              test "$(grep -Fc 'NORTH_MKFIFO_BIN=' "$wrapper")" -eq 1
            done
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
            HOME="$smoke/home" PATH="$smoke" NORTH_GIT_BIN="$smoke/forged-git" FRAM_PORT=39123 \
              $out/bin/north validate > "$smoke/validate.out"
            grep -q 'no violations' "$smoke/validate.out"
            HOME="$smoke/home" PATH="$smoke" NORTH_GIT_BIN="${pkgs.git}/bin/git" \
              ${pkgs.bun}/bin/bun -e \
              'import { trustedGitExecutable } from "'$out'/sdk/src/clock.ts";
               if (trustedGitExecutable() !== "${pkgs.git}/bin/git")
                 throw new Error("north package smoke: clock did not consume packaged Git");'
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

            # Provider hooks are public North runtime surfaces too. Exercise
            # their Python shebang/import path and sibling actor-key lookup with
            # an empty ambient PATH, then cross the real hook mail fast path.
            hook_runtime="$smoke/hook-runtime"
            hook_session=package-hook-session
            hook_actor=package-hook-agent
            mkdir -p "$hook_runtime"
            test -x "$(${pkgs.coreutils}/bin/env -i PATH="${runtimePath}" \
              ${pkgs.bash}/bin/bash -c 'command -v pgrep')"
            hook_key="$(${pkgs.coreutils}/bin/env -i PATH= \
              $out/bin/north-actor-key session "$hook_session")"
            printf '%s\n' "$hook_key" | \
              ${pkgs.gnugrep}/bin/grep -Eq '^[0-9a-f]{64}$'
            hook_input="$(printf \
              '{"cwd":"%s","session_id":"%s","hook_event_name":"SessionStart","model":"package-smoke","effort":{"level":"low"}}' \
              "$smoke/home" "$hook_session")"
            printf '%s' "$hook_input" | ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= XDG_RUNTIME_DIR="$hook_runtime" \
              NORTH_AGENT_ID="$hook_actor" NORTH_PORT="$coord_port" \
              FRAM_LOG="$coord_log" AGENT_PROVIDER=openai \
              $out/bin/north-on-spawn > "$smoke/hook-spawn.out"
            ${pkgs.python3}/bin/python3 - \
              "$smoke/hook-spawn.out" "$out" "$hook_actor" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
specific = value["hookSpecificOutput"]
assert specific["hookEventName"] == "SessionStart"
context = specific["additionalContext"]
assert sys.argv[3] in context
assert f"{sys.argv[2]}/bin/north listen {sys.argv[3]}" in context
PY
            test "$(cat "$hook_runtime/north-agent-ids/$hook_key")" = \
              "$hook_actor"

            printf '%s' "$hook_input" | ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= XDG_RUNTIME_DIR="$hook_runtime" \
              NORTH_AGENT_ID="$hook_actor" \
              $out/bin/north-mark-delegated
            test "$(head -n1 "$hook_runtime/north-delegated/$hook_key")" = \
              "$hook_actor"
            printf '%s' "$hook_input" | ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= XDG_RUNTIME_DIR="$hook_runtime" \
              NORTH_AGENT_ID="$hook_actor" \
              $out/bin/north-on-stop > "$smoke/hook-stop.out"
            ${pkgs.python3}/bin/python3 - \
              "$smoke/hook-stop.out" "$out" "$hook_actor" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert value["decision"] == "block"
assert f"{sys.argv[2]}/bin/north listen {sys.argv[3]}" in value["reason"]
PY

            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH="${runtimePath}" \
              FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb $out/cli/msg-cli.clj "$coord_port" \
                send package-hook-sender "$hook_actor" \
                package-hook-mail 'ambient-PATH-free delivery' \
                > "$smoke/hook-send.out"
            grep -q 'sent @msg:' "$smoke/hook-send.out"
            printf '%s' "$hook_input" | ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= XDG_RUNTIME_DIR="$hook_runtime" \
              NORTH_AGENT_ID="$hook_actor" NORTH_PORT="$coord_port" \
              FRAM_LOG="$coord_log" AGENT_PROVIDER=openai \
              $out/bin/north-on-tooluse > "$smoke/hook-tooluse.out"
            ${pkgs.python3}/bin/python3 - \
              "$smoke/hook-tooluse.out" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
specific = value["hookSpecificOutput"]
assert specific["hookEventName"] == "PostToolUse"
assert "package-hook-mail" in specific["additionalContext"]
assert "ambient-PATH-free delivery" in specific["additionalContext"]
PY
            ${pkgs.coreutils}/bin/env -i \
              HOME="$smoke/home" PATH= NO_COLOR=1 \
              NORTH_PACKAGE_MODE=forged NORTH_PACKAGE_REV=forged FRAM_PACKAGE_REV=forged \
              NORTH_PORT="$coord_port" FRAM_PORT="$coord_port" FRAM_LOG="$coord_log" \
              $out/bin/north doctor > "$smoke/doctor.out"
            grep -Fq 'north  package rev ${builtins.substring 0 12 (self.rev or self.dirtyRev or "dirty")}' "$smoke/doctor.out"
            grep -Fq 'fram  package rev ${builtins.substring 0 12 (fram.rev or fram.dirtyRev or "local")}' "$smoke/doctor.out"
            if grep -q forged "$smoke/doctor.out"; then
              echo "north package smoke: ambient provenance overrode the package pins" >&2
              exit 1
            fi
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
              "$linear_link_a" "$linear_thread" "linear-package" "linear-uuid" \
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
              "$linear_link_b" "$linear_thread" "linear-package" "linear-uuid" \
              > "$smoke/linear-reserve-b.json"
            if ! ${pkgs.jq}/bin/jq -e \
              '.reject | strings | contains("already reserved by")' \
              "$smoke/linear-reserve-b.json" > /dev/null; then
              echo "north package smoke: competing Linear binding was not rejected exactly" >&2
              sed -n '1,80p' "$smoke/linear-reserve-b.json" >&2
              exit 1
            fi
            # The adapter-owned schema installer is also a packaged CAS helper.
            # Prove it installs once, rejects an incompatible value, and leaves
            # the original value authoritative.
            HOME="$smoke/home" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb \
              "$out/sdk/src/integrations/linear/reserve-schema-fact.clj" \
              "$coord_port" exact linear_package_schema value_kind literal \
              > "$smoke/linear-schema-first.json"
            ${pkgs.jq}/bin/jq -e '.ok | numbers' \
              "$smoke/linear-schema-first.json" > /dev/null
            HOME="$smoke/home" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb \
              "$out/sdk/src/integrations/linear/reserve-schema-fact.clj" \
              "$coord_port" exact linear_package_schema value_kind ref \
              > "$smoke/linear-schema-conflict.json"
            ${pkgs.jq}/bin/jq -e \
              '.reject | strings | contains("conflicts")' \
              "$smoke/linear-schema-conflict.json" > /dev/null
            HOME="$smoke/home" FRAM_LOG="$coord_log" \
              ${pkgs.babashka}/bin/bb \
              "$out/sdk/src/integrations/linear/reserve-schema-fact.clj" \
              "$coord_port" exact linear_package_schema value_kind literal \
              > "$smoke/linear-schema-authority.json"
            ${pkgs.jq}/bin/jq -e '.ok | numbers' \
              "$smoke/linear-schema-authority.json" > /dev/null
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
          # This is the exact derivation injected into managed OpenAI lanes;
          # Firn can install and attest the same executable without repackaging.
          codex = codexPkg;
          fram-engine = framPkg;
        };

        checks = {
          codex-version = codexVersionSmoke;
        } // lib.optionalAttrs (system == "x86_64-linux") {
          codex-managed-hook-failure = codexManagedHookFailureSmoke;
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
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # North CLI + MCP. Archived web sources are not part of the shell.
            babashka
          ];
        };
      });
}
