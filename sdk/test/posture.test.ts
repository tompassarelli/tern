import { expect, test } from "bun:test";
import type { Fact } from "../src/north-client";
import {
  buildPrompt, deriveManagedDispatchPosture,
} from "../src/posture";

const acceptedLeaf: Fact[] = [
  { predicate: "title", value: "Evaluate the managed child" },
  { predicate: "committed", value: "true" },
  { predicate: "part_of", value: "@aggregate" },
  { predicate: "judgment_grade", value: "s" },
  { predicate: "done_when", value: "focused test exits 0" },
];

test("an economy/low evaluate worker executes an accepted leaf without legacy shape facts", () => {
  const route = {
    topology: "worker" as const,
    posture: "evaluate" as const,
    tier: "economy" as const,
    reasoning: "low" as const,
  };
  const posture = deriveManagedDispatchPosture(acceptedLeaf, false, route.topology);
  const prompt = buildPrompt("child-a", posture, acceptedLeaf);

  expect(route.posture).toBe("evaluate");
  expect(posture).toMatchObject({ planned: true, atomic: true, committed: true });
  expect(prompt).toContain("Execute it directly");
  expect(prompt).not.toContain("Plan only");
});

test("routing topology does not turn an orchestrator lifecycle into a worker leaf", () => {
  const posture = deriveManagedDispatchPosture(acceptedLeaf, false, "orchestrator");
  expect(posture).toMatchObject({ planned: false, atomic: false, committed: true });
});

test("managed workers reject composite threads before execution", () => {
  expect(() => deriveManagedDispatchPosture(acceptedLeaf, true, "worker"))
    .toThrow("managed worker dispatch requires a leaf thread without children");
});

test("delivery instructions use managed MCP tools instead of ambient North CLI", () => {
  const barred = buildPrompt(
    "child-a", deriveManagedDispatchPosture(acceptedLeaf, false, "worker"), acceptedLeaf,
  );
  expect(barred).toContain("mcp__north__evidence_record");
  expect(barred).not.toContain("north evidence record");

  const withoutBar = acceptedLeaf.filter(({ predicate }) => predicate !== "done_when");
  const unbarred = buildPrompt(
    "child-a", deriveManagedDispatchPosture(withoutBar, false, "worker"), withoutBar,
  );
  expect(unbarred).toContain("mcp__north__tell");
  expect(unbarred).not.toContain("`tell child-a");
});
