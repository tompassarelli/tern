import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { renderCavemanSkill, resolveManagedCaveman } from "../src/caveman";

const HOME = "/home/tom/code/caveman";
const REV = "020f650daa42a506660a2959f62f2a999d7e1018";

function skill(): string {
  return execFileSync("git", ["-C", HOME, "show", `${REV}:skills/caveman/SKILL.md`], {
    encoding: "utf8",
  });
}

function forkHookRender(content: string, mode: "lite" | "full"): string {
  const body = content.replace(/^---[\s\S]*?---\s*/, "");
  const filtered = body.split("\n").reduce<string[]>((acc, line) => {
    const table = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (table) { if (table[1] === mode) acc.push(line); return acc; }
    const example = line.match(/^- (\S+?):\s/);
    if (example) { if (example[1] === mode) acc.push(line); return acc; }
    acc.push(line);
    return acc;
  }, []);
  return `CAVEMAN MODE ACTIVE — level: ${mode}\n\n${filtered.join("\n")}`;
}

test("lite and full render byte-for-byte like Tom's subagent hook", () => {
  const artifact = skill();
  for (const mode of ["lite", "full"] as const) {
    expect(renderCavemanSkill(artifact, mode)).toBe(forkHookRender(artifact, mode));
  }
  const lite = renderCavemanSkill(artifact, "lite");
  expect(lite).toContain("| **lite** |");
  expect(lite).not.toContain("| **full** |");
  expect(lite).toContain("- lite:");
  expect(lite).not.toContain("- full:");
});

test("managed resolution proves exact fork provenance and precedence", () => {
  const base = { NORTH_CAVEMAN_HOME: HOME, NORTH_CAVEMAN_REV: REV };
  const requested = resolveManagedCaveman("full", { ...base, AGENT_CAVEMAN: "off" });
  expect(requested.source).toBe("request");
  expect(requested.resolvedMode).toBe("full");
  expect(requested.implementation).toBe("fork-skill");
  expect(requested.repository).toBe("github.com/tompassarelli/caveman");
  expect(requested.revision).toBe(REV);
  expect(requested.skillSha256).toBe("e38ec671ecbee47ce234190be12615daf60ac667d775b7340d49d07f4f63c7bc");
  expect(requested.instructions).not.toContain("name: caveman");
  expect(requested.measurementCoverage).toBe("exact");
  expect(resolveManagedCaveman(undefined, { ...base, AGENT_CAVEMAN: "full" }).source).toBe("env");
  const defaulted = resolveManagedCaveman(undefined, base);
  expect(defaulted.source).toBe("default");
  expect(defaulted.resolvedMode).toBe("off");
  expect(defaulted.decisionReason).toBe("default-off-unproven-savings");
});

test("off injects nothing and does not require a fork checkout", () => {
  const off = resolveManagedCaveman("off", {
    NORTH_CAVEMAN_HOME: "/definitely/missing", NORTH_CAVEMAN_REV: "bad",
  });
  expect(off).toMatchObject({
    requestedMode: "off", resolvedMode: "off", implementation: "disabled", instructions: "",
  });
});

test("enabled modes fail closed for incomplete, missing, or wrong immutable provenance", () => {
  expect(() => resolveManagedCaveman("lite", { NORTH_CAVEMAN_HOME: HOME }))
    .toThrow("NORTH_CAVEMAN_HOME and NORTH_CAVEMAN_REV together");
  expect(() => resolveManagedCaveman("lite", {
    NORTH_CAVEMAN_HOME: "/definitely/missing", NORTH_CAVEMAN_REV: REV,
  })).toThrow("provenance unavailable");
  expect(() => resolveManagedCaveman("full", {
    NORTH_CAVEMAN_HOME: HOME, NORTH_CAVEMAN_REV: `${REV.slice(0, -1)}0`,
  })).toThrow();
});

test("adapted fork behavior retains the upstream MIT notice", () => {
  const notice = readFileSync(resolve(import.meta.dir, "../..", "THIRD_PARTY_NOTICES.md"), "utf8");
  expect(notice).toContain("https://github.com/tompassarelli/caveman");
  expect(notice).toContain("MIT License");
  expect(notice).toContain("Copyright (c) 2026 Julius Brussee");
  expect(notice).toContain("src/hooks/caveman-subagent.js");
});
