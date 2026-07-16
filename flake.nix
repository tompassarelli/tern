{
  description = "north — fact-native work coordination (CLI + MCP, on babashka)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # The Fram engine is north's runtime library: bin/north puts
    # $FRAM/out on the bb classpath (fram.kernel/fold/import/export/rt) and
    # shells $FRAM/bin/fram for engine verbs. Fram ships its compiled Clojure
    # in out/ (committed, runs on bare bb — no Beagle at runtime), so we consume
    # it as a plain source tree (flake = false) and wrap it the same way.
    # Pinned via this flake's lock; bump with `nix flake update fram`. (Must be a
    # fetchable URL, never a local path — a path: leaks the author's machine into
    # the published flake and breaks every other consumer + CI.)
    fram = {
      url = "github:tompassarelli/fram";
      flake = false;
    };
    gaffer = {
      url = "github:tompassarelli/gaffer";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, fram, gaffer }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;

        # Runtime PATH for the bb-backed CLIs. iproute2 (ss) + util-linux
        # (setsid) are only exercised by `north up` / fram-up (daemon
        # lifecycle); harmless to include, and they make those verbs work too.
        runtimePath = lib.makeBinPath [
          pkgs.babashka
          pkgs.coreutils
          pkgs.bash
          pkgs.bun
          pkgs.iproute2
          pkgs.util-linux
        ];

        # Fram engine packaged as a relocatable tree: $out/out (classpath) +
        # $out/bin/{fram,fram-up}. Each bin script does `dirname "$0"/..` to find
        # its repo root, so preserving the bin/ + out/ layout keeps that working;
        # wrapProgram only injects bb (+ daemon tools) onto PATH.
        framPkg = pkgs.stdenvNoCC.mkDerivation {
          pname = "fram-engine";
          version = builtins.substring 0 12 (fram.rev or "local");
          src = fram;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/bin $out/out
            cp -r out/. $out/out/
            for f in fram fram-up fram-daemon; do
              [ -f bin/$f ] && cp bin/$f $out/bin/$f
            done
            for f in $out/bin/*; do
              wrapProgram "$f" --prefix PATH : ${runtimePath}
            done
            runHook postInstall
          '';
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
            cp docs/roles.md docs/postures.md $out/docs/
            cp docs/deltas/opus.md docs/deltas/sonnet.md $out/docs/deltas/
            runHook postInstall
          '';
        };

        # north CLI + MCP. Same relocatable layout. FRAM_HOME is baked to the
        # packaged engine so the CLI is self-contained; an explicit env override
        # still wins (the script reads ${FRAM_HOME:-...}). NORTH_BIN points the
        # MCP server at the wrapped CLI in this same out.
        northPkg = pkgs.stdenvNoCC.mkDerivation {
          pname = "north";
          version = "0.1.0";
          src = self;
          # Babashka must be present while patchShebangs runs. Otherwise the
          # copied `#!/usr/bin/env bb` survives into `.north-mcp-wrapped`, where
          # the Nix build sandbox has no `/usr/bin/env` to execute.
          nativeBuildInputs = [ pkgs.makeWrapper pkgs.babashka ];
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
            # Package the complete TypeScript runtime tree. Hand-maintained
            # transitive import lists inevitably rot as provider adapters grow.
            cp -r sdk/src $out/sdk/src
            cp bin/north bin/north-mcp bin/concern $out/bin/
            patchShebangs $out/bin

            # The Linear route is spread across these load-bearing runtime
            # modules. Catch untracked/omitted flake sources before producing a
            # package whose `north linear` verb points at a missing entrypoint.
            for f in cli.ts north-state.ts app-server-broker.ts; do
              test -f "$out/sdk/src/integrations/linear/$f"
            done

            wrapProgram $out/bin/north \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framPkg} \
              --set-default GAFFER_HOME ${gafferContract} \
              --set-default NORTH_PACKAGE_MODE nix-store \
              --set-default NORTH_PACKAGE_REV ${builtins.substring 0 12 (self.rev or self.dirtyRev or "dirty")}

            wrapProgram $out/bin/north-mcp \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framPkg} \
              --set-default GAFFER_HOME ${gafferContract} \
              --set-default NORTH_BIN $out/bin/north

            # Exercise every packaged TypeScript CLI entrypoint with hermetic
            # subscription/auth fixtures. These probes never make a model turn.
            smoke=$(mktemp -d)
            trap 'rm -rf "$smoke"' EXIT
            mkdir -p "$smoke/bin" "$smoke/home"
            cat > "$smoke/bin/claude" <<'EOF'
#!${pkgs.bash}/bin/bash
if [ "$1" = "--version" ]; then echo 'claude smoke'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 2
EOF
            cat > "$smoke/bin/codex" <<'EOF'
#!${pkgs.bash}/bin/bash
if [ "$1" = "--version" ]; then echo 'codex smoke'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
exit 2
EOF
            chmod +x "$smoke/bin/claude" "$smoke/bin/codex"
            now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
            reset=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
            printf '{"version":1,"observations":[{"targetId":"openai","provider":"openai","observedAt":"%s","windows":[{"usedPercent":10,"resetsAt":"%s"}]}]}\n' "$now" "$reset" > "$smoke/observations.json"
            HOME="$smoke/home" NORTH_CLAUDE_BIN="$smoke/bin/claude" NORTH_CODEX_BIN="$smoke/bin/codex" \
              NORTH_PROVIDER_OBSERVATIONS="$smoke/observations.json" $out/bin/north providers > "$smoke/providers.out"
            grep -q 'anthropic.*installed=yes.*authenticated=yes' "$smoke/providers.out"
            grep -q 'openai.*installed=yes.*authenticated=yes.*headroom=plenty' "$smoke/providers.out"
            HOME="$smoke/home" NO_COLOR=1 $out/bin/north spawn implementer probe \
              --provider openai --dry-run > "$smoke/spawn.out"
            grep -q 'grade=mid tier=standard' "$smoke/spawn.out"
            grep -q 'AGENT_ROLE=implementer' "$smoke/spawn.out"
            printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | \
              $out/bin/north-mcp > "$smoke/north-mcp-tools.json"
            ${pkgs.jq}/bin/jq -e \
              '([.result.tools[] | select(.name | startswith("linear_")) | .name] | sort) == ["linear_get", "linear_import", "linear_plan", "linear_sync"]' \
              "$smoke/north-mcp-tools.json" > /dev/null
            printf '{"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":4102444800}}}\n' | \
              HOME="$smoke/home" NORTH_PROVIDER_OBSERVATIONS="$smoke/ingested.json" \
              $out/bin/north provider-observe claude-statusline
            test -s "$smoke/ingested.json"
            runHook postInstall
          '';

          meta = with lib; {
            description = "north — fact-native work coordination CLI + MCP server";
            mainProgram = "north";
            platforms = platforms.unix;
          };
        };
      in {
        packages = {
          default = northPkg;
          north = northPkg;
          fram-engine = framPkg;
        };

        apps = {
          default = {
            type = "app";
            program = "${northPkg}/bin/north";
          };
          north = {
            type = "app";
            program = "${northPkg}/bin/north";
          };
          north-mcp = {
            type = "app";
            program = "${northPkg}/bin/north-mcp";
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
