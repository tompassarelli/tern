import { expect, test } from "bun:test";
import { makeStruggleState, updateStruggle } from "../src/struggle";

test("only successful managed evidence publication counts as struggle progress", () => {
  const successful = makeStruggleState();
  updateStruggle({
    type: "assistant",
    message: { content: [{
      type: "tool_use",
      id: "evidence-success",
      name: "mcp__north__evidence_record",
      input: { bar: "tests pass", observed: "exit 0" },
    }] },
  }, successful);
  updateStruggle({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "evidence-success",
      is_error: false,
    }] },
  }, successful);
  expect(successful.lastProgressTurn).toBe(1);

  const failed = makeStruggleState();
  updateStruggle({
    type: "assistant",
    message: { content: [{
      type: "tool_use",
      id: "evidence-failure",
      name: "mcp__north__evidence_record",
      input: { bar: "tests pass", observed: "exit 0" },
    }] },
  }, failed);
  updateStruggle({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "evidence-failure",
      is_error: true,
    }] },
  }, failed);
  expect(failed.lastProgressTurn).toBe(0);
});
