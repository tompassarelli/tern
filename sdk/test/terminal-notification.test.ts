import { expect, test } from "bun:test";
import { classifyExecutionTerminal } from "../src/execution-outcome";
import {
  terminalNotificationCommand,
  terminalPublicationBudgetMs,
  TerminalPublicationBudget,
} from "../src/terminal-notification";

test("success completes while a preflight refusal reports an honest blocked terminal", () => {
  for (const [processOutcome, subject] of [
    ["ran", "AGENT COMPLETE"],
    ["blocked_preflight", "AGENT BLOCKED"],
  ]) {
    const terminal = classifyExecutionTerminal(processOutcome);
    const command = terminalNotificationCommand(
      "child",
      "coordinator",
      {
        outcome: processOutcome,
        terminal,
        terminalPublication: "recorded",
        runPublication: "recorded",
      },
    );
    expect(command?.args.slice(2)).toEqual([
      "send",
      "child",
      "coordinator",
      subject,
      `process=${processOutcome} — delivery=${terminal.deliveryOutcome} — terminal=recorded — run=recorded`,
    ]);
  }
});

test("death, stall, and turn-cap terminals retain one dedicated post-publication subject", () => {
  for (const [outcome, subject] of [
    ["died", "AGENT DEATH"],
    ["stalled", "AGENT DEATH"],
    ["max_turns", "TURN CAP"],
    ["capped", "TURN CAP"],
  ]) {
    const terminal = classifyExecutionTerminal(outcome);
    const command = terminalNotificationCommand(
      "child",
      "coordinator",
      {
        outcome,
        terminal,
        terminalPublication: "recorded",
        runPublication: "recorded",
        detail: " bounded\n detail ",
      },
    );
    expect(command?.args.at(-2)).toBe(subject);
    expect(command?.args.at(-1)).toBe(
      `bounded detail — process=${outcome} — delivery=${terminal.deliveryOutcome} — terminal=recorded — run=recorded`,
    );
  }
});

test("missing coordinators stay message-free and degraded publication is explicit", () => {
  const terminal = classifyExecutionTerminal("provider_error");
  expect(terminalNotificationCommand(
    "child",
    undefined,
    {
      outcome: "provider_error",
      terminal,
      terminalPublication: "recorded",
      runPublication: "recorded",
    },
  )).toBeUndefined();
  expect(terminalNotificationCommand(
    "child",
    "coordinator",
    {
      outcome: "provider_error",
      terminal,
      terminalPublication: "unavailable",
      runPublication: "unavailable",
    },
  )?.args.at(-1)).toEndWith("terminal=unavailable — run=unavailable");
});

test("one configurable wall-clock budget is split across both publications and the wake", () => {
  let now = 0;
  const budget = new TerminalPublicationBudget(1_000, () => now);
  expect(budget.publicationTimeout(2)).toBe(400);
  now = 400;
  expect(budget.publicationTimeout(1)).toBe(400);
  now = 800;
  expect(budget.notificationTimeout()).toBe(200);
  now = 1_500;
  expect(budget.notificationTimeout()).toBe(1);

  expect(terminalPublicationBudgetMs("50")).toBe(100);
  expect(terminalPublicationBudgetMs("90000")).toBe(60_000);
  expect(terminalPublicationBudgetMs("not-a-timeout")).toBe(10_000);
});
