import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINEAR_LEASE_TIMEOUT_SAFETY_FACTOR, LINEAR_MCP_CALL_TIMEOUT_MS,
  runLinearCommand, type LinearCliDependencies,
} from "../src/integrations/linear/cli";
import {
  CoordinatorSyncLeaseManager, LINEAR_SYNC_LEASE_TTL_MS, NorthGraphStore, northThreadIdForIdentity,
  type GraphFact, type GraphStore, type SyncLease, type SyncLeaseManager,
} from "../src/integrations/linear/north-state";
import { createLinearSyncBaseline } from "../src/integrations/linear/reconcile";
import type { LinearGateway, LinearCallEnvelope } from "../src/integrations/linear/gateway";
import type { ModelFreeTransportReceipt } from "../src/integrations/linear/mcp-broker";

class FakeGraph implements GraphStore {
  rows = new Map<string, GraphFact[]>();
  writes: { subject: string; predicate: string; value: string }[] = [];
  showReads = 0;
  bulkReads = 0;
  failSubjectPrefix?: string;
  failPredicate?: string;
  failAfter = Infinity;
  afterPut?: (subject: string, predicate: string, value: string) => void;
  private matchingWrites = 0;

  async show(subject: string): Promise<readonly GraphFact[]> {
    this.showReads++;
    return [...(this.rows.get(subject.replace(/^@/, "")) ?? [])];
  }

  async showMany(subjects: readonly string[]): Promise<ReadonlyMap<string, readonly GraphFact[]>> {
    this.bulkReads++;
    return new Map(subjects.map((subject) => {
      const bare = subject.replace(/^@/, "");
      return [bare, [...(this.rows.get(bare) ?? [])]] as const;
    }));
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
    this.afterPut?.(subject, predicate, value);
  }

  async putFenced(lease: SyncLease, subject: string, predicate: string, value: string): Promise<void> {
    await lease.fence();
    await this.put(subject, predicate, value);
  }

  seed(subject: string, predicate: string, value: string) {
    const rows = this.rows.get(subject) ?? [];
    rows.push({ predicate, value });
    this.rows.set(subject, rows);
  }
}

class FakeLeases implements SyncLeaseManager {
  private active = new Map<string, { holder: string; epoch: number }>();
  private nextEpoch = 0;
  private renewalCount = 0;
  private loseAtRenewal?: number;
  private throwAtRenewal?: number;
  releaseFailure?: string;

  loseOnNthNextRenewal(n: number): void {
    this.loseAtRenewal = this.renewalCount + n;
  }

  throwOnNthNextRenewal(n: number): void {
    this.throwAtRenewal = this.renewalCount + n;
  }

  takeoverActive(): void {
    for (const [resource] of this.active)
      this.active.set(resource, { holder: `successor:${resource}`, epoch: ++this.nextEpoch });
  }

  clearTakeovers(): void {
    for (const [resource, state] of this.active)
      if (state.holder.startsWith("successor:")) this.active.delete(resource);
  }

  async acquire(resource: string): Promise<SyncLease> {
    while (this.active.has(resource)) await new Promise((done) => setTimeout(done, 1));
    const holder = `fake:${resource}:${this.nextEpoch + 1}`;
    let epoch = ++this.nextEpoch;
    this.active.set(resource, { holder, epoch });
    let released = false;
    return {
      resource, holder,
      get epoch() { return epoch; },
      renew: async () => {
        this.renewalCount++;
        if (this.renewalCount === this.throwAtRenewal) {
          this.throwAtRenewal = undefined;
          throw new Error("renewal sentinel");
        }
        if (this.renewalCount === this.loseAtRenewal) this.takeoverActive();
        const current = this.active.get(resource);
        if (released || current?.holder !== holder || current.epoch !== epoch) throw new Error("lost fake lease");
        epoch = ++this.nextEpoch;
        this.active.set(resource, { holder, epoch });
      },
      fence: async () => {
        const current = this.active.get(resource);
        if (released || current?.holder !== holder || current.epoch !== epoch) throw new Error("lost fake lease");
      },
      release: async () => {
        const current = this.active.get(resource);
        if (current?.holder === holder && current.epoch === epoch) this.active.delete(resource);
        released = true;
        if (this.releaseFailure) {
          const message = this.releaseFailure;
          this.releaseFailure = undefined;
          throw new Error(message);
        }
      },
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

function normalizeLinearManagedMarkdown(description: string): string {
  return description
    .replace(
      /(<!-- north:thread:[^>\r\n]+ -->)\n(## North thread)/,
      "$1\n\n$2",
    )
    .replace(/(### (?:Body|Done when|Bar evidence|Repositories))\n(<!-- north:field:)/g, "$1\n\n$2");
}

class FakeGateway implements LinearGateway {
  issue = issue();
  comments: { id: string; body: string }[] = [];
  issueWrites = 0;
  commentWrites = 0;
  throwAfterIssueWrite = false;
  throwAfterCommentWrite = false;
  normalizeManagedMarkdown = false;
  rejectOldKey = false;
  falsePositive = issue("NOISE-1", "not the marker");
  duplicateExact = false;
  infiniteCommentPages = false;
  oversizedCommentPage = false;
  commentPageCalls = 0;
  infiniteIssuePages = false;
  oversizedIssueCandidates = false;
  duplicateIssueKey = false;
  issuePageCalls = 0;
  malformedComment?: "blank-id" | "non-string-body";
  afterIssueWrite?: () => void;
  afterWrittenIssueRead?: () => void;
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
    if (key === this.issue.id || (!this.rejectOldKey && key === "MSA-236")) {
      const result = structuredClone(this.issue);
      if (this.issueWrites > 0) this.afterWrittenIssueRead?.();
      return result;
    }
    if (key === this.falsePositive.id) return structuredClone(this.falsePositive);
    if (key === "DUP-1" && this.duplicateExact) return { ...structuredClone(this.issue), id: "DUP-1" };
    throw new Error(`missing issue ${key}`);
  }
  async listIssues(): Promise<unknown> {
    if (this.infiniteIssuePages) {
      const page = ++this.issuePageCalls;
      return { issues: [], hasNextPage: true, nextCursor: `issues-${page}` };
    }
    if (this.oversizedIssueCandidates) {
      return {
        issues: Array.from({ length: 26 }, (_, index) => ({
          ...issue(`NOISE-${index}`, "not the marker"),
          createdAt: `2026-07-16T14:08:${String(index % 60).padStart(2, "0")}.639Z`,
        })),
        hasNextPage: false,
      };
    }
    return {
      issues: [structuredClone(this.falsePositive), structuredClone(this.issue),
        ...(this.duplicateIssueKey ? [structuredClone(this.issue)] : []),
        ...(this.duplicateExact ? [{ ...structuredClone(this.issue), id: "DUP-1" }] : [])],
      hasNextPage: false,
    };
  }
  async writeIssue(args: Record<string, unknown>): Promise<unknown> {
    this.issueWrites++;
    if (typeof args.title === "string") this.issue.title = args.title;
    if (typeof args.description === "string") {
      this.issue.description = this.normalizeManagedMarkdown
        ? normalizeLinearManagedMarkdown(args.description) : args.description;
    }
    this.afterIssueWrite?.();
    if (this.throwAfterIssueWrite) { this.throwAfterIssueWrite = false; throw new Error("transport vanished after commit"); }
    return structuredClone(this.issue);
  }
  async listComments(): Promise<unknown> {
    if (this.malformedComment === "blank-id")
      return { comments: [{ id: " ", body: "managed-looking" }], hasNextPage: false };
    if (this.malformedComment === "non-string-body")
      return { comments: [{ id: "comment-malformed", body: 42 }], hasNextPage: false };
    if (this.infiniteCommentPages) {
      const page = ++this.commentPageCalls;
      return { comments: [], hasNextPage: true, nextCursor: `comments-${page}` };
    }
    if (this.oversizedCommentPage) {
      return {
        comments: Array.from({ length: 5_001 }, (_, index) => ({ id: `comment-${index}`, body: "" })),
        hasNextPage: false,
      };
    }
    return { comments: structuredClone(this.comments), hasNextPage: false };
  }
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
  transportReceipt(): ModelFreeTransportReceipt {
    return {
      transport: "linear-test-double", policy: "linear-test-double-v1", ephemeralThread: true,
      linearServer: this.server,
      outgoingMethods: {}, incomingNotifications: {},
      mcpCalls: [],
      modelTurnsStarted: 0, usageEvents: 0, tokenTotalStatus: "exact-zero-protocol",
    };
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

test("representative mechanical lifecycle converges, no-ops, and recovers from conflict", async () => {
  const h = harness();
  const doctorBefore = await runLinearCommand(["doctor"], h.dependencies) as {
    modelTurn: boolean; oauth: boolean; graphSchema: { ok: boolean };
    graphSchemaBootstrap: { applied: boolean; assertions: number };
  };
  expect(doctorBefore).toMatchObject({
    modelTurn: false, oauth: true, graphSchema: { ok: true, missing: [], conflicting: [] },
    graphSchemaBootstrap: { applied: true, assertions: 19 },
  });
  const fetched = await runLinearCommand(["get", "MSA-236"], h.dependencies) as {
    issue: { key: string }; identity: unknown;
  };
  expect(fetched.issue.key).toBe("MSA-236");
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);

  const imported = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    thread: string; link: string; identity: unknown; reused: boolean;
  };
  const thread = imported.thread.replace(/^@/, "");
  expect((await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")?.value)
    .toBe(imported.link);
  expect(imported.reused).toBe(false);
  expect(await runLinearCommand(["doctor"], h.dependencies)).toMatchObject({
    modelTurn: false, graphSchema: { ok: true, missing: [], conflicting: [] },
  });
  await h.graph.put(thread, "progress", "Projection wired.");

  const plan = await runLinearCommand(["plan", thread], h.dependencies) as {
    state: string; actions: { issue: string[]; comments: unknown[]; descriptionAdoption: boolean; hash: string };
  };
  expect(plan).toMatchObject({
    state: "local-ahead",
    actions: { issue: ["description"], descriptionAdoption: true, comments: [{ action: "create" }] },
  });
  expect(await runLinearCommand(["sync", thread], h.dependencies)).toEqual(plan);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);

  const applied = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as {
    writes: number; state: string;
  };
  expect(applied).toMatchObject({ writes: 2, state: "in-sync" });
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  expect(await runLinearCommand(["plan", thread], h.dependencies)).toMatchObject({
    state: "in-sync", conflicts: [], actions: [],
  });

  const duplicate = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    thread: string; link: string; identity: unknown; reused: boolean;
  };
  expect(duplicate).toMatchObject({
    thread: imported.thread, link: imported.link, identity: imported.identity, reused: true,
  });
  expect((await h.graph.show(thread)).filter(({ predicate }) => predicate === "linear_link")).toHaveLength(1);

  h.gateway.issue.title = "Remote title drift";
  expect(await runLinearCommand(["plan", thread], h.dependencies)).toMatchObject({
    state: "remote-drift", conflicts: [{ field: "title", category: "remote-drift" }], actions: [],
  });
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("Linear sync conflict: title:remote-drift");
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);

  h.gateway.issue.title = "Mechanical Linear bridge";
  expect(await runLinearCommand(["plan", thread], h.dependencies)).toMatchObject({
    state: "in-sync", conflicts: [], actions: [],
  });
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

test("concurrent imports deduplicate identity and report the post-lease reuse truth", async () => {
  const h = harness();
  const results = await Promise.all([
    runLinearCommand(["import", "MSA-236"], h.dependencies),
    runLinearCommand(["import", "MSA-236"], h.dependencies),
  ]) as Array<{ thread: string; link: string; reused: boolean }>;
  expect(new Set(results.map(({ thread }) => thread)).size).toBe(1);
  expect(new Set(results.map(({ link }) => link)).size).toBe(1);
  expect(results.map(({ reused }) => reused).sort()).toEqual([false, true]);
  const thread = results[0]!.thread.replace(/^@/, "");
  const link = results[0]!.link.replace(/^@/, "");
  expect((await h.graph.show(thread)).filter(({ predicate }) => predicate === "linear_link")).toHaveLength(1);
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
  const graphWritesAfterFirstApply = h.graph.writes.length;
  const second = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as { writes: number };
  expect(second.writes).toBe(0);
  expect(h.gateway.comments).toHaveLength(1);
  expect(h.graph.writes).toHaveLength(graphWritesAfterFirstApply);
});

test("first apply binds an explicitly adopted speculative thread even without a field delta", async () => {
  const h = harness();
  const thread = "existing-speculative-thread";
  h.graph.seed(thread, "title", h.gateway.issue.title);
  const unmanagedDescription = h.gateway.issue.description;
  const imported = await runLinearCommand(
    ["import", "MSA-236", "--thread", thread], h.dependencies,
  ) as { thread: string; createdThread: boolean };
  expect(imported).toMatchObject({ thread: `@${thread}`, createdThread: false });

  const plan = await runLinearCommand(["plan", thread], h.dependencies);
  expect(plan).toMatchObject({
    state: "local-ahead",
    actions: { issue: ["description"], comments: [], descriptionAdoption: true },
  });
  const first = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as { writes: number };
  expect(first.writes).toBe(1);
  expect(h.gateway.issue.description.startsWith(unmanagedDescription)).toBe(true);
  expect(h.gateway.issue.description.match(new RegExp(`<!-- north:thread:${thread} -->`, "g"))).toHaveLength(1);
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  const manifest = JSON.parse((await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value);
  expect(manifest.evidence.markerBound).toBe(true);

  const graphWritesAfterFirstApply = h.graph.writes.length;
  const second = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as { writes: number };
  expect(second.writes).toBe(0);
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.graph.writes).toHaveLength(graphWritesAfterFirstApply);
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

test("known Linear scaffold normalization confirms once and the second apply is an exact no-op", async () => {
  const h = harness();
  h.gateway.normalizeManagedMarkdown = true;
  const thread = await importThread(h);
  await h.graph.put(thread, "progress", "Projection wired.");
  const first = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as { writes: number };
  expect(first.writes).toBe(2);
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.gateway.issue.description).toContain("\n\n## North thread");
  expect(await runLinearCommand(["plan", thread], h.dependencies))
    .toMatchObject({ state: "in-sync", actions: [] });
  const graphWrites = h.graph.writes.length;
  const second = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as { writes: number };
  expect(second.writes).toBe(0);
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.graph.writes).toHaveLength(graphWrites);
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
  expect(await runLinearCommand(["plan", thread], h.dependencies)).toMatchObject({ state: "in-sync", actions: [] });
});

test("legacy normalized pending recovery proves the original payload and rejects unmanaged drift", async () => {
  const recoverable = harness();
  recoverable.gateway.normalizeManagedMarkdown = true;
  const recoveredThread = await importThread(recoverable);
  const recoveredLink = (await recoverable.graph.show(recoveredThread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  recoverable.graph.failSubjectPrefix = recoveredLink;
  recoverable.graph.failPredicate = "sync_manifest";
  recoverable.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", recoveredThread, "--apply"], recoverable.dependencies))
    .rejects.toThrow("injected graph crash");
  const recoveredRows = recoverable.graph.rows.get(recoveredLink)!;
  recoverable.graph.rows.set(recoveredLink, recoveredRows.map((fact) => {
    if (fact.predicate !== "sync_manifest") return fact;
    const manifest = JSON.parse(fact.value);
    delete manifest.pending.descriptionReceiptHash;
    return { ...fact, value: JSON.stringify(manifest) };
  }));
  await runLinearCommand(["sync", recoveredThread, "--apply"], recoverable.dependencies);
  expect(recoverable.gateway.issueWrites).toBe(1);

  const rejected = harness();
  rejected.gateway.normalizeManagedMarkdown = true;
  const existing = "existing-normalized-thread";
  rejected.graph.seed(existing, "title", rejected.gateway.issue.title);
  await runLinearCommand(["import", "MSA-236", "--thread", existing], rejected.dependencies);
  const rejectedLink = (await rejected.graph.show(existing))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  rejected.graph.failSubjectPrefix = rejectedLink;
  rejected.graph.failPredicate = "sync_manifest";
  rejected.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", existing, "--apply"], rejected.dependencies))
    .rejects.toThrow("injected graph crash");
  const rejectedRows = rejected.graph.rows.get(rejectedLink)!;
  rejected.graph.rows.set(rejectedLink, rejectedRows.map((fact) => {
    if (fact.predicate !== "sync_manifest") return fact;
    const manifest = JSON.parse(fact.value);
    delete manifest.pending.descriptionReceiptHash;
    return { ...fact, value: JSON.stringify(manifest) };
  }));
  rejected.gateway.issue.description = rejected.gateway.issue.description.replace(
    "Imported body", "Externally changed unmanaged body",
  );
  await expect(runLinearCommand(["sync", existing, "--apply"], rejected.dependencies))
    .rejects.toThrow("prior issue write has unknown outcome and is not observable");
  expect(rejected.gateway.issueWrites).toBe(1);
});

test("multi-operation apply carries all receipts through a crash and retry", async () => {
  const h = harness();
  const thread = await importThread(h);
  await h.graph.put(thread, "progress", "One durable update.");
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");

  // issue pending + issue confirmed + comment pending succeed; the confirmed
  // comment manifest crashes after the remote comment is already durable.
  h.graph.failSubjectPrefix = link;
  h.graph.failPredicate = "sync_manifest";
  h.graph.failAfter = 3;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies)).rejects.toThrow("injected graph crash");
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.gateway.comments).toHaveLength(1);

  const interrupted = JSON.parse((await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value);
  expect(interrupted.pending).toMatchObject({ kind: "comment" });
  expect(Object.keys(interrupted.receipts ?? {})).toHaveLength(1);

  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.gateway.comments).toHaveLength(1);
  const recovered = JSON.parse((await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value);
  expect(recovered.pending).toBeUndefined();
  expect(Object.keys(recovered.receipts ?? {})).toHaveLength(2);
  expect(recovered.evidence.markerBound).toBe(true);
  expect(await runLinearCommand(["plan", thread], h.dependencies)).toMatchObject({ state: "in-sync", actions: [] });
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
  expect(await runLinearCommand(["plan", thread], h.dependencies)).toMatchObject({ state: "in-sync", actions: [] });
});

test("pending comment recovery rejects duplicate managed markers before graph or remote writes", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  await h.graph.put(thread, "progress", "One durable update.");
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  h.graph.failSubjectPrefix = link;
  h.graph.failPredicate = "sync_manifest";
  h.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies)).rejects.toThrow("injected graph crash");
  expect(h.gateway.commentWrites).toBe(1);
  h.gateway.comments.push({ id: "duplicate-comment", body: h.gateway.comments[0]!.body });
  const graphWritesBeforeRecovery = h.graph.writes.length;

  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("duplicate North-managed marker");
  expect(h.graph.writes).toHaveLength(graphWritesBeforeRecovery);
  expect(h.gateway.commentWrites).toBe(1);
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

test("lease renewal advances the exact epoch and release uses only the latest token", async () => {
  const calls: string[][] = [];
  const manager = new CoordinatorSyncLeaseManager(
    "7977", "/unused/lease-cli.clj", 5_000, 1,
    async (args) => {
      calls.push([...args]);
      if (args[0] === "acquire")
        return JSON.stringify({ ok: 10, holder: args[2], exp: 1_000, epoch: 10 });
      if (args[0] === "renew" && args[3] === "10")
        return JSON.stringify({ ok: 11, holder: args[2], exp: 2_000, epoch: 11 });
      if (args[0] === "fence" && args[3] === "11") return JSON.stringify({ "fence-ok": true });
      if (args[0] === "release" && args[3] === "11") return JSON.stringify({ ok: 12 });
      return JSON.stringify({ reject: "fence-lost", version: 12 });
    },
  );
  const lease = await manager.acquire("linear-sync:test");
  expect(lease.epoch).toBe(10);
  await lease.renew();
  expect(lease.epoch).toBe(11);
  await lease.fence();
  await lease.release();
  expect(calls.map(([verb]) => verb)).toEqual(["acquire", "renew", "fence", "release"]);
  expect(calls.at(-1)).toEqual(["release", "linear-sync:test", lease.holder, "11"]);
});

test("a lost renewal response never advances the local epoch or triggers reacquisition", async () => {
  const calls: string[][] = [];
  const manager = new CoordinatorSyncLeaseManager(
    "7977", "/unused/lease-cli.clj", 5_000, 1,
    async (args) => {
      calls.push([...args]);
      if (args[0] === "acquire")
        return JSON.stringify({ ok: 10, holder: args[2], exp: 1_000, epoch: 10 });
      if (args[0] === "renew") throw new Error("renewal response lost");
      if (args[0] === "release") return JSON.stringify({ ok: 11, noop: true });
      throw new Error("unexpected lease operation");
    },
  );
  const lease = await manager.acquire("linear-sync:lost-response");
  await expect(lease.renew()).rejects.toThrow("renewal response lost");
  expect(lease.epoch).toBe(10);
  await lease.release();
  expect(calls.map(([verb]) => verb)).toEqual(["acquire", "renew", "release"]);
  expect(calls.at(-1)?.[3]).toBe("10");
});

test("lease responses use exact JSON envelopes with coherent safe epochs", async () => {
  const invalidResponses: readonly ((holder: string) => string)[] = [
    (holder) => `{"ok":10,"holder":"${holder}","exp":1000,"epoch":10} trailing`,
    (holder) => JSON.stringify({ ok: 10, holder, exp: 1_000, epoch: 10, surplus: true }),
    (holder) => JSON.stringify({ ok: 10, holder, exp: 1_000, epoch: 11 }),
    (holder) => JSON.stringify({ ok: 9_007_199_254_740_992, holder, exp: 1_000, epoch: 9_007_199_254_740_992 }),
    (holder) => `{"ok":10,"ok":10,"holder":"${holder}","exp":1000,"epoch":10}`,
    (holder) => JSON.stringify({ ok: 10, holder, exp: 1_000, epoch: 10, reject: "held" }),
  ];
  for (const response of invalidResponses) {
    const manager = new CoordinatorSyncLeaseManager(
      "7977", "/unused/lease-cli.clj", 5_000, 1,
      async (args) => response(args[2]!),
    );
    await expect(manager.acquire("linear-sync:hostile"))
      .rejects.toThrow("invalid acquire response");
  }

  let call = 0;
  const nonAdvancing = new CoordinatorSyncLeaseManager(
    "7977", "/unused/lease-cli.clj", 5_000, 1,
    async (args) => {
      call++;
      return JSON.stringify({ ok: 10, holder: args[2], exp: 1_000, epoch: 10 });
    },
  );
  const lease = await nonAdvancing.acquire("linear-sync:non-advancing");
  await expect(lease.renew()).rejects.toThrow("invalid renewal response");
  expect(call).toBe(2);
});

test("fenced graph writes classify exact JSON success, lease loss, rejection, and malformed output", async () => {
  const lease: SyncLease = {
    resource: "linear-sync:test", holder: "holder", epoch: 10,
    renew: async () => {}, fence: async () => {}, release: async () => {},
  };
  const response = { value: JSON.stringify({ ok: 11 }) };
  const store = new NorthGraphStore(
    "/unused/north", "/unused/fram", "/unused/lease-cli.clj", "7977",
    async () => response.value,
  );
  await store.putFenced(lease, "link:x", "sync_manifest", "{}");

  response.value = JSON.stringify({ reject: "fence-lost", version: 11 });
  await expect(store.putFenced(lease, "link:x", "sync_manifest", "{}"))
    .rejects.toThrow("lost Linear sync lease");

  response.value = JSON.stringify({ reject: ["reserved predicate"], version: 11 });
  await expect(store.putFenced(lease, "link:x", "sync_manifest", "{}"))
    .rejects.toThrow("coordinator rejected fenced Linear graph write");

  response.value = JSON.stringify({ ok: 12, surplus: true });
  await expect(store.putFenced(lease, "link:x", "sync_manifest", "{}"))
    .rejects.toThrow("invalid fenced-write response");
});

test("lease configuration rejects hostile bounds and dominates every remote call", () => {
  expect(() => new CoordinatorSyncLeaseManager("7977", "/unused", 0, 1))
    .toThrow("TTL must be a positive safe integer");
  expect(() => new CoordinatorSyncLeaseManager("7977", "/unused", 5_000, 0))
    .toThrow("attempts must be a positive safe integer");
  expect(LINEAR_SYNC_LEASE_TTL_MS)
    .toBeGreaterThanOrEqual(LINEAR_MCP_CALL_TIMEOUT_MS * LINEAR_LEASE_TIMEOUT_SAFETY_FACTOR);
});

test("takeover after pending intent prevents the stale holder from starting a remote side effect", async () => {
  const h = harness();
  const thread = await importThread(h);
  h.graph.afterPut = (_subject, predicate, value) => {
    if (predicate === "sync_manifest" && JSON.parse(value).pending) h.leases.takeoverActive();
  };
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies)).rejects.toThrow("lost fake lease");
  expect(h.gateway.issueWrites).toBe(0);
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  const pending = JSON.parse((await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value);
  expect(pending.pending).toMatchObject({ kind: "issue" });

  h.graph.afterPut = undefined;
  h.leases.clearTakeovers();
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("prior issue write has unknown outcome and is not observable; refusing to retry");
  expect(h.gateway.issueWrites).toBe(0);
});

test("takeover during a remote call leaves intent for a successor to reconcile without a duplicate", async () => {
  const h = harness();
  const thread = await importThread(h);
  h.gateway.afterIssueWrite = () => h.leases.takeoverActive();
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies)).rejects.toThrow("lost fake lease");
  expect(h.gateway.issueWrites).toBe(1);
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  expect(JSON.parse((await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value).pending)
    .toMatchObject({ kind: "issue" });

  h.gateway.afterIssueWrite = undefined;
  h.leases.clearTakeovers();
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.issueWrites).toBe(1);
  expect(await runLinearCommand(["plan", thread], h.dependencies))
    .toMatchObject({ state: "in-sync", actions: [] });
});

test("takeover after readback prevents stale finalization and the successor confirms the pending write", async () => {
  const h = harness();
  const thread = await importThread(h);
  h.gateway.afterWrittenIssueRead = () => {
    h.gateway.afterWrittenIssueRead = undefined;
    h.leases.takeoverActive();
  };
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies)).rejects.toThrow("lost fake lease");
  expect(h.gateway.issueWrites).toBe(1);
  const link = (await h.graph.show(thread)).find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  expect(JSON.parse((await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value).pending)
    .toMatchObject({ kind: "issue" });

  h.leases.clearTakeovers();
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.issueWrites).toBe(1);
  expect(await runLinearCommand(["plan", thread], h.dependencies))
    .toMatchObject({ state: "in-sync", actions: [] });
});

test("lease loss during paginated reads aborts before any remote or graph mutation", async () => {
  const h = harness();
  const thread = await importThread(h);
  const graphWritesBeforeApply = h.graph.writes.length;
  h.gateway.infiniteCommentPages = true;
  h.leases.loseOnNthNextRenewal(5);

  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("lost fake lease");
  expect(h.gateway.commentPageCalls).toBe(2);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);
  expect(h.graph.writes.length).toBe(graphWritesBeforeApply);
  h.leases.clearTakeovers();
});

test("lease renewal failure at stored-key lookup is never reclassified as backlink relocation", async () => {
  const h = harness();
  const thread = await importThread(h);
  h.leases.throwOnNthNextRenewal(2);
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("renewal sentinel");
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);
});

test("release cleanup never masks a primary failure but still fails a successful operation", async () => {
  const primary = harness();
  const primaryThread = await importThread(primary);
  primary.gateway.infiniteCommentPages = true;
  primary.leases.releaseFailure = "release transport failed";
  await expect(runLinearCommand(["sync", primaryThread, "--apply"], primary.dependencies))
    .rejects.toThrow("Linear list_comments exceeded 20 pages");

  const successful = harness();
  const successfulThread = await importThread(successful);
  successful.leases.releaseFailure = "release transport failed";
  await expect(runLinearCommand(["sync", successfulThread, "--apply"], successful.dependencies))
    .rejects.toThrow("release transport failed");
});

for (const malformed of ["blank-id", "non-string-body"] as const) {
  test(`malformed Linear comment ${malformed} fails closed`, async () => {
    const h = harness();
    const thread = await importThread(h);
    h.gateway.malformedComment = malformed;
    await expect(runLinearCommand(["plan", thread], h.dependencies))
      .rejects.toThrow(malformed === "blank-id" ? "non-blank id" : "string body");
    expect(h.gateway.commentWrites).toBe(0);
  });
}

test("Linear issue and comment pagination has explicit page and item ceilings", async () => {
  const comments = harness();
  const commentsThread = await importThread(comments);
  comments.gateway.infiniteCommentPages = true;
  await expect(runLinearCommand(["plan", commentsThread], comments.dependencies))
    .rejects.toThrow("Linear list_comments exceeded 20 pages");
  expect(comments.gateway.commentPageCalls).toBe(20);

  const commentItems = harness();
  const commentItemsThread = await importThread(commentItems);
  commentItems.gateway.oversizedCommentPage = true;
  await expect(runLinearCommand(["plan", commentItemsThread], commentItems.dependencies))
    .rejects.toThrow("Linear list_comments exceeded 5000 comments");

  const issues = harness();
  const issuesThread = await importThread(issues);
  await runLinearCommand(["sync", issuesThread, "--apply"], issues.dependencies);
  issues.gateway.issue = { ...issues.gateway.issue, id: "NEW-1" };
  issues.gateway.rejectOldKey = true;
  issues.gateway.infiniteIssuePages = true;
  await expect(runLinearCommand(["plan", issuesThread], issues.dependencies))
    .rejects.toThrow("Linear list_issues exceeded 20 pages");
  expect(issues.gateway.issuePageCalls).toBe(20);

  const issueItems = harness();
  const issueItemsThread = await importThread(issueItems);
  await runLinearCommand(["sync", issueItemsThread, "--apply"], issueItems.dependencies);
  issueItems.gateway.issue = { ...issueItems.gateway.issue, id: "NEW-1" };
  issueItems.gateway.rejectOldKey = true;
  issueItems.gateway.oversizedIssueCandidates = true;
  await expect(runLinearCommand(["plan", issueItemsThread], issueItems.dependencies))
    .rejects.toThrow("managed Linear backlink resolution exceeded 25 candidates");
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

test("marker relocation rejects duplicate issue keys before last-write-wins collection", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  h.gateway.issue = { ...h.gateway.issue, id: "NEW-1" };
  h.gateway.rejectOldKey = true;
  h.gateway.duplicateIssueKey = true;
  await expect(runLinearCommand(["plan", thread], h.dependencies))
    .rejects.toThrow("duplicate issue key NEW-1");
});

test("doctor bootstraps graph schema exactly once; get stays read-only and irrelevant flags fail closed", async () => {
  const h = harness();
  const first = await runLinearCommand(["doctor"], h.dependencies);
  expect(first).toMatchObject({
    graphSchema: { ok: true, missing: [], conflicting: [] },
    graphSchemaBootstrap: { applied: true, assertions: 19 },
  });
  expect(h.graph.writes).toHaveLength(19);
  expect(h.graph.bulkReads).toBe(2);
  expect(h.graph.showReads).toBe(0);
  const readsBeforeSecondDoctor = h.graph.bulkReads;
  const second = await runLinearCommand(["doctor"], h.dependencies);
  expect(second).toMatchObject({
    graphSchema: { ok: true, missing: [], conflicting: [] },
    graphSchemaBootstrap: { applied: false, assertions: 0 },
  });
  expect(h.graph.writes).toHaveLength(19);
  expect(h.graph.bulkReads - readsBeforeSecondDoctor).toBe(1);
  expect(h.graph.showReads).toBe(0);
  const beforeGet = h.graph.writes.length;
  await runLinearCommand(["get", "MSA-236"], h.dependencies);
  expect(h.graph.writes).toHaveLength(beforeGet);
  await expect(runLinearCommand(["get", "MSA-236", "--apply"], h.dependencies)).rejects.toThrow("accepts only --server");
  await expect(runLinearCommand(["plan", "x", "--dry-run"], h.dependencies)).rejects.toThrow("accepts only --server");
});

test("doctor reports schema conflicts without overwriting them", async () => {
  const h = harness();
  h.graph.seed("linked_thread", "cardinality", "multi");
  const result = await runLinearCommand(["doctor"], h.dependencies);
  expect(result).toMatchObject({
    graphSchema: { ok: false, conflicting: ["@linked_thread cardinality: multi"] },
    graphSchemaBootstrap: { applied: false, assertions: 0 },
  });
  expect(h.graph.writes).toHaveLength(0);
});

test("doctor mechanically migrates the adapter-owned integration handle from literal to entity ref", async () => {
  const h = harness();
  h.graph.seed("linear_link", "value_kind", "literal");
  const result = await runLinearCommand(["doctor"], h.dependencies);
  expect(result).toMatchObject({
    graphSchema: { ok: true, missing: [], conflicting: [] },
    graphSchemaBootstrap: { applied: true, assertions: 19 },
  });
  expect((await h.graph.show("linear_link")).filter(({ predicate }) => predicate === "value_kind"))
    .toEqual([{ predicate: "value_kind", value: "ref" }]);
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

test("NorthGraphStore reads a multi-subject graph snapshot with one CLI process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-linear-bulk-"));
  try {
    const north = join(directory, "north");
    const fram = join(directory, "fram");
    const calls = join(directory, "calls");
    writeFileSync(north, `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
printf '%s\\n' '[{"subject":"linked_thread","predicate":"cardinality","value":"single"},{"subject":"linear_link","predicate":"value_kind","value":"ref"}]'
`);
    writeFileSync(fram, "#!/bin/sh\nexit 1\n");
    chmodSync(north, 0o700);
    chmodSync(fram, 0o700);
    const rows = await new NorthGraphStore(north, fram).showMany(["@linked_thread", "linear_link"]);
    expect(rows.get("linked_thread")).toEqual([{ predicate: "cardinality", value: "single" }]);
    expect(rows.get("linear_link")).toEqual([{ predicate: "value_kind", value: "ref" }]);
    expect(readFileSync(calls, "utf8").trim()).toBe("json show-many linked_thread,linear_link");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
