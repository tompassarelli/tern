// Suite-wide hermeticity boundary (loaded via bunfig.toml [test] preload,
// before any test module is imported).
//
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
//
// When the suite runs inside a live managed north lane, the ambient
// NORTH_PORT points at the REAL coordinator on the session's port. Admission
// (requireCoordinator) and presence probes read NORTH_PORT, so a test that
// builds harnessOptions without first pinning its own fake coordinator would
// silently target the live coordinator. Because process.env is shared across
// test files and every coordinator-bearing suite snapshots+restores NORTH_PORT
// at module load, that live value leaks and races between files — surfacing as
// nondeterministic `north_coordinator_preflight_invalid_response` failures.
//
// Pin NORTH_PORT to a closed sentinel BEFORE any module snapshot, so every
// save/restore cycle carries the dead port, never the live coordinator. Suites
// that need a coordinator still stand up their own server and set NORTH_PORT to
// it in beforeAll/beforeEach; suites that assert a dead coordinator get exactly
// that. This is the "live coordinator = env hermeticity" contract in practice.
//
// A closed high port (nothing listens here) — connect() yields ECONNREFUSED,
// which admission treats as an unavailable coordinator, the honest default for
// a hermetic unit test.
const HERMETIC_DEAD_PORT = "59319";

if (process.env.NORTH_TEST_ALLOW_AMBIENT_COORDINATOR !== "1") {
  process.env.NORTH_PORT = HERMETIC_DEAD_PORT;
}

// Global-authority hermeticity. The laws bootstrap now resolves an exact
// AGENT_LAWS_PATH or ~/.agents/AGENTS.md — never a provider config home. So a
// bare suite run (no ambient AGENT_LAWS_PATH, no ~/.agents on the box) would
// fail every AGENT_LAWS=on assembly, and the tiered assembler (prompt-assembly)
// needs a real, section-structured constitution to gate. Pin the override to a
// self-contained SYNTHETIC constitution written to this process's temp dir when
// unset: it carries the exact section headings the tier gates key on, with no
// personal prose and no provider-home dependency. A per-pid path keeps parallel
// isolate runs from racing. Tests that exercise default resolution or the
// unavailable path delete or override AGENT_LAWS_PATH explicitly.
//
// NOTE: the repo's own root AGENTS.md is deliberately NOT used here — it is the
// North project doc, so it (a) lacks the constitution's gated sections and
// (b) is itself composed into the root-to-cwd project-instruction block, which
// would double-inject the same text and trip the exact-once bootstrap guard.
const SYNTHETIC_GLOBAL_AGENTS = `# Synthetic global constitution — SDK test fixture

Constitution, not manual: this is a hermetic, self-contained stand-in for the
provider-neutral global AGENTS.md. It exists only so laws assembly in the SDK
suite never reaches a provider config home, and carries the section structure
the tiered assembler gates on — no personal content.

## Blocked ≠ stopped

A denial is information about the path, not the goal. Find the nearest
compliant move that still advances; never retry a blocked action verbatim.

## Paths — full and \`~\`-anchored, always

Every path written is full from \`~\`, never bare-relative, so the reader never
has to intuit a working directory before acting on it.

## Done-claims carry a bar — probe + observed result

A done-claim cites the probe run and the observed result it produced, never the
bare adjective; each worker reports its own evidence against its own bars.

Evidence attaches where the done-claim lives: the coordinator that owns a
reduction reconciles and attests the aggregate, echoing every worker bar with
the exact observed result it saw, so the whole chain stays independently
checkable end to end rather than resting on any single lane's say-so.

## Standing guards

- Banned vocabulary: dead pre-rename naming must never leak back into output;
  prefer the current terms. Ordinary English usage of the words is fine.
- Never serialize work to protect the box — measure load instead; agent work is
  network-bound, so isolation is a measured decision, never a reflex.
- \`rm\` on variable paths — make it self-evidently safe so the guard never has to
  prompt: brace-guard every interpolated path segment or delete a literal dir.

## Pre-edit gate — MANDATORY

Before any first side effect a lane satisfies its pre-edit gate: it names the
exact authoritative artifact it read, confirms the coordination declaration is
in place, and states the probe that will demonstrate the change. The gate is a
coordinator-side discipline — orchestrating lanes carry it because they own the
reduction that a bare worker never sees, and skipping it silently converts an
unverified edit into an unearned done-claim that the aggregate cannot defend.

## Model + payload routing

Model selection and payload routing resolve from the sealed routing policy: the
semantic tier maps to a concrete model only through the admitted route, and the
orchestrating lane revalidates that seal before it publishes work to a peer.
This block rides only with coordination authority because a terminal worker
neither selects models nor routes payloads for anyone else; it simply executes
the exact route it was handed and reports the observed result upward.

## Push freely — the scan is the guard

Commit at coherent checkpoints, then push through the scan; stop only for a
flagged secret or a rewrite of already-published history.

## External code — license first

Before leveraging any code you did not write, run the license protocol and flag
copyleft or unlicensed sources before building on them.

## Internal notes → docs/private, never public docs

Agent notes, status, scratch, and handoffs go in the gitignored private docs
tree; public docs stay end-user-facing only.

## New code — minimize glue

Ladder down for incidental glue and stop at the first sufficient rung; hand-roll
the core deliberately. Correctness and security are never laddered away.

## Billable clock — clock or it didn't happen

Billable edit volume rides a live clock; a proven nonbillable envelope is the
only exemption from clocking in first.

## Global agent config goes through nixos-config

Global agent configuration is owned by the dotfiles repo and never edited from
inside a provider config home.

## Racket / Beagle first for general-purpose programs

New general-purpose tools default to the graph-native language stack; every
escape hatch is stated in one line when it is taken.
`;

if (!process.env.AGENT_LAWS_PATH) {
  const fixture = join(tmpdir(), `north-sdk-global-agents-${process.pid}.md`);
  writeFileSync(fixture, SYNTHETIC_GLOBAL_AGENTS);
  process.env.AGENT_LAWS_PATH = fixture;
}
