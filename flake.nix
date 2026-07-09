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
  };

  outputs = { self, nixpkgs, flake-utils, fram }:
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

        # north CLI + MCP. Same relocatable layout. FRAM_HOME is baked to the
        # packaged engine so the CLI is self-contained; an explicit env override
        # still wins (the script reads ${FRAM_HOME:-...}). NORTH_BIN points the
        # MCP server at the wrapped CLI in this same out.
        ternPkg = pkgs.stdenvNoCC.mkDerivation {
          pname = "north";
          version = "0.1.0";
          src = self;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/bin $out/out
            cp -r out/. $out/out/
            cp bin/north bin/north-mcp $out/bin/

            wrapProgram $out/bin/north \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framPkg}

            wrapProgram $out/bin/north-mcp \
              --prefix PATH : ${runtimePath} \
              --set-default FRAM_HOME ${framPkg} \
              --set-default NORTH_BIN $out/bin/north
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
          default = ternPkg;
          north = ternPkg;
          fram-engine = framPkg;
        };

        apps = {
          default = {
            type = "app";
            program = "${ternPkg}/bin/north";
          };
          north = {
            type = "app";
            program = "${ternPkg}/bin/north";
          };
          north-mcp = {
            type = "app";
            program = "${ternPkg}/bin/north-mcp";
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Elixir / Erlang (Phoenix web app — OUT OF SCOPE for packaging)
            elixir
            beamPackages.erlang
            hex
            rebar3

            # native deps for Phoenix/Hologram
            inotify-tools
            nodejs_22

            # existing north deps
            babashka
            bun
          ];

          shellHook = ''
            export MIX_HOME="$PWD/.mix"
            export HEX_HOME="$PWD/.hex"
            export PATH="$MIX_HOME/bin:$HEX_HOME/bin:$PATH"
          '';
        };
      });
}
