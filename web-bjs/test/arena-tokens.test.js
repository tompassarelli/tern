import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { get as beagleGet } from "../node_modules/beagle/core.js";
import { totals } from "../out/north/arena.js";
import {
  agent_tokens,
  parseFloatSafe,
  run_context,
  run_ended,
  run_tot,
  runUsageTriplesFromLogs,
} from "../out/north/fram.js";
import { swarm_tokens, usage_display, usage_projection } from "../out/north/presence.js";
import { wake_presence_row } from "../out/north/server.js";

const activeArenaUi = readFileSync(
  new URL("../../web/priv/static/js/north-arena.js", import.meta.url),
  "utf8",
);
const activeAgentsUi = readFileSync(
  new URL("../../web/priv/static/js/north-agents.js", import.meta.url),
  "utf8",
);
const generatedWakeUi = readFileSync(
  new URL("../../web/priv/static/js/north-ui.js", import.meta.url),
  "utf8",
);

describe("active web usage reporting", () => {
  test("arena totals preserve exact integer token counts and coverage", () => {
    expect(
      totals([
        { state: "green", tokens: 1234, wall_s: 8 },
        { state: "running", tokens: "56", wall_s: "13" },
      ]),
    ).toEqual({
      green: 1,
      total: 2,
      tokens: 1290,
      tokens_status: "exact",
      unknown_usage: 0,
      elapsed_s: 13,
    });
  });

  test("historical cost-only rows stay unknown, never zero or a guessed price", () => {
    expect(totals([{ state: "green", cost_usd: "99.99", wall_s: "4" }])).toEqual({
      green: 1,
      total: 1,
      tokens: null,
      tokens_status: "unknown",
      unknown_usage: 1,
      elapsed_s: 4,
    });
  });

  test("mixed arena coverage reports the exact known lower bound as incomplete", () => {
    expect(
      totals([
        { state: "green", tokens: 1234, tokens_status: "exact", wall_s: 8 },
        { state: "running", tokens: null, tokens_status: "unknown", wall_s: 13 },
      ]),
    ).toMatchObject({ tokens: 1234, tokens_status: "incomplete", unknown_usage: 1 });
  });

  test("absent usage stays unknown through presence and Wake projection", () => {
    expect(usage_projection({})).toEqual({
      context: null,
      context_status: "unknown",
      total: null,
      total_status: "unknown",
      context_display: "unknown",
      total_display: "unknown",
    });
    expect(usage_display(1234, "incomplete")).toBe(">=1234 (incomplete)");

    expect(
      wake_presence_row({
        uuid: "worker-1",
        roles_str: "implementer",
        model_str: "model",
        online: true,
        current_thread: null,
        active_workflow: null,
        ctx_str: "unknown",
        total_str: ">=1234 (incomplete)",
      }),
    ).toMatchObject({ context_tokens: "unknown", total_tokens: ">=1234 (incomplete)" });
  });

  test("swarm projection preserves known lower bounds without claiming an exact total", () => {
    expect(
      swarm_tokens([
        {
          context_tokens: 100,
          context_status: "exact",
          total_tokens: 1234,
          total_status: "exact",
        },
        {
          context_tokens: null,
          context_status: "unknown",
          total_tokens: null,
          total_status: "unknown",
        },
      ]),
    ).toMatchObject({
      context: ">=100 (incomplete)",
      total: ">=1234 (incomplete)",
      context_status: "incomplete",
      total_status: "incomplete",
    });
  });

  test("active UI contracts render explicit unknown and incomplete coverage", () => {
    expect(activeArenaUi).toContain('"TOKENS"');
    expect(activeArenaUi).toContain("fmtUsage(t.tokens, t.tokens_status)");
    expect(activeArenaUi).toContain("(incomplete)");
    expect(activeArenaUi).toContain('return "unknown"');
    expect(activeArenaUi).not.toContain("cost_usd");
    expect(activeArenaUi).not.toContain("fmtMoney");
    expect(activeAgentsUi).toContain("fmtUsage(a.total_tokens, a.total_status)");
    expect(activeAgentsUi).toContain("(incomplete)");
    expect(activeAgentsUi).toContain('return "unknown"');
    expect(activeAgentsUi).not.toContain("toFixed(1)");
    expect(activeAgentsUi).toContain("function semanticName(a)");
    expect(activeAgentsUi).toContain("a.display_name || a.display_handle");
    expect(activeAgentsUi).toContain("a.provider_label || a.provider");
    expect(activeAgentsUi).toContain('a.gaffer_provenance || "gaffer:legacy-debt"');
    expect(activeAgentsUi).toContain("a.state_label || a.state");
    expect(activeAgentsUi).toContain('a.lifecycle || "unrecorded"');
    expect(activeAgentsUi).toContain("control ${a.control_id || handle}");
    expect(activeAgentsUi).not.toContain("gaffer:none");
    expect(generatedWakeUi).toContain("props.context_tokens || ''");
    expect(generatedWakeUi).toContain("props.total_tokens || ''");
    expect(generatedWakeUi).toContain("props.display_name || ''");
    expect(generatedWakeUi).toContain("props.provider_label || ''");
    expect(generatedWakeUi).toContain("props.gaffer_provenance || ''");
    expect(generatedWakeUi).toContain("props.state_label || ''");
    expect(generatedWakeUi).toContain("props.lifecycle || ''");
    expect(generatedWakeUi).toContain("props.control_id || ''");
    expect(generatedWakeUi.indexOf("props.display_name || ''"))
      .toBeLessThan(generatedWakeUi.indexOf("props.uuid || ''"));
    expect(generatedWakeUi).not.toContain("gaffer:none");
    expect(generatedWakeUi).not.toContain("cost_usd");
  });

  test("the remaining thread parser float helper survives regeneration", () => {
    expect(parseFloatSafe("4.25")).toBe(4.25);
    expect(parseFloatSafe("not-a-number")).toBe(0);
  });

  test("only authoritative aggregates and complete historical components become totals", () => {
    expect(run_tot({ tokens: "1234", input_tokens: "999" })).toBe(1234);
    expect(run_tot({ tokens: "1234", usage_total_status: "exact" })).toBe(1234);
    expect(run_tot({ tokens: "1234", usage_total_status: "unknown_repeated_terminal" })).toBeNull();
    expect(run_context({ tokens: "1234" })).toBeNull();
    expect(run_context({ tokens: "1234", input_tokens: "999" })).toBe(999);
    expect(run_ended({ at: "2026-07-16T02:00:00Z", ended_at: "2026-07-16T01:00:00Z" })).toBe(
      "2026-07-16T02:00:00Z",
    );
    expect(run_ended({ ended_at: "2026-07-16T01:00:00Z" })).toBe("2026-07-16T01:00:00Z");
    expect(
      run_tot({
        input_tokens: "100",
        output_tokens: "20",
        cache_create_tokens: "3",
        cache_read_tokens: "4",
      }),
    ).toBe(127);
    expect(run_tot({ input_tokens: "100", output_tokens: "20" })).toBeNull();
    expect(
      run_tot({
        input_tokens: "100",
        output_tokens: "20",
        cached_input_tokens: "60",
        reasoning_output_tokens: "7",
        usage_total_status: "unknown_adapter_scope",
      }),
    ).toBeNull();
  });

  test("split append logs join current hyphenated run facts without touching the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "north-web-usage-"));
    const coordination = join(dir, "coordination.log");
    const telemetry = join(dir, "telemetry.log");
    const oldCoordination = process.env.FRAM_LOG;
    const oldTelemetry = process.env.FRAM_TELEMETRY_LOG;

    writeFileSync(
      coordination,
      [
        '{:tx 1, :op "assert", :l "@run-historical", :p "agent", :r "work\\\"er"}',
        '{:tx 2, :op "assert", :l "@run-historical", :p "at", :r "2026-07-16T01:00:00Z"}',
        '{:tx 3, :op "assert", :l "@run-unknown", :p "agent", :r "work\\\"er"}',
        '{:tx 4, :op "assert", :l "@run-unknown", :p "at", :r "2026-07-16T02:00:00Z"}',
        '{:tx 5, :op "assert", :l "@run-retracted", :p "agent", :r "gone"}',
      ].join("\n"),
    );
    writeFileSync(
      telemetry,
      [
        '{:tx 6, :op "assert", :l "@run-historical", :p "tokens", :r "4321"}',
        '{:tx 7, :op "assert", :l "@run-historical", :p "cached_input_tokens", :r "60"}',
        '{:tx 8, :op "assert", :l "@run-historical", :p "reasoning_output_tokens", :r "7"}',
        '{:tx 9, :op "assert", :l "@run-unknown", :p "input_tokens", :r "100"}',
        '{:tx 10, :op "assert", :l "@run-unknown", :p "usage_terminal_count", :r "1"}',
        '{:tx 11, :op "assert", :l "@run-unknown", :p "usage_scope", :r "anthropic_result_terminal"}',
        '{:tx 12, :op "assert", :l "@run-unknown", :p "usage_total_status", :r "unknown_incomplete_terminal"}',
        '{:tx 13, :op "assert", :l "@run-retracted", :p "tokens", :r "55"}',
        '{:tx 14, :op "retract", :l "@run-retracted", :p "tokens", :r "55"}',
      ].join("\n"),
    );

    process.env.FRAM_LOG = coordination;
    process.env.FRAM_TELEMETRY_LOG = telemetry;
    try {
      const triples = await runUsageTriplesFromLogs();
      expect(triples).toContainEqual(["@run-historical", "agent", 'work"er']);
      expect(triples).toContainEqual(["@run-historical", "tokens", "4321"]);
      expect(triples).toContainEqual(["@run-historical", "cached_input_tokens", "60"]);
      expect(triples).toContainEqual(["@run-historical", "reasoning_output_tokens", "7"]);
      expect(triples).toContainEqual(["@run-unknown", "usage_terminal_count", "1"]);
      expect(triples).toContainEqual([
        "@run-unknown",
        "usage_scope",
        "anthropic_result_terminal",
      ]);
      expect(triples).toContainEqual([
        "@run-unknown",
        "usage_total_status",
        "unknown_incomplete_terminal",
      ]);
      expect(triples).not.toContainEqual(["@run-retracted", "tokens", "55"]);

      const usage = beagleGet(await agent_tokens(0), 'work"er');
      expect(usage).toEqual({
        context: 100,
        context_status: "exact",
        total: 4321,
        total_status: "incomplete",
        exact_runs: 1,
        unknown_runs: 1,
        ended: "2026-07-16T02:00:00Z",
      });

      // Same-size rewrite must invalidate the cache via mtime, not stale size.
      writeFileSync(telemetry, readFileSync(telemetry, "utf8").replace("4321", "9876"));
      const future = new Date(Date.now() + 2000);
      utimesSync(telemetry, future, future);
      const rewritten = await runUsageTriplesFromLogs();
      expect(rewritten).toContainEqual(["@run-historical", "tokens", "9876"]);
    } finally {
      if (oldCoordination === undefined) delete process.env.FRAM_LOG;
      else process.env.FRAM_LOG = oldCoordination;
      if (oldTelemetry === undefined) delete process.env.FRAM_TELEMETRY_LOG;
      else process.env.FRAM_TELEMETRY_LOG = oldTelemetry;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
