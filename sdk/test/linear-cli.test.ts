import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinearCommand, type LinearCliDependencies } from "../src/integrations/linear/cli";
import { NorthGraphStore, northThreadIdForIdentity, type GraphFact, type GraphStore, type SyncLease, type SyncLeaseManager } from "../src/integrations/linear/north-state";
import { createLinearSyncBaseline } from "../src/integrations/linear/reconcile";
import type { LinearGateway, LinearCallEnvelope } from "../src/integrations/linear/gateway";

class FakeGraph implements GraphStore {
  rows = new Map<string, GraphFact[]>();
  writes: { subject: string; predicate: string; value: string }[] = [];
  failSubjectPrefix?: string;
  failPredicate?: string;
  failAfter = Infinity;
  private matchingWrites = 0;

  async show(subject: string): Promise<readonly GraphFact[]> {
    return [...(this.rows.get(subject.replace(/^@/, "")) ?? [])];
  }

  async put(subjectInput: string, predicate: string, value: string): Promise<void> {
    const subject = subjectInput.replace(/^@/, "");
    if (this.failSubjectPrefix && subject.startsWith(this.failSubjectPrefix)
        && (!this.failPredicate || predicate === this.failPredicate) && ++this.matchingWrites > this.failAfter) {
      this.failSubjectPrefix = undefined;
      this.failPredicate = undefined;
      this.matchingWrites = 0;
      throw new Error("injected graph crash");
    }
    const rows = this.rows.get(subject) ?? [];
    const metadata = this.rows.get(predicate) ?? [];
    const single = ["cardinality", "value_kind", "acyclic"].includes(predicate)
      || metadata.some((fact) => fact.predicate === "cardinality" && fact.value === "single");
    const next = single ? rows.filter((fact) => fact.predicate !== predicate) : rows;
    if (!next.some((fact) => fact.predicate === predicate && fact.value === value)) next.push({ predicate, value });
    this.rows.set(subject, next);
    this.writes.push({ subject, predicate, value });
  }

  seed(subject: string, predicate: string, value: string) {
    const rows = this.rows.get(subject) ?? [];
    rows.push({ predicate, value });
    this.rows.set(subject, rows);
  }
}

class FakeLeases implements SyncLeaseManager {
  private active = new Set<string>();
  async acquire(resource: string): Promise<SyncLease> {
    while (this.active.has(resource)) await new Promise((done) => setTimeout(done, 1));
    this.active.add(resource);
    let released = false;
    return {
      resource, holder: `fake:${resource}`, epoch: 1,
      fence: async () => { if (released || !this.active.has(resource)) throw new Error("lost fake lease"); },
      release: async () => { released = true; this.active.delete(resource); },
    };
  }
}

function issue(key = "MSA-236", description = "Imported body") {
  return {
    id: key,
    title: "Mechanical Linear bridge",
    description,
    url: `https://linear.app/msa-team/issue/${key}/mechanical-linear-bridge`,
    createdAt: "2026-07-16T14:08:20.639Z",
    updatedAt: "2026-07-16T14:08:20.639Z",
    status: "In Progress",
    statusType: "started",
    team: "Technology",
    teamId: "team-a",
  };
}

class FakeGateway implements LinearGateway {
  issue = issue();
  comments: { id: string; body: string }[] = [];
  issueWrites = 0;
  commentWrites = 0;
  throwAfterIssueWrite = false;
  throwAfterCommentWrite = false;
  rejectOldKey = false;
  falsePositive = issue("NOISE-1", "not the marker");
  duplicateExact = false;
  constructor(readonly server = "linear-test") {}

  async call(envelope: LinearCallEnvelope): Promise<unknown> {
    if (envelope.method === "get_issue") return this.readIssue(envelope.arguments);
    if (envelope.method === "list_issues") return this.listIssues(envelope.arguments);
    if (envelope.method === "save_issue") return this.writeIssue(envelope.arguments);
    if (envelope.method === "list_comments") return this.listComments(envelope.arguments);
    return this.writeComment(envelope.arguments);
  }
  async readIssue(args: Record<string, unknown>): Promise<unknown> {
    const key = String(args.id);
    if (key === this.issue.id || (!this.rejectOldKey && key === "MSA-236")) return structuredClone(this.issue);
    if (key === this.falsePositive.id) return structuredClone(this.falsePositive);
    if (key === "DUP-1" && this.duplicateExact) return { ...structuredClone(this.issue), id: "DUP-1" };
    throw new Error(`missing issue ${key}`);
  }
  async listIssues(): Promise<unknown> {
    return {
      issues: [structuredClone(this.falsePositive), structuredClone(this.issue),
        ...(this.duplicateExact ? [{ ...structuredClone(this.issue), id: "DUP-1" }] : [])],
      hasNextPage: false,
    };
  }
  async writeIssue(args: Record<string, unknown>): Promise<unknown> {
    this.issueWrites++;
    if (typeof args.title === "string") this.issue.title = args.title;
    if (typeof args.description === "string") this.issue.description = args.description;
    if (this.throwAfterIssueWrite) { this.throwAfterIssueWrite = false; throw new Error("transport vanished after commit"); }
    return structuredClone(this.issue);
  }
  async listComments(): Promise<unknown> { return { comments: structuredClone(this.comments), hasNextPage: false }; }
  async writeComment(args: Record<string, unknown>): Promise<unknown> {
    this.commentWrites++;
    let comment;
    if (typeof args.id === "string") {
      comment = this.comments.find(({ id }) => id === args.id);
      if (!comment) throw new Error("missing comment");
      comment.body = String(args.body);
    } else {
      comment = { id: `comment-${this.comments.length + 1}`, body: String(args.body) };
      this.comments.push(comment);
    }
    if (this.throwAfterCommentWrite) { this.throwAfterCommentWrite = false; throw new Error("comment response lost"); }
    return structuredClone(comment);
  }
  async close(): Promise<void> {}
}

function harness(server = "linear-test") {
  const graph = new FakeGraph();
  const gateway = new FakeGateway(server);
  const leases = new FakeLeases();
  const opened: (string | undefined)[] = [];
  const dependencies: Partial<LinearCliDependencies> = {
    graph, leases, now: () => new Date("2026-07-16T15:00:00.000Z"),
    mintThreadId: northThreadIdForIdentity,
    openGateway: async ({ server: requested }) => {
      opened.push(requested);
      if (requested && requested !== gateway.server) throw new Error(`wrong server ${requested}`);
      return gateway;
    },
  };
  return { graph, gateway, leases, opened, dependencies };
}

async function importThread(h: ReturnType<typeof harness>): Promise<string> {
  const result = await runLinearCommand(["import", "MSA-236"], h.dependencies) as { thread: string };
  return result.thread.replace(/^@/, "");
}

test("import dry-run is stable and read-only", async () => {
  const h = harness();
  const before = h.graph.writes.length;
  const first = await runLinearCommand(["import", "MSA-236", "--dry-run"], h.dependencies);
  const second = await runLinearCommand(["import", "MSA-236", "--dry-run"], h.dependencies);
  expect(first).toEqual(second);
  expect(h.graph.writes).toHaveLength(before);
});

test("repeated import converges on one deterministic thread and singleton manifest", async () => {
  const h = harness();
  const first = await importThread(h);
  const second = await importThread(h);
  expect(second).toBe(first);
  const threadFacts = await h.graph.show(first);
  expect(threadFacts.filter(({ predicate }) => predicate === "title")).toHaveLength(1);
  const link = threadFacts.find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  expect((await h.graph.show(link)).filter(({ predicate }) => predicate === "sync_manifest")).toHaveLength(1);
});

test("partial link and partial thread crashes heal using the prepared identity and importedAt", async () => {
  const linkCrash = harness();
  linkCrash.graph.failSubjectPrefix = "link:linear:";
  linkCrash.graph.failAfter = 3;
  await expect(importThread(linkCrash)).rejects.toThrow("injected graph crash");
  const healed = await importThread(linkCrash);
  expect((await linkCrash.graph.show(healed)).some(({ predicate }) => predicate === "committed")).toBe(true);

  const threadCrash = harness();
  const preview = await runLinearCommand(["import", "MSA-236", "--dry-run"], threadCrash.dependencies) as { thread: string };
  threadCrash.graph.failSubjectPrefix = preview.thread.replace(/^@/, "");
  threadCrash.graph.failAfter = 3;
  await expect(importThread(threadCrash)).rejects.toThrow("injected graph crash");
  const thread = await importThread(threadCrash);
  const facts = await threadCrash.graph.show(thread);
  expect(facts.some(({ predicate, value }) => predicate === "created_at" && value === "2026-07-16T15:00:00.000Z")).toBe(true);
  expect(facts.some(({ predicate }) => predicate === "body")).toBe(true);
});

test("adopted imported link recreates a missing thread from stable import evidence", async () => {
  const h = harness();
  const thread = await importThread(h);
  h.graph.rows.delete(thread);

  expect(await importThread(h)).toBe(thread);
  const facts = await h.graph.show(thread);
  expect(facts.some(({ predicate, value }) => predicate === "title" && value === h.gateway.issue.title)).toBe(true);
  expect(facts.some(({ predicate, value }) => predicate === "body" && value === h.gateway.issue.description)).toBe(true);
  expect(facts.some(({ predicate, value }) => predicate === "created_at" && value === "2026-07-16T15:00:00.000Z")).toBe(true);
});

test("first apply consumes unchanged imported description once and comments deduplicate", async () => {
  const h = harness();
  const thread = await importThread(h);
  await h.graph.put(thread, "progress", "Projection wired.");
  const first = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as { writes: number };
  expect(first.writes).toBe(2);
  expect(h.gateway.issue.description.match(/Imported body/g)).toHaveLength(1);
  expect(h.gateway.issue.description).toContain(`<!-- north:thread:${thread} -->`);
  expect(h.gateway.comments).toHaveLength(1);
  const second = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as { writes: number };
  expect(second.writes).toBe(0);
  expect(h.gateway.comments).toHaveLength(1);
});

test("unknown post-commit response reconciles without a duplicate and binds marker immediately", async () => {
  const h = harness();
  const thread = await importThread(h);
  h.gateway.throwAfterIssueWrite = true;
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.issueWrites).toBe(1);
  const linkRef = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  const manifest = JSON.parse((await h.graph.show(linkRef)).find(({ predicate }) => predicate === "sync_manifest")!.value);
  expect(manifest.evidence.markerBound).toBe(true);
  expect(manifest.evidence.adoptRawDescription).toBe(false);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.issueWrites).toBe(1);
});

test("crash after issue commit but before confirmed manifest recovers persisted intent without retry", async () => {
  const h = harness();
  const thread = await importThread(h);
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  h.graph.failSubjectPrefix = link;
  h.graph.failPredicate = "sync_manifest";
  h.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies)).rejects.toThrow("injected graph crash");
  expect(h.gateway.issueWrites).toBe(1);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.issueWrites).toBe(1);
  const manifest = JSON.parse((await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value);
  expect(manifest.pending).toBeUndefined();
  expect(manifest.evidence.markerBound).toBe(true);
});

test("persisted comment intent reconciles a lost response without duplicate comment", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  await h.graph.put(thread, "progress", "One durable update.");
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  h.gateway.throwAfterCommentWrite = true;
  h.graph.failSubjectPrefix = link;
  h.graph.failPredicate = "sync_manifest";
  h.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies)).rejects.toThrow("injected graph crash");
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.gateway.comments).toHaveLength(1);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.gateway.comments).toHaveLength(1);
});

test("concurrent apply serializes and emits one remote issue mutation", async () => {
  const h = harness();
  const thread = await importThread(h);
  await Promise.all([
    runLinearCommand(["sync", thread, "--apply"], h.dependencies),
    runLinearCommand(["sync", thread, "--apply"], h.dependencies),
  ]);
  expect(h.gateway.issueWrites).toBe(1);
});

test("legacy aliases are never auto-matched", async () => {
  const h = harness();
  h.graph.seed("legacy-a", "title", "old A");
  h.graph.seed("legacy-a", "linear", "MSA-236");
  h.graph.seed("legacy-b", "title", "old B");
  h.graph.seed("legacy-b", "linear", "MSA-236");
  await expect(runLinearCommand(["plan", "legacy-a", "--server", "linear-test"], h.dependencies))
    .rejects.toThrow("only a legacy linear alias");
  const imported = await importThread(h);
  expect(imported).not.toBe("legacy-a");
  expect(imported).not.toBe("legacy-b");
});

test("stored server drives marker relocation after mutable key/team/workspace changes", async () => {
  const h = harness("linear-special");
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  h.gateway.issue = {
    ...h.gateway.issue, id: "PLATFORM-9", teamId: "team-b",
    url: "https://linear.app/renamed-workspace/issue/PLATFORM-9/mechanical-linear-bridge",
  };
  h.gateway.rejectOldKey = true;
  const plan = await runLinearCommand(["plan", thread], h.dependencies) as { state: string };
  expect(plan.state).toBe("in-sync");
  expect(h.opened.at(-1)).toBe("linear-special");
});

test("marker relocation rejects duplicate exact matches", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  h.gateway.issue = { ...h.gateway.issue, id: "NEW-1" };
  h.gateway.rejectOldKey = true;
  h.gateway.duplicateExact = true;
  await expect(runLinearCommand(["plan", thread], h.dependencies)).rejects.toThrow("found 2 exact issue");
});

test("doctor/get are graph read-only and irrelevant flags fail closed", async () => {
  const h = harness();
  await runLinearCommand(["doctor"], h.dependencies);
  await runLinearCommand(["get", "MSA-236"], h.dependencies);
  expect(h.graph.writes).toHaveLength(0);
  await expect(runLinearCommand(["get", "MSA-236", "--apply"], h.dependencies)).rejects.toThrow("accepts only --server");
  await expect(runLinearCommand(["plan", "x", "--dry-run"], h.dependencies)).rejects.toThrow("accepts only --server");
});

test("corrupted partial manifest evidence fails closed instead of being healed", async () => {
  const h = harness();
  const preview = await runLinearCommand(["import", "MSA-236", "--dry-run"], h.dependencies) as {
    identity: Parameters<typeof createLinearSyncBaseline>[0]; link: string; thread: string;
  };
  const thread = preview.thread.replace(/^@/, "");
  const baseline = createLinearSyncBaseline(preview.identity, thread, {
    title: h.gateway.issue.title, body: h.gateway.issue.description,
    doneWhen: [], barEvidence: [], repos: [], lifecycle: "ready",
  });
  h.graph.seed(preview.link.replace(/^@/, ""), "sync_manifest", JSON.stringify({
    version: 1, phase: "prepared", baseline,
    evidence: {
      connector: "wrong-connector", createdAt: h.gateway.issue.createdAt, initialKey: h.gateway.issue.id,
      workspace: "msa-team", importedAt: "2026-07-16T15:00:00.000Z", createdThread: true,
      owner: "personal", importedRawDescriptionHash: "a".repeat(64), importedTitleHash: "b".repeat(64),
      adoptRawDescription: true, markerBound: false,
    },
  }));
  await expect(runLinearCommand(["import", "MSA-236"], h.dependencies)).rejects.toThrow("does not match the current import");
});

test("NorthGraphStore never mistakes a no-coordinator message for a commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-linear-graph-"));
  try {
    const north = join(directory, "north");
    const fram = join(directory, "fram");
    writeFileSync(north, "#!/bin/sh\nprintf '[]\\n'\n");
    writeFileSync(fram, "#!/bin/sh\nprintf '%s\\n' 'no coordinator on 127.0.0.1:7977'\n");
    chmodSync(north, 0o700);
    chmodSync(fram, 0o700);
    await expect(new NorthGraphStore(north, fram).put("link:x", "kind", "integration_link"))
      .rejects.toThrow("coordinator rejected");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
