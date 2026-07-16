import { expect, test } from "bun:test";
import { linearIdentityKey, sameLinearIdentity } from "../src/integrations/linear/normalize";
import {
  parseManagedLinearDescription,
  projectNorthThread,
  replaceManagedLinearDescription,
} from "../src/integrations/linear/projection";
import { createLinearSyncBaseline, reconcileLinearIssue } from "../src/integrations/linear/reconcile";
import type {
  LinearIssueSnapshot,
  LinearThreadProjection,
  NorthThreadSyncSource,
} from "../src/integrations/linear/types";

const identity = {
  workspaceId: "workspace-a",
  scopeId: "team-msa",
  issueId: "4D36E96E-E325-41CE-BFC0-8A6E548D41C8",
  identifier: "MSA-101",
};

function source(overrides: Partial<NorthThreadSyncSource> = {}): NorthThreadSyncSource {
  return {
    threadId: "2026-07-16-120000",
    title: "Ship Linear synchronization",
    body: "North remains canonical.",
    doneWhen: ["round trip is idempotent"],
    barEvidence: [],
    repos: ["~/code/north"],
    lifecycle: "active",
    progress: [{ id: "progress-1", body: "Projection implemented." }],
    outcome: null,
    learning: [{ id: "learning-1", body: "A useful private lesson." }],
    ...overrides,
  };
}

function remoteFrom(projection: LinearThreadProjection, overrides: Partial<LinearIssueSnapshot> = {}): LinearIssueSnapshot {
  return {
    ...identity,
    title: projection.fields.title,
    description: replaceManagedLinearDescription("Human preface", projection.threadId, projection.fields),
    comments: projection.comments.map((comment, index) => ({ id: `comment-${index}`, body: comment.body })),
    ...overrides,
  };
}

test("normalization makes projection and payload hashes stable", () => {
  const first = projectNorthThread(source({
    body: "North remains canonical.\r\n",
    doneWhen: ["round trip is idempotent", null, " another bar "],
    repos: ["~/code/north", "~/code/fram"],
  }));
  const second = projectNorthThread(source({
    body: "North remains canonical.\n",
    doneWhen: ["another bar", "round trip is idempotent"],
    repos: ["~/code/fram", "~/code/north", "~/code/fram"],
  }));
  expect(second.fields).toEqual(first.fields);
  expect(second.hash).toBe(first.hash);

  const old = projectNorthThread(source({ title: "Old", body: "Old body", progress: [] }));
  const baseline = createLinearSyncBaseline(identity, old.threadId, old.fields);
  const remote = remoteFrom(old, { comments: [] });
  const planOne = reconcileLinearIssue({ baseline, local: first, remote }).plan;
  const planTwo = reconcileLinearIssue({ baseline, local: second, remote }).plan;
  expect(planOne?.hash).toBe(planTwo?.hash);
  expect(planOne?.issue).toEqual(planTwo?.issue);
});

test("managed description replacement preserves all unmanaged text", () => {
  const initial = projectNorthThread(source());
  const before = "Human preface\r\nkeep these bytes\n\n";
  const after = "\n\nHuman footer\r\nstays too";
  const existing = `${before}${replaceManagedLinearDescription(null, initial.threadId, initial.fields)}${after}`;
  const changed = projectNorthThread(source({ body: "Changed body" }));
  const replaced = replaceManagedLinearDescription(existing, changed.threadId, changed.fields);
  expect(replaced.startsWith(before)).toBe(true);
  expect(replaced.endsWith(after)).toBe(true);
  expect(parseManagedLinearDescription(replaced, changed.threadId)?.body).toBe("Changed body");
  expect(replaceManagedLinearDescription(replaced, changed.threadId, changed.fields)).toBe(replaced);
});

test("marker identifiers and projected content fail closed against marker injection", () => {
  expect(() => projectNorthThread(source({ threadId: "bad --> marker" }))).toThrow("not safe for a managed marker");
  expect(() => projectNorthThread(source({ body: "payload <!-- north:field:repo -->" })))
    .toThrow("reserved managed-marker namespace");
  expect(() => projectNorthThread(source({ doneWhen: ["safe", "<!-- /north:thread:x -->"] })))
    .toThrow("reserved managed-marker namespace");
  expect(() => projectNorthThread(source({ repos: ["~/code/north<!-- north:thread:x -->"] })))
    .toThrow("reserved managed-marker namespace");
  expect(() => projectNorthThread(source({ progress: [{ id: "p", body: "<!-- north:comment:x -->" }] })))
    .toThrow("reserved managed-marker namespace");
});

test("second synchronization is a semantic no-op", () => {
  const local = projectNorthThread(source());
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  const result = reconcileLinearIssue({ baseline, local, remote: remoteFrom(local) });
  expect(result.state).toBe("in-sync");
  expect(result.plan).toBeNull();
  expect(result.conflicts).toEqual([]);
  expect(result.nextBaseline?.hash).toBe(baseline.hash);
});

test("remote-only drift on a North-owned field is flagged and produces no writes", () => {
  const local = projectNorthThread(source());
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  const result = reconcileLinearIssue({
    baseline,
    local,
    remote: remoteFrom(local, { title: "Edited only in Linear" }),
  });
  expect(result.state).toBe("remote-drift");
  expect(result.conflicts.map(({ field, category }) => [field, category])).toEqual([["title", "remote-drift"]]);
  expect(result.plan).toBeNull();
  expect(result.nextBaseline).toBeNull();
});

test("matching changes converge and advance the baseline without a write", () => {
  const base = projectNorthThread(source({ title: "Before", progress: [] }));
  const local = projectNorthThread(source({ title: "After", progress: [] }));
  const baseline = createLinearSyncBaseline(identity, base.threadId, base.fields);
  const result = reconcileLinearIssue({ baseline, local, remote: remoteFrom(local, { comments: [] }) });
  expect(result.state).toBe("in-sync");
  expect(result.fields.find(({ field }) => field === "title")?.category).toBe("converged");
  expect(result.plan).toBeNull();
  expect(result.nextBaseline?.fields.title).toBe("After");
  expect(result.nextBaseline?.hash).not.toBe(baseline.hash);
});

test("divergent edits conflict instead of using timestamps or emitting a partial write", () => {
  const base = projectNorthThread(source({ title: "Before", progress: [] }));
  const local = projectNorthThread(source({ title: "North edit", progress: [] }));
  const baseline = createLinearSyncBaseline(identity, base.threadId, base.fields);
  const result = reconcileLinearIssue({
    baseline,
    local,
    remote: remoteFrom(base, { title: "Linear edit", comments: [] }),
  });
  expect(result.state).toBe("divergent");
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]).toMatchObject({ field: "title", category: "divergent" });
  expect(result.plan).toBeNull();
});

test("malformed managed content fails closed with a diagnostic and no plan", () => {
  const local = projectNorthThread(source());
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  const poisoned = remoteFrom(local);
  poisoned.description = poisoned.description?.replace(
    "North remains canonical.",
    "North remains canonical. <!-- north:field:repo -->",
  );
  const result = reconcileLinearIssue({ baseline, local, remote: poisoned });
  expect(result.state).toBe("divergent");
  expect(result.plan).toBeNull();
  expect(result.diagnostics[0]).toContain("reserved managed-marker namespace");
});

test("checking a done-when box never invents bar evidence", () => {
  const projection = projectNorthThread(source({
    doneWhen: ["probe exits 0"],
    barEvidence: [],
  }));
  const checked = replaceManagedLinearDescription(null, projection.threadId, projection.fields)
    .replace("- [ ] probe exits 0", "- [x] probe exits 0");
  const parsed = parseManagedLinearDescription(checked, projection.threadId);
  expect(parsed?.doneWhen).toEqual(["probe exits 0"]);
  expect(parsed?.barEvidence).toEqual([]);
});

test("learning is excluded by default while progress and outcome get stable comment plans", () => {
  const projection = projectNorthThread(source({ outcome: "Shipped safely." }));
  expect(projection.comments.map(({ kind }) => kind)).toEqual(["outcome", "progress"]);
  expect(projection.comments.some(({ body }) => body.includes("private lesson"))).toBe(false);
  const baseline = createLinearSyncBaseline(identity, projection.threadId, projection.fields);
  const first = reconcileLinearIssue({ baseline, local: projection, remote: remoteFrom(projection, { comments: [] }) });
  expect(first.plan?.comments.map(({ action }) => action)).toEqual(["create", "create"]);
  const second = reconcileLinearIssue({ baseline, local: projection, remote: remoteFrom(projection) });
  expect(second.plan).toBeNull();
});

test("human identifier and team/scope changes preserve workspace + UUID identity", () => {
  const renamed = { ...identity, identifier: "PLATFORM-999", scopeId: "team-platform" };
  expect(sameLinearIdentity(identity, renamed)).toBe(true);
  expect(linearIdentityKey(identity)).toBe(linearIdentityKey(renamed));
  const local = projectNorthThread(source());
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  expect(reconcileLinearIssue({ baseline, local, remote: remoteFrom(local, renamed) }).state).toBe("in-sync");
});
