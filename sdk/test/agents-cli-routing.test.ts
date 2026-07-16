import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const north = resolve(import.meta.dir, "../..");
const cli = resolve(north, "cli/agents-cli.clj");
const gaffer = resolve(north, "../gaffer");

function dry(role: string, provider: string, ...extra: string[]): string {
  const result = spawnSync("bb", [cli, "spawn", role, "probe", "--provider", provider, "--dry-run", ...extra], {
    encoding: "utf8", env: { ...process.env, NO_COLOR: "1", GAFFER_HOME: gaffer,
      GAFFER_STAFFING_CATALOG: resolve(gaffer, "staffing/catalog.json") },
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

test("synthetic orchestrator and worker emit semantic axes, never Anthropic model ids", () => {
  for (const provider of ["anthropic", "openai"]) {
    const orchestrator = dry("orchestrator", provider);
    expect(orchestrator).toContain("AGENT_TIER=frontier");
    expect(orchestrator).toContain("AGENT_TOPOLOGY=orchestrator");
    expect(orchestrator).not.toContain("AGENT_MODEL=");
    const worker = dry("worker", provider);
    expect(worker).toContain("AGENT_TIER=senior");
    expect(worker).toContain("AGENT_TOPOLOGY=worker");
    expect(worker).not.toContain("AGENT_MODEL=");
  }
});

test("bespoke roles default to non-promoted and require explicit nomination", () => {
  expect(dry("migration-forensics", "openai", "--rationale", "one-off probe"))
    .toContain('promotionCandidate":false');
  expect(dry("migration-forensics", "openai", "--rationale", "one-off probe", "--nominate"))
    .toContain('promotionCandidate":true');
});

test("agent roster facts fold coordination and telemetry logs together", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-agent-split-"));
  try {
    const coordination = join(directory, "coordination.log");
    const telemetry = join(directory, "telemetry.log");
    writeFileSync(coordination, '{:tx 1 :op "assert" :l "@agent:coord" :p "display_name" :r "coord-name"}\n');
    writeFileSync(telemetry, '{:tx 2 :op "assert" :l "@agent:telemetry" :p "display_name" :r "telemetry-name"}\n');
    const expression = `(load-file ${JSON.stringify(cli)}) (println (cheshire.core/generate-string (agent-facts)))`;
    const result = spawnSync("bb", ["-e", expression], {
      encoding: "utf8", cwd: north,
      env: { ...process.env, NORTH_AGENTS_LIB: "1", FRAM_LOG: coordination,
        FRAM_TELEMETRY_LOG: telemetry, FRAM_PORT: "59998", NO_COLOR: "1" },
    });
    expect(result.status).toBe(0);
    const facts = JSON.parse(result.stdout.trim());
    expect(facts.coord.display_name).toBe("coord-name");
    expect(facts.telemetry.display_name).toBe("telemetry-name");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
