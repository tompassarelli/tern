import { AppServerMcpBroker } from "./app-server-broker";
import { openLinearGateway, type LinearGateway } from "./gateway";
import {
  CoordinatorSyncLeaseManager, NorthGraphStore, assertImportableDescription, baselineFromRemote,
  createImportedThread, ensureLinearLinkFacts, ensureLinearSchema, identityForIssue,
  inspectLinearSchema, inspectPartialLinearLink, isKnownLinearSchemaMigration, issueSnapshot,
  linkSubject, loadLinkBySubject, loadLinkForThread, loadNorthThread, markerForThread,
  northThreadIdForIdentity, normalizeLinearIssueDocument, writeManifest, LINEAR_SYNC_LEASE_TTL_MS,
} from "./north-state";
import type {
  GraphStore, LinearIssueDocument, LinearLinkState, LinearSyncManifest, SyncLease,
  SyncLeaseManager,
} from "./north-state";
import { canonicalJson, normalizeBody, sha256Canonical, sha256Text } from "./normalize";
import {
  indexManagedLinearComments, managedLinearDescriptionReceiptHash, projectNorthThread,
  replaceManagedLinearDescription,
} from "./projection";
import { createLinearSyncBaseline, reconcileLinearIssue } from "./reconcile";
import type {
  LinearApplyPlan, LinearIssueIdentity, LinearRemoteComment, LinearReconciliationResult,
  LinearThreadProjection,
} from "./types";

const HELP = `north linear — deterministic North ↔ Linear projection

  north linear doctor [--server NAME]
  north linear get <KEY> [--server NAME]
  north linear import <KEY> [--owner X] [--thread ID] [--dry-run] [--server NAME]
  north linear plan <THREAD> [--server NAME]
  north linear sync <THREAD> [--apply] [--server NAME]

North is canonical. plan and sync without --apply are read-only. Only sync --apply writes Linear.`;

const MAX_LINEAR_PAGES = 20;
const MAX_LINEAR_COMMENTS = 5_000;
const MAX_BACKLINK_CANDIDATES = 25;
export const LINEAR_MCP_CALL_TIMEOUT_MS = 20_000;
export const LINEAR_LEASE_TIMEOUT_SAFETY_FACTOR = 10;

export interface LinearCliDependencies {
  graph: GraphStore;
  leases: SyncLeaseManager;
  openGateway(options: { server?: string }): Promise<LinearGateway>;
  now(): Date;
  mintThreadId(identity: LinearIssueIdentity): string;
}

function defaults(): LinearCliDependencies {
  if (LINEAR_SYNC_LEASE_TTL_MS < LINEAR_MCP_CALL_TIMEOUT_MS * LINEAR_LEASE_TIMEOUT_SAFETY_FACTOR)
    throw new Error("Linear sync lease TTL no longer safely dominates the bounded MCP call timeout");
  return {
    graph: new NorthGraphStore(), leases: new CoordinatorSyncLeaseManager(),
    openGateway: ({ server }) => openLinearGateway(
      new AppServerMcpBroker({ timeoutMs: LINEAR_MCP_CALL_TIMEOUT_MS }),
      { server },
    ),
    now: () => new Date(), mintThreadId: (identity) => northThreadIdForIdentity(identity),
  };
}

interface ParsedOptions {
  positional: string[];
  server?: string;
  owner?: string;
  thread?: string;
  dryRun: boolean;
  apply: boolean;
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const result: ParsedOptions = { positional: [], dryRun: false, apply: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--apply") result.apply = true;
    else if (["--server", "--owner", "--thread"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--server") result.server = value;
      else if (arg === "--owner") result.owner = value;
      else result.thread = value.replace(/^@/, "");
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else result.positional.push(arg);
  }
  return result;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`);
  return value as Record<string, unknown>;
}

function normalizeComments(input: unknown): { comments: LinearRemoteComment[]; nextCursor?: string; hasNextPage: boolean } {
  const raw = record(input, "Linear list_comments result");
  const values = raw.comments;
  if (!Array.isArray(values)) throw new Error("Linear list_comments result lacks comments");
  const comments = values.map((value) => {
    const comment = record(value, "Linear comment");
    if (typeof comment.id !== "string" || !comment.id.trim()) throw new Error("Linear comment lacks a non-blank id");
    if (typeof comment.body !== "string") throw new Error(`Linear comment ${comment.id} lacks a string body`);
    return { id: comment.id, body: comment.body };
  });
  return {
    comments, nextCursor: typeof raw.cursor === "string" ? raw.cursor
      : typeof raw.nextCursor === "string" ? raw.nextCursor : undefined,
    hasNextPage: raw.hasNextPage === true,
  };
}

async function allComments(
  gateway: LinearGateway,
  key: string,
  heartbeat?: () => Promise<void>,
): Promise<LinearRemoteComment[]> {
  const comments: LinearRemoteComment[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 1; pageNumber <= MAX_LINEAR_PAGES; pageNumber++) {
    await heartbeat?.();
    const page = normalizeComments(await gateway.listComments({ issueId: key, limit: 250, ...(cursor ? { cursor } : {}) }));
    comments.push(...page.comments);
    if (comments.length > MAX_LINEAR_COMMENTS)
      throw new Error(`Linear list_comments exceeded ${MAX_LINEAR_COMMENTS} comments`);
    if (!page.hasNextPage && !page.nextCursor) return comments;
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Linear list_comments returned an invalid pagination cursor");
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  throw new Error(`Linear list_comments exceeded ${MAX_LINEAR_PAGES} pages`);
}

function normalizeIssueList(input: unknown): { issues: LinearIssueDocument[]; nextCursor?: string; hasNextPage: boolean } {
  const raw = record(input, "Linear list_issues result");
  if (!Array.isArray(raw.issues)) throw new Error("Linear list_issues result lacks issues");
  return {
    issues: raw.issues.map(normalizeLinearIssueDocument),
    nextCursor: typeof raw.cursor === "string" ? raw.cursor
      : typeof raw.nextCursor === "string" ? raw.nextCursor : undefined,
    hasNextPage: raw.hasNextPage === true,
  };
}

function identityMatchesEvidence(issue: LinearIssueDocument, link: LinearLinkState): boolean {
  if (issue.createdAt !== link.manifest.evidence.createdAt) return false;
  if (link.identity.identityKind === "linear-uuid") return issue.uuid === link.identity.issueId;
  return sha256Canonical({
    connector: link.manifest.evidence.connector,
    createdAt: issue.createdAt,
    initialKey: link.manifest.evidence.initialKey,
  }) === link.identity.fingerprint;
}

async function searchByManagedBacklink(
  gateway: LinearGateway,
  link: LinearLinkState,
  heartbeat?: () => Promise<void>,
): Promise<LinearIssueDocument> {
  const candidates = new Map<string, LinearIssueDocument>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  const query = `North thread @${link.threadId}`;
  for (let pageNumber = 1; pageNumber <= MAX_LINEAR_PAGES; pageNumber++) {
    await heartbeat?.();
    const page = normalizeIssueList(await gateway.listIssues({ query, limit: 250, ...(cursor ? { cursor } : {}) }));
    for (const issue of page.issues) {
      if (candidates.has(issue.key))
        throw new Error(`Linear list_issues returned duplicate issue key ${issue.key}`);
      candidates.set(issue.key, issue);
    }
    if (candidates.size > MAX_BACKLINK_CANDIDATES)
      throw new Error(`managed Linear backlink resolution exceeded ${MAX_BACKLINK_CANDIDATES} candidates`);
    if (!page.hasNextPage && !page.nextCursor) break;
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Linear list_issues returned an invalid pagination cursor");
    cursor = page.nextCursor;
    seen.add(cursor);
    if (pageNumber === MAX_LINEAR_PAGES)
      throw new Error(`Linear list_issues exceeded ${MAX_LINEAR_PAGES} pages`);
  }
  const exact: LinearIssueDocument[] = [];
  for (const candidate of candidates.values()) {
    await heartbeat?.();
    const full = normalizeLinearIssueDocument(await gateway.readIssue({ id: candidate.key }));
    if (full.description.includes(markerForThread(link.threadId)) && identityMatchesEvidence(full, link)) exact.push(full);
  }
  if (exact.length !== 1)
    throw new Error(`managed Linear backlink resolution found ${exact.length} exact issue(s); refusing ambiguous or missing link`);
  return exact[0]!;
}

async function resolveLinkedIssue(
  gateway: LinearGateway,
  link: LinearLinkState,
  heartbeat?: () => Promise<void>,
): Promise<LinearIssueDocument> {
  await heartbeat?.();
  let rawIssue: unknown;
  try {
    rawIssue = await gateway.readIssue({ id: link.remoteKey });
  } catch {
    if (!link.manifest.evidence.markerBound)
      throw new Error("stored Linear key could not be verified before backlink adoption");
    return searchByManagedBacklink(gateway, link, heartbeat);
  }
  const issue = normalizeLinearIssueDocument(rawIssue);
  const identityMoved = !identityMatchesEvidence(issue, link);
  const backlinkMoved = link.manifest.evidence.markerBound
    && !issue.description.includes(markerForThread(link.threadId));
  if (identityMoved || backlinkMoved) {
    if (!link.manifest.evidence.markerBound)
      throw new Error("stored Linear key could not be verified before backlink adoption");
    return searchByManagedBacklink(gateway, link, heartbeat);
  }
  return issue;
}

async function readRemote(gateway: LinearGateway, link: LinearLinkState, lease?: SyncLease) {
  const heartbeat = lease ? () => lease.renew() : undefined;
  const issue = await resolveLinkedIssue(gateway, link, heartbeat);
  return { issue, comments: await allComments(gateway, issue.key, heartbeat) };
}

function leaseResource(link: LinearLinkState): string {
  return leaseResourceForIdentity(link.remoteServer, link.identity);
}

function leaseResourceForIdentity(server: string, identity: LinearIssueIdentity): string {
  return `linear-sync:${encodeURIComponent(server)}:${identity.identityKind === "linear-uuid" ? identity.issueId : identity.fingerprint}`;
}

async function renewAndPut(
  graph: GraphStore,
  lease: SyncLease,
  subject: string,
  predicate: string,
  value: string,
): Promise<void> {
  await lease.renew();
  await graph.putFenced(lease, subject, predicate, value);
}

async function releaseLeaseWithoutMaskingFailure(lease: SyncLease, operationCompleted: boolean): Promise<void> {
  try { await lease.release(); }
  catch (error) {
    if (operationCompleted) throw error;
  }
}

function verifyPreparedManifest(
  manifest: LinearSyncManifest, identity: LinearIssueIdentity, threadId: string,
  issue: LinearIssueDocument, server: string,
): void {
  if (canonicalJson(manifest.baseline.identity) !== canonicalJson(identity)
      || manifest.baseline.threadId !== threadId
      || manifest.evidence.connector !== server
      || manifest.evidence.createdAt !== issue.createdAt
      || manifest.evidence.initialKey !== issue.key)
    throw new Error("prepared Linear link manifest does not match the current import identity/thread evidence");
  if (manifest.phase === "prepared" && manifest.evidence.createdThread
      && (manifest.evidence.importedTitleHash !== sha256Text(issue.title)
        || manifest.evidence.importedRawDescriptionHash !== sha256Text(issue.description)))
    throw new Error("Linear title/description changed during a partially prepared import; refusing unstable thread seeding");
}

async function importIssue(
  key: string, options: ParsedOptions, gateway: LinearGateway, deps: LinearCliDependencies,
): Promise<unknown> {
  const issue = normalizeLinearIssueDocument(await gateway.readIssue({ id: key }));
  const identity = identityForIssue(issue, gateway.server);
  const subject = linkSubject(identity);
  const partial = await inspectPartialLinearLink(deps.graph, subject);
  if (partial.manifest && partial.threadId)
    verifyPreparedManifest(partial.manifest, identity, partial.threadId, issue, gateway.server);
  let existing: LinearLinkState | null = null;
  if (partial.complete) existing = await loadLinkBySubject(deps.graph, subject);
  if (options.dryRun) {
    return {
      command: "import", dryRun: true, server: gateway.server, key: issue.key, identity,
      link: `@${subject}`, thread: `@${existing?.threadId ?? partial.threadId ?? options.thread ?? deps.mintThreadId(identity)}`,
      actions: existing ? ["reuse-link"] : partial.exists ? ["heal-link", "heal-thread", "write-compatibility-alias"]
        : ["prepare-link", options.thread ? "adopt-thread" : "mint-thread", "write-compatibility-alias"],
    };
  }

  const lease = await deps.leases.acquire(leaseResourceForIdentity(gateway.server, identity));
  let operationCompleted = false;
  try {
    await ensureLinearSchema(deps.graph);
    await lease.renew();
    const freshIssue = normalizeLinearIssueDocument(await gateway.readIssue({ id: key }));
    const freshIdentity = identityForIssue(freshIssue, gateway.server);
    if (canonicalJson(freshIdentity) !== canonicalJson(identity)) throw new Error("Linear issue identity changed during import");
    const partialNow = await inspectPartialLinearLink(deps.graph, subject);
    const threadId = partialNow.threadId ?? options.thread ?? deps.mintThreadId(identity);
    if (options.thread && threadId !== options.thread)
      throw new Error(`Linear issue is already prepared for @${threadId}, not @${options.thread}`);
    const currentThread = await deps.graph.show(threadId);
    const otherLinks = [...new Set(currentThread.filter((fact) => fact.predicate === "linear_link")
      .map((fact) => fact.value.replace(/^@/, "")))];
    if (otherLinks.length && (otherLinks.length !== 1 || otherLinks[0] !== subject))
      throw new Error(`requested North thread @${threadId} already has a different canonical Linear link`);

    let manifest = partialNow.manifest;
    let createdThread = manifest?.evidence.createdThread ?? !options.thread;
    if (!manifest) {
      assertImportableDescription(freshIssue.description);
      if (options.thread && !currentThread.some((fact) => fact.predicate === "title"))
        throw new Error(`requested North thread @${threadId} does not exist`);
      createdThread = !options.thread;
      const baseline = createdThread
        ? createLinearSyncBaseline(identity, threadId, {
          title: freshIssue.title, body: freshIssue.description, doneWhen: [], barEvidence: [], repos: [], lifecycle: "ready",
        })
        : baselineFromRemote(freshIssue, identity, threadId);
      manifest = {
        version: 1, phase: "prepared", baseline,
        evidence: {
          connector: gateway.server, createdAt: freshIssue.createdAt, initialKey: freshIssue.key,
          workspace: freshIssue.workspace, markerBound: false,
          importedAt: deps.now().toISOString(), createdThread, owner: options.owner ?? "personal",
          ...(createdThread ? {
            importedRawDescriptionHash: sha256Text(freshIssue.description), importedTitleHash: sha256Text(freshIssue.title),
            adoptRawDescription: true,
          } : {}),
        }, receipts: {},
      };
    }
    verifyPreparedManifest(manifest, identity, threadId, freshIssue, gateway.server);
    const expected: LinearLinkState = {
      subject, identity, threadId, remoteKey: freshIssue.key, remoteScope: freshIssue.teamId ?? "",
      remoteWorkspaceSlug: freshIssue.workspace, remoteServer: gateway.server, manifest,
    };
    // The prepared manifest is asserted first; ensureLinearLinkFacts heals any
    // crash after an arbitrary subset of the remaining individual assertions.
    await lease.renew();
    const link = await ensureLinearLinkFacts(deps.graph, lease, expected);

    const threadFacts = await deps.graph.show(link.threadId);
    const threadHasTitle = threadFacts.some((fact) => fact.predicate === "title");
    if (link.manifest.evidence.createdThread
        && (link.manifest.phase === "prepared" || !threadHasTitle)) {
      if (!link.manifest.evidence.importedAt)
        throw new Error(`imported Linear link lacks the timestamp needed to recreate @${link.threadId}`);
      await lease.renew();
      await createImportedThread(
        deps.graph, lease, link.threadId, freshIssue, link.manifest.evidence.owner ?? "personal",
        new Date(link.manifest.evidence.importedAt),
      );
      createdThread = true;
    } else if (!threadHasTitle)
      throw new Error(`canonical link points to missing pre-existing thread @${link.threadId}`);
    await renewAndPut(deps.graph, lease, link.threadId, "linear", freshIssue.key);
    // Preserve the established opaque handle spelling as a true ref to the
    // fact-bearing integration-link entity; integration links are not threads.
    await renewAndPut(deps.graph, lease, link.threadId, "linear_link", `@${link.subject}`);
    if (link.manifest.phase !== "adopted") {
      await lease.renew();
      await writeManifest(deps.graph, lease, link, { ...link.manifest, phase: "adopted" });
    }
    // `partial` was observed before acquiring the identity lease. Another
    // importer may have completed while this caller waited, so public reuse
    // truth must come from the serialized, post-lease observation.
    const result = { command: "import", dryRun: false, reused: partialNow.exists, createdThread, server: gateway.server, key: freshIssue.key, identity, link: `@${link.subject}`, thread: `@${link.threadId}` };
    operationCompleted = true;
    return result;
  } finally {
    await releaseLeaseWithoutMaskingFailure(lease, operationCompleted);
  }
}

interface PlannedSync {
  link: LinearLinkState;
  issue: LinearIssueDocument;
  comments: LinearRemoteComment[];
  local: LinearThreadProjection;
  reconciliation: LinearReconciliationResult;
  plan: LinearApplyPlan | null;
  descriptionAdoption: boolean;
  descriptionMarkerPresent: boolean;
}

async function computePlan(
  thread: string,
  gateway: LinearGateway,
  graph: GraphStore,
  lease?: SyncLease,
): Promise<PlannedSync> {
  const link = await loadLinkForThread(graph, thread);
  if (link.remoteServer !== gateway.server)
    throw new Error(`Linear link requires MCP server ${link.remoteServer}, not ${gateway.server}`);
  const { issue, comments } = await readRemote(gateway, link, lease);
  const local = projectNorthThread(await loadNorthThread(graph, link.threadId));
  const reconciliation = reconcileLinearIssue({
    baseline: link.manifest.baseline, local, remote: issueSnapshot(issue, link.identity, comments),
    ensureDescriptionMarker: !link.manifest.evidence.markerBound,
    ...(link.manifest.evidence.adoptRawDescription ? {
      bootstrap: { importedRawDescriptionHash: link.manifest.evidence.importedRawDescriptionHash! },
    } : {}),
  });
  return {
    link, issue, comments, local, reconciliation, plan: reconciliation.plan,
    descriptionAdoption: Boolean(!link.manifest.evidence.markerBound && reconciliation.plan?.issue.description),
    descriptionMarkerPresent: issue.description.includes(markerForThread(link.threadId)),
  };
}

function publicPlan(planned: PlannedSync): unknown {
  return {
    command: "plan", thread: `@${planned.link.threadId}`, link: `@${planned.link.subject}`,
    server: planned.link.remoteServer, key: planned.issue.key, state: planned.reconciliation.state,
    conflicts: planned.reconciliation.conflicts.map(({ field, category }) => ({ field, category })),
    diagnostics: planned.reconciliation.diagnostics,
    actions: planned.plan ? {
      issue: Object.keys(planned.plan.issue).sort(),
      comments: planned.plan.comments.map(({ action, marker }) => ({ action, marker })),
      descriptionAdoption: planned.descriptionAdoption,
      hash: planned.plan.hash,
    } : [],
  };
}

function issueOperationSatisfied(pending: NonNullable<LinearSyncManifest["pending"]>, issue: LinearIssueDocument): boolean {
  if (pending.titleHash !== undefined && pending.titleHash !== sha256Canonical(issue.title)) return false;
  if (pending.descriptionHash === undefined) return true;
  if (pending.descriptionHash === sha256Canonical(issue.description)) return true;
  if (!pending.descriptionReceiptHash || !pending.baselineAfter) return false;
  try {
    return pending.descriptionReceiptHash
      === managedLinearDescriptionReceiptHash(issue.description, pending.baselineAfter.threadId);
  } catch {
    return false;
  }
}

/**
 * Recover the one legacy pending shape emitted before description receipt
 * hashes existed. Reconstructing the exact original payload from the current
 * local fields and the remote's byte-identical unmanaged text must reproduce
 * the persisted payload hash; the managed block must then match under only the
 * bridge-scaffold normalization accepted by the v1 receipt.
 */
async function legacyNormalizedIssueOperationSatisfied(
  pending: NonNullable<LinearSyncManifest["pending"]>,
  issue: LinearIssueDocument,
  graph: GraphStore,
  link: LinearLinkState,
): Promise<boolean> {
  if (pending.descriptionReceiptHash || !pending.descriptionHash || !pending.baselineAfter) return false;
  if (pending.titleHash !== undefined && pending.titleHash !== sha256Canonical(issue.title)) return false;
  try {
    const local = projectNorthThread(await loadNorthThread(graph, link.threadId));
    const localBaseline = createLinearSyncBaseline(link.identity, link.threadId, local.fields);
    if (localBaseline.hash !== pending.baselineAfter.hash) return false;
    const reconstructedDescription = replaceManagedLinearDescription(
      issue.description, link.threadId, local.fields,
    );
    const reconstructedPayload: Record<string, unknown> = {};
    if (pending.titleHash !== undefined) reconstructedPayload.title = local.fields.title;
    reconstructedPayload.description = reconstructedDescription;
    if (sha256Canonical(reconstructedPayload) !== pending.payloadHash) return false;
    return managedLinearDescriptionReceiptHash(reconstructedDescription, link.threadId)
      === managedLinearDescriptionReceiptHash(issue.description, link.threadId);
  } catch {
    return false;
  }
}

function commentOperationSatisfied(
  pending: NonNullable<LinearSyncManifest["pending"]>,
  comments: ReadonlyMap<string, LinearRemoteComment>,
): string | undefined {
  const found = pending.marker ? comments.get(pending.marker) : undefined;
  if (!found || pending.bodyHash !== sha256Canonical(normalizeBody(found.body))) return undefined;
  return found?.id;
}

async function confirmOrRefusePending(
  gateway: LinearGateway, graph: GraphStore, lease: SyncLease, link: LinearLinkState, now: Date,
): Promise<LinearSyncManifest> {
  const pending = link.manifest.pending;
  if (!pending) return link.manifest;
  await lease.renew();
  const { issue, comments } = await readRemote(gateway, link, lease);
  const indexedComments = indexManagedLinearComments(comments);
  const issueSatisfied = pending.kind === "issue"
    && (issueOperationSatisfied(pending, issue)
      || await legacyNormalizedIssueOperationSatisfied(pending, issue, graph, link));
  const remoteId = pending.kind === "issue"
    ? issueSatisfied ? issue.key : undefined
    : commentOperationSatisfied(pending, indexedComments);
  if (!remoteId) throw new Error(`prior ${pending.kind} write has unknown outcome and is not observable; refusing to retry`);
  const receipts = { ...(link.manifest.receipts ?? {}), [pending.key]: { confirmedAt: now.toISOString(), remoteId } };
  const markerAdopted = pending.kind === "issue" && pending.descriptionHash !== undefined;
  const confirmed: LinearSyncManifest = {
    ...link.manifest, pending: undefined, receipts,
    ...(pending.baselineAfter ? { baseline: pending.baselineAfter } : {}),
    ...(markerAdopted ? { evidence: { ...link.manifest.evidence, markerBound: true, adoptRawDescription: false } } : {}),
  };
  await lease.renew();
  await writeManifest(graph, lease, link, confirmed);
  return confirmed;
}

async function applyOperation(
  gateway: LinearGateway, graph: GraphStore, lease: SyncLease, link: LinearLinkState,
  manifest: LinearSyncManifest,
  kind: "issue" | "comment", key: string, payload: Record<string, unknown>, marker: string | undefined,
  now: Date,
  onConfirmed?: (manifest: LinearSyncManifest) => LinearSyncManifest,
  baselineAfter?: LinearApplyPlan["expectedBaseline"],
): Promise<{ remoteId: string; manifest: LinearSyncManifest }> {
  const pending = {
    key, kind, payloadHash: sha256Canonical(payload),
    ...(typeof payload.title === "string" ? { titleHash: sha256Canonical(payload.title) } : {}),
    ...(typeof payload.description === "string" ? { descriptionHash: sha256Canonical(payload.description) } : {}),
    ...(typeof payload.description === "string"
      ? { descriptionReceiptHash: managedLinearDescriptionReceiptHash(payload.description, link.threadId) } : {}),
    ...(typeof payload.body === "string" ? { bodyHash: sha256Canonical(normalizeBody(payload.body)) } : {}),
    ...(baselineAfter ? { baselineAfter } : {}),
    ...(marker ? { marker } : {}), startedAt: now.toISOString(),
  } as const;
  const prepared: LinearSyncManifest = { ...manifest, pending };
  await lease.renew();
  await writeManifest(graph, lease, link, prepared);
  await lease.renew();
  try {
    if (kind === "issue") await gateway.writeIssue({ id: link.remoteKey, ...payload });
    else await gateway.writeComment(payload);
  } catch {
    // The call may have committed remotely before transport failure. Reconcile, never retry.
  }
  await lease.renew();
  const { issue, comments } = await readRemote(gateway, link, lease);
  const indexedComments = indexManagedLinearComments(comments);
  const remoteId = kind === "issue"
    ? issueOperationSatisfied(pending, issue) ? issue.key : undefined
    : commentOperationSatisfied(pending, indexedComments);
  if (!remoteId) throw new Error(`${kind} write outcome is unknown and not observable; intent retained, retry refused`);
  const receipts = { ...(prepared.receipts ?? {}), [key]: { confirmedAt: now.toISOString(), remoteId } };
  const confirmed: LinearSyncManifest = { ...prepared, pending: undefined, receipts };
  const nextManifest = onConfirmed ? onConfirmed(confirmed) : confirmed;
  await lease.renew();
  await writeManifest(graph, lease, link, nextManifest);
  return { remoteId, manifest: nextManifest };
}

async function applySync(thread: string, gateway: LinearGateway, deps: LinearCliDependencies): Promise<unknown> {
  const initialLink = await loadLinkForThread(deps.graph, thread);
  const lease = await deps.leases.acquire(leaseResource(initialLink));
  let operationCompleted = false;
  try {
    await ensureLinearSchema(deps.graph);
    const link = await loadLinkForThread(deps.graph, thread);
    let manifest = await confirmOrRefusePending(gateway, deps.graph, lease, link, deps.now());
    await lease.renew();
    const planned = await computePlan(thread, gateway, deps.graph, lease);
    await lease.renew();
    if (planned.reconciliation.conflicts.length)
      throw new Error(`Linear sync conflict: ${planned.reconciliation.conflicts.map(({ field, category }) => `${field}:${category}`).join(", ")}`);
    if (planned.issue.key !== link.remoteKey)
      await renewAndPut(deps.graph, lease, link.subject, "remote_key", planned.issue.key);
    if (planned.issue.workspace !== link.remoteWorkspaceSlug)
      await renewAndPut(deps.graph, lease, link.subject, "remote_workspace_slug", planned.issue.workspace);
    if (planned.issue.teamId && planned.issue.teamId !== link.remoteScope)
      await renewAndPut(deps.graph, lease, link.subject, "remote_scope", planned.issue.teamId);
    link.remoteKey = planned.issue.key;
    link.remoteWorkspaceSlug = planned.issue.workspace;
    if (planned.issue.teamId) link.remoteScope = planned.issue.teamId;
    let writes = 0;
    if (planned.plan && Object.keys(planned.plan.issue).length) {
      const adoptsMarker = planned.plan.issue.description !== undefined;
      const applied = await applyOperation(
        gateway, deps.graph, lease, link, manifest, "issue", `${planned.plan.hash}:issue`, { ...planned.plan.issue }, undefined, deps.now(),
        (manifest) => adoptsMarker ? {
          ...manifest, baseline: planned.plan!.expectedBaseline,
          evidence: { ...manifest.evidence, markerBound: true, adoptRawDescription: false },
        } : manifest,
        planned.plan.expectedBaseline,
      );
      manifest = applied.manifest;
      writes++;
    }
    for (const [index, comment] of (planned.plan?.comments ?? []).entries()) {
      const payload = comment.action === "create"
        ? { issueId: link.remoteKey, body: comment.body }
        : { id: comment.commentId, body: comment.body };
      const applied = await applyOperation(
        gateway, deps.graph, lease, link, manifest, "comment",
        `${planned.plan!.hash}:comment:${index}`, payload, comment.marker, deps.now(),
      );
      manifest = applied.manifest;
      writes++;
    }
    const baseline = planned.plan?.expectedBaseline
      ?? planned.reconciliation.nextBaseline
      ?? createLinearSyncBaseline(link.identity, link.threadId, planned.local.fields);
    const finalized: LinearSyncManifest = {
      ...manifest, phase: "adopted", baseline, pending: undefined,
      evidence: {
        ...manifest.evidence,
        markerBound: manifest.evidence.markerBound || planned.descriptionMarkerPresent || Boolean(planned.plan?.issue.description),
      },
    };
    if (canonicalJson(finalized) !== canonicalJson(manifest)) {
      await lease.renew();
      await writeManifest(deps.graph, lease, link, finalized);
    }
    if (writes > 0)
      await renewAndPut(deps.graph, lease, link.subject, "last_synced_at", deps.now().toISOString());
    const result = { command: "sync", applied: true, thread: `@${link.threadId}`, link: `@${link.subject}`, writes, state: "in-sync", planHash: planned.plan?.hash ?? null };
    operationCompleted = true;
    return result;
  } finally {
    await releaseLeaseWithoutMaskingFailure(lease, operationCompleted);
  }
}

export async function runLinearCommand(argv: readonly string[], dependencies: Partial<LinearCliDependencies> = {}): Promise<unknown> {
  const deps = { ...defaults(), ...dependencies } as LinearCliDependencies;
  const [verb = "help", ...rest] = argv;
  if (["help", "-h", "--help"].includes(verb)) return { help: HELP };
  const options = parseOptions(rest);
  const required = (name: string) => {
    if (options.positional.length !== 1) throw new Error(`${name} requires exactly one argument`);
    return options.positional[0]!;
  };
  const reject = (condition: boolean, message: string) => { if (condition) throw new Error(message); };
  if (verb === "doctor") {
    reject(options.positional.length > 0, "doctor takes no positional arguments");
    reject(options.apply || options.dryRun || Boolean(options.owner || options.thread), "doctor accepts only --server");
  } else if (verb === "get") {
    required("get");
    reject(options.apply || options.dryRun || Boolean(options.owner || options.thread), "get accepts only --server");
  } else if (verb === "import") {
    required("import");
    reject(options.apply, "import does not accept --apply");
  } else if (verb === "plan") {
    required("plan");
    reject(options.apply || options.dryRun || Boolean(options.owner || options.thread), "plan accepts only --server");
  } else if (verb === "sync") {
    required("sync");
    reject(options.dryRun || Boolean(options.owner || options.thread), "sync accepts only --apply and --server");
  } else throw new Error(`unknown north linear verb ${verb}`);

  let server = options.server;
  if (!server && (verb === "plan" || verb === "sync"))
    server = (await loadLinkForThread(deps.graph, options.positional[0]!)).remoteServer;
  const gateway = await deps.openGateway({ server });
  let result: unknown;
  try {
    if (verb === "doctor") {
      const schemaBefore = await inspectLinearSchema(deps.graph);
      // Schema-as-facts is adapter-owned infrastructure, not user data. A
      // fresh North graph must become usable from the same command that
      // diagnoses it; requiring a separate hand-seeding incantation makes the
      // bridge depend on hidden setup state. Conflicts remain diagnostic and
      // are never overwritten.
      const migratable = isKnownLinearSchemaMigration(schemaBefore);
      if (!schemaBefore.conflicting.length || migratable) await ensureLinearSchema(deps.graph, schemaBefore);
      const schema = schemaBefore.ok || (schemaBefore.conflicting.length && !migratable)
        ? schemaBefore : await inspectLinearSchema(deps.graph);
      result = {
        command: "doctor", server: gateway.server, oauth: true, modelTurn: false,
        identityMode: "mcp-bootstrap-v1", identityLimitation: "connector omits native workspace and issue UUIDs; managed backlink + createdAt fingerprint",
        graphSchemaBootstrap: {
          applied: !schemaBefore.ok && (!schemaBefore.conflicting.length || migratable),
          assertions: schemaBefore.conflicting.length && !migratable ? 0 : schemaBefore.missing.length,
        },
        graphSchema: schema,
      };
    } else if (verb === "get") {
      const issue = normalizeLinearIssueDocument(await gateway.readIssue({ id: required("get") }));
      result = { command: "get", server: gateway.server, issue, identity: identityForIssue(issue, gateway.server) };
    } else if (verb === "import") result = await importIssue(required("import"), options, gateway, deps);
    else if (verb === "plan") result = publicPlan(await computePlan(required("plan"), gateway, deps.graph));
    else if (verb === "sync") {
      const thread = required("sync");
      result = options.apply
        ? await applySync(thread, gateway, deps)
        : publicPlan(await computePlan(thread, gateway, deps.graph));
    } else throw new Error(`unknown north linear verb ${verb}`);
  } finally { await gateway.close(); }
  return { ...record(result, "Linear command result"), transportReceipt: gateway.transportReceipt() };
}

if (import.meta.main) {
  runLinearCommand(process.argv.slice(2)).then((result) => {
    if (typeof (result as { help?: unknown }).help === "string") console.log((result as { help: string }).help);
    else console.log(canonicalJson(result));
  }).catch((error) => {
    console.error(`north linear: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
