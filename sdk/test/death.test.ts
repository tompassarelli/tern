// Pure tests for the death-notification contract — no side effects, no live coordinator.
// deathCommands() is the single source of "what a death emits"; asserting its shape here
// locks the contract (agent_death claim on @swarm + thread; peer ping to the coordinator).
import { test, expect, describe } from "bun:test";
import { deathReason, deathCommands } from "../src/death";

describe("deathReason", () => {
  test("Error -> its message", () => {
    expect(deathReason(new Error("Claude Code process terminated by signal 9"))).toBe(
      "Claude Code process terminated by signal 9",
    );
  });
  test("string passthrough", () => {
    expect(deathReason("Transport is closed")).toBe("Transport is closed");
  });
  test("collapses whitespace and bounds length", () => {
    const r = deathReason(new Error("a\n\n  b\t c".padEnd(500, "x")));
    expect(r).not.toContain("\n");
    expect(r.length).toBeLessThanOrEqual(300);
  });
  test("nullish -> 'unknown'", () => {
    expect(deathReason(undefined)).toBe("unknown");
    expect(deathReason(null)).toBe("unknown");
  });
});

describe("deathCommands", () => {
  const TS = "2026-07-04T00:00:00.000Z";

  test("bare: one claim on @swarm, carrying agent | reason | ts", () => {
    const cmds = deathCommands("W3", "exited with code 1", {}, TS);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args).toEqual(["tell", "@swarm", "agent_death", "W3 | exited with code 1 | " + TS]);
  });

  test("with thread: a second identical claim on the driven thread", () => {
    const cmds = deathCommands("P1", "signal 9", { thread: "019f2800" }, TS);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].args[1]).toBe("@swarm"); // @swarm first (roster), thread second
    expect(cmds[1].args).toEqual(["tell", "019f2800", "agent_death", "P1 | signal 9 | " + TS]);
  });

  test("with coordinator: adds an msg-cli peer ping", () => {
    const cmds = deathCommands("P2", "Transport is closed", { coordinator: "fram-1" }, TS);
    expect(cmds).toHaveLength(2);
    const ping = cmds[1];
    expect(ping.cmd).toBe("bb");
    expect(ping.args).toContain("send");
    expect(ping.args).toContain("P2"); // from
    expect(ping.args).toContain("fram-1"); // to
    expect(ping.args).toContain("AGENT DEATH"); // subject
  });

  test("full context: @swarm claim, thread claim, then coordinator ping — in order", () => {
    const cmds = deathCommands("P5", "signal 15", { thread: "T", coordinator: "coord" }, TS);
    expect(cmds).toHaveLength(3);
    expect(cmds[0].args[1]).toBe("@swarm");
    expect(cmds[1].args[1]).toBe("T");
    expect(cmds[2].cmd).toBe("bb");
    expect(cmds[2].args[0]).toContain("msg-cli"); // the peer ping is last
  });
});
