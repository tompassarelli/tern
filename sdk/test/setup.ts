// Source-tree tests do not enter through North's Nix wrapper. Resolve the test
// runner's already-installed immutable Git once, before any suite can shadow
// PATH, and supply the same explicit injection contract production receives.
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

if (!process.env.NORTH_GIT_BIN) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      const candidate = realpathSync(join(directory, "git"));
      if (!/^\/nix\/store\/[0-9a-z]{32}-git(?:-[^/]+)?\/bin\/git$/.test(candidate))
        continue;
      accessSync(candidate, constants.X_OK);
      process.env.NORTH_GIT_BIN = candidate;
      break;
    } catch {
      // Test bootstrap keeps looking; production never performs this search.
    }
  }
}
