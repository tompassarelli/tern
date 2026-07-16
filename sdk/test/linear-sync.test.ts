import { expect, test } from "bun:test";
import {
  linearIdentityKey, sameLinearIdentity, sha256Canonical, sha256Text,
} from "../src/integrations/linear/normalize";
import {
  parseManagedLinearDescription,
  projectNorthThread,
  replaceManagedLinearDescription,
} from "../src/integrations/linear/projection";
import {
  createLinearSyncBaseline, reconcileLinearIssue, validateLinearSyncBaseline,
} from "../src/integrations/linear/reconcile";
import type {
  LinearIssueSnapshot,
  LinearThreadProjection,
  NorthThreadSyncSource,
} from "../src/integrations/linear/types";

const identity = {
  identityKind: "linear-uuid" as const,
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

type LinearUuidSnapshot = Extract<LinearIssueSnapshot, { identityKind: "linear-uuid" }>;

function remoteFrom(projection: LinearThreadProjection, overrides: Partial<LinearUuidSnapshot> = {}): LinearIssueSnapshot {
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

test("serialized baselines contain only identity and normalized per-field hashes", () => {
  const projection = projectNorthThread(source({
    title: "Sensitive title", body: "Sensitive body", doneWhen: ["private criterion"], progress: [],
  }));
  const baseline = createLinearSyncBaseline(identity, projection.threadId, projection.fields);
  expect(Object.keys(baseline.fieldHashes).sort()).toEqual([
    "barEvidence", "body", "doneWhen", "lifecycle", "repos", "title",
  ]);
  expect(baseline.fieldHashes.title).toBe(sha256Canonical("Sensitive title"));
  const serialized = JSON.stringify(baseline);
  expect(serialized).not.toContain("Sensitive title");
  expect(serialized).not.toContain("Sensitive body");
  expect(serialized).not.toContain("private criterion");
  expect(serialized).not.toContain('"fields"');
});

test("missing or tampered baseline field hashes fail before reconciliation", () => {
  const local = projectNorthThread(source({ progress: [] }));
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  const remote = remoteFrom(local, { comments: [] });
  const missing = JSON.parse(JSON.stringify(baseline));
  delete missing.fieldHashes.body;
  expect(() => reconcileLinearIssue({ baseline: missing, local, remote }))
    .toThrow("baseline body hash is invalid");
  const tampered = { ...baseline, fieldHashes: { ...baseline.fieldHashes, title: "0".repeat(64) } };
  expect(() => reconcileLinearIssue({ baseline: tampered, local, remote }))
    .toThrow("baseline hash does not match its contents");
});

test("baseline integrity validator round-trips valid state and rejects tampering directly", () => {
  const local = projectNorthThread(source({ progress: [] }));
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  expect(validateLinearSyncBaseline(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
  expect(() => validateLinearSyncBaseline({
    ...baseline,
    fieldHashes: { ...baseline.fieldHashes, body: "f".repeat(64) },
  })).toThrow("baseline hash does not match its contents");
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
  expect(result.nextBaseline?.fieldHashes.title).toBe(sha256Canonical("After"));
  expect(result.nextBaseline?.hash).not.toBe(baseline.hash);
});

test("unchanged imported raw description adopts into exactly one managed block", () => {
  const raw = "Imported body\r\nsecond line";
  const local = projectNorthThread(source({ body: raw, progress: [], doneWhen: [] }));
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  const result = reconcileLinearIssue({
    baseline,
    local,
    remote: { ...identity, title: local.fields.title, description: raw, comments: [] },
    bootstrap: { importedRawDescriptionHash: sha256Text(raw) },
  });
  expect(result.state).toBe("local-ahead");
  expect(result.conflicts).toEqual([]);
  expect(result.plan?.issue.description).toBeDefined();
  expect(result.plan?.issue.description?.match(/<!-- north:thread:/g)).toHaveLength(1);
  expect(result.plan?.issue.description?.match(/Imported body/g)).toHaveLength(1);
  expect(parseManagedLinearDescription(result.plan?.issue.description, local.threadId)?.body)
    .toBe("Imported body\nsecond line");
  const converged = reconcileLinearIssue({
    baseline: result.plan!.expectedBaseline,
    local,
    remote: { ...identity, title: local.fields.title, description: result.plan!.issue.description, comments: [] },
    bootstrap: { importedRawDescriptionHash: sha256Text(raw) },
  });
  expect(converged.state).toBe("in-sync");
  expect(converged.plan).toBeNull();
});

test("bootstrap adoption carries a current North body after local post-import edits", () => {
  const importedRaw = "Imported body";
  const imported = projectNorthThread(source({ body: importedRaw, progress: [] }));
  const local = projectNorthThread(source({ body: "North revised body", progress: [] }));
  const baseline = createLinearSyncBaseline(identity, imported.threadId, imported.fields);
  const result = reconcileLinearIssue({
    baseline,
    local,
    remote: { ...identity, title: imported.fields.title, description: importedRaw, comments: [] },
    bootstrap: { importedRawDescriptionHash: sha256Text(importedRaw) },
  });
  expect(result.state).toBe("local-ahead");
  expect(result.fields.find(({ field }) => field === "body")?.category).toBe("local-change");
  expect(result.conflicts).toEqual([]);
  expect(parseManagedLinearDescription(result.plan?.issue.description, local.threadId)?.body).toBe("North revised body");
  expect(result.plan?.issue.description).not.toContain(importedRaw);
});

test("bootstrap adoption conflicts on changed raw bytes and reserved or malformed markers", () => {
  const raw = "Imported body\r\nsecond line";
  const local = projectNorthThread(source({ body: raw, progress: [] }));
  const baseline = createLinearSyncBaseline(identity, local.threadId, local.fields);
  const reconcile = (description: string, imported = raw) => reconcileLinearIssue({
    baseline,
    local,
    remote: { ...identity, title: local.fields.title, description, comments: [] },
    bootstrap: { importedRawDescriptionHash: sha256Text(imported) },
  });

  const lineEndingDrift = reconcile("Imported body\nsecond line");
  expect(lineEndingDrift.plan).toBeNull();
  expect(lineEndingDrift.conflicts.some(({ field }) => field === "body")).toBe(true);
  expect(lineEndingDrift.diagnostics[0]).toContain("changed after import");

  const reserved = "Imported body <!-- north:foreign -->";
  const reservedResult = reconcile(reserved, reserved);
  expect(reservedResult.plan).toBeNull();
  expect(reservedResult.diagnostics[0]).toContain("reserved managed-marker namespace");

  const malformed = `<!-- north:thread:${local.threadId} -->\nunterminated`;
  const malformedResult = reconcile(malformed, malformed);
  expect(malformedResult.plan).toBeNull();
  expect(malformedResult.diagnostics[0]).toContain("unclosed North-managed Linear block");
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
