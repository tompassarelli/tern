import { createHash } from "node:crypto";

export interface TerminalFact {
  predicate: string;
  value: string;
}

const TERMINAL_PREDICATES = [
  "outcome",
  "process_outcome",
  "delivery_outcome",
  "delivery_reason",
] as const;

const valuesOf = (facts: readonly TerminalFact[], predicate: string): string[] =>
  facts.filter((fact) => fact.predicate === predicate).map((fact) => fact.value);

const singletonValue = (
  facts: readonly TerminalFact[],
  predicate: string,
): string | undefined => {
  const values = valuesOf(facts, predicate);
  return values.length === 1 && values[0]?.trim() ? values[0] : undefined;
};

const factPresent = (facts: readonly TerminalFact[], predicate: string): boolean =>
  valuesOf(facts, predicate).length > 0;

export function terminalManifestSha256(
  facts: readonly TerminalFact[],
): string | undefined {
  const projection = TERMINAL_PREDICATES
    .map((predicate) => [predicate, singletonValue(facts, predicate)] as const);
  if (projection.some(([, value]) => value === undefined)) return undefined;
  const canonical = projection
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([predicate, value]) => `${predicate}\0${value}\n`)
    .join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function terminalProcessOutcome(
  facts: readonly TerminalFact[],
): string | undefined {
  if (factPresent(facts, "process_outcome")) {
    const process = singletonValue(facts, "process_outcome");
    const legacyAlias = singletonValue(facts, "outcome");
    const marker = singletonValue(facts, "terminal_manifest_sha256");
    const expected = terminalManifestSha256(facts);
    return process && process === legacyAlias && marker === expected
      ? process.trim()
      : undefined;
  }
  return singletonValue(facts, "outcome")?.trim();
}

export function committedRunProcessOutcome(
  facts: readonly TerminalFact[],
): string | undefined {
  if (singletonValue(facts, "kind") !== "run") return undefined;
  return factPresent(facts, "process_outcome")
    ? singletonValue(facts, "process_outcome")?.trim()
    : singletonValue(facts, "outcome")?.trim();
}

export function laneResolvedByFacts(
  laneFacts: readonly TerminalFact[],
  taggedRuns: readonly (readonly TerminalFact[])[],
): boolean {
  return Boolean(
    terminalProcessOutcome(laneFacts)
    || taggedRuns.some((facts) => committedRunProcessOutcome(facts)),
  );
}
