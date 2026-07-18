import { AppServerMcpBroker } from "./app-server-broker";
import { LinearGatewayError, openLinearGateway, type LinearGateway } from "./gateway";
import {
  CoordinatorSyncLeaseManager, NorthGraphStore, assertImportableDescription, baselineFromRemote,
  createImportedThread, ensureLinearLinkFacts, ensureLinearSchema, identityForIssue,
  inspectLinearSchema, inspectPartialLinearLink, isKnownLinearSchemaMigration, issueSnapshot,
  legacyBootstrapIdentityForIssue,
  linearManifestNeedsReceiptCompaction, linkSubject, loadLinkBySubject, loadLinkForThread, loadNorthThread, markerForThread,
  northThreadIdForIdentity, normalizeLinearIssueDocument, writeManifest, LINEAR_SYNC_LEASE_TTL_MS,
  recordLinearReceipt,
} from "./north-state";
import type {
  GraphStore, LinearIssueDocument, LinearLinkState, LinearSyncManifest, PendingLinearOperation, SyncLease,
  SyncLeaseManager,
} from "./north-state";
import {
  canonicalJson, linearIdentityKey, normalizeBody, normalizeLinearConnector, normalizeThreadId,
  sha256Canonical, sha256Text,
} from "./normalize";
import {
  indexManagedLinearComments, managedLinearDescriptionReceiptHash, managedLinearThreadId, projectNorthThread,
  replaceManagedLinearDescription,
} from "./projection";
import { createLinearSyncBaseline, reconcileLinearIssue } from "./reconcile";
import type {
  LinearApplyPlan, LinearIssueIdentity, LinearRemoteComment, LinearReconciliationResult,
  LinearThreadProjection, ProjectedLinearComment,
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
      else result.thread = normalizeThreadId(value.replace(/^@/, ""));
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
    if (typeof comment.body !== "string") throw new Error("Linear comment lacks a string body");
    return { id: comment.id.trim(), body: comment.body };
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
  if (link.identity.identityKind === "linear-uuid")
    return issue.uuid === link.identity.issueId
      && issue.workspaceId?.toLowerCase() === link.identity.workspaceId;
  if (link.identity.identityKind === "mcp-bootstrap-v2")
    return sha256Canonical({
      connector: link.manifest.evidence.connector,
      createdAt: issue.createdAt,
    }) === link.identity.fingerprint;
  return sha256Canonical({
    connector: link.manifest.evidence.connector,
    createdAt: issue.createdAt,
    initialKey: link.manifest.evidence.initialKey,
  }) === link.identity.fingerprint;
}

function bootstrapEvidenceLeaseResource(issue: LinearIssueDocument, connector: string): string {
  return `linear-sync:bootstrap:${encodeURIComponent(sha256Canonical({
    connector,
    createdAt: issue.createdAt,
  }))}`;
}

function bootstrapEvidenceMatches(
  issue: LinearIssueDocument,
  link: LinearLinkState,
  connector: string,
): boolean {
  return link.identity.identityKind !== "linear-uuid"
    && link.remoteServer === connector
    && link.manifest.evidence.connector === connector
    && link.manifest.evidence.createdAt === issue.createdAt;
}

async function resolveImportIdentity(
  issue: LinearIssueDocument,
  connector: string,
  graph: GraphStore,
): Promise<{ identity: LinearIssueIdentity; markerThread: string | null }> {
  const candidate = identityForIssue(issue, connector);
  if (candidate.identityKind === "linear-uuid")
    return { identity: candidate, markerThread: null };

  const markerThread = managedLinearThreadId(issue.description);
  if (markerThread) {
    const link = await loadLinkForThread(graph, markerThread);
    if (!bootstrapEvidenceMatches(issue, link, connector))
      throw new Error("Linear managed marker does not prove the current bootstrap issue identity");
    return { identity: link.identity, markerThread };
  }

  const legacy = legacyBootstrapIdentityForIssue(issue, connector);
  for (const identity of [legacy, candidate]) {
    const partial = await inspectPartialLinearLink(graph, linkSubject(identity));
    if (!partial.exists) continue;
    const initialKey = partial.bootstrapInitialKey ?? partial.manifest?.evidence.initialKey;
    if (identity.identityKind === "mcp-bootstrap-v2" && !initialKey)
      throw new Error("partial Linear bootstrap-v2 link lacks immutable initial-key evidence");
    if (initialKey && initialKey !== issue.key)
      throw new Error("Linear bootstrap evidence collides with another key; an exact managed marker is required");
    if (partial.manifest
        && (partial.manifest.evidence.connector !== connector
          || partial.manifest.evidence.createdAt !== issue.createdAt))
      throw new Error("Linear bootstrap link evidence does not match the current issue");
    return { identity, markerThread: null };
  }

  const evidenceLinks = await graph.findBootstrapLinkSubjects(connector, issue.createdAt);
  if (evidenceLinks.length)
    throw new Error("Linear bootstrap evidence already exists under another identity; an exact managed marker is required");
  return { identity: candidate, markerThread: null };
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
  } catch (error) {
    if (!(error instanceof LinearGatewayError) || error.kind !== "not-found") throw error;
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
  const issue = await readRemoteIssue(gateway, link, lease);
  return { issue, comments: await allComments(gateway, issue.key, heartbeat) };
}

async function readRemoteIssue(
  gateway: LinearGateway,
  link: LinearLinkState,
  lease?: SyncLease,
): Promise<LinearIssueDocument> {
  return resolveLinkedIssue(gateway, link, lease ? () => lease.renew() : undefined);
}

function identityLeaseResource(identity: LinearIssueIdentity): string {
  return `linear-sync:identity:${encodeURIComponent(linearIdentityKey(identity))}`;
}

function threadLeaseResource(threadId: string): string {
  return `linear-sync:thread:${encodeURIComponent(normalizeThreadId(threadId))}`;
}

interface EndpointLeaseScope {
  readonly rawIdentity: SyncLease;
  readonly rawThread: SyncLease;
  readonly identity: SyncLease;
  readonly thread: SyncLease;
  renew(): Promise<void>;
}

function endpointLeaseScope(
  rawIdentity: SyncLease,
  rawThread: SyncLease,
  additional: readonly SyncLease[] = [],
): EndpointLeaseScope {
  const renew = async () => {
    for (const lease of additional) await lease.renew();
    await rawIdentity.renew();
    await rawThread.renew();
  };
  const guarded = (primary: SyncLease): SyncLease => ({
    get resource() { return primary.resource; },
    get holder() { return primary.holder; },
    get epoch() { return primary.epoch; },
    renew,
    fence: () => primary.fence(),
    release: () => primary.release(),
  });
  return {
    rawIdentity, rawThread, renew,
    identity: guarded(rawIdentity),
    thread: guarded(rawThread),
  };
}

async function leaseBoundary<T>(
  scope: Pick<EndpointLeaseScope, "renew">,
  action: () => Promise<T>,
): Promise<T> {
  await scope.renew();
  const result = await action();
  await scope.renew();
  return result;
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

async function releaseLeasesWithoutMaskingFailure(
  leases: readonly SyncLease[],
  operationCompleted: boolean,
): Promise<void> {
  let cleanupFailure: unknown;
  for (const lease of [...leases].reverse()) {
    try { await lease.release(); }
    catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (operationCompleted && cleanupFailure) throw cleanupFailure;
}

function assertSameLockedEndpoint(
  before: LinearLinkState,
  after: LinearLinkState,
  gateway: LinearGateway,
): void {
  const beforeEndpoint = {
    subject: before.subject,
    identity: linearIdentityKey(before.identity),
    threadId: before.threadId,
    remoteServer: before.remoteServer,
  };
  const afterEndpoint = {
    subject: after.subject,
    identity: linearIdentityKey(after.identity),
    threadId: after.threadId,
    remoteServer: after.remoteServer,
  };
  if (canonicalJson(beforeEndpoint) !== canonicalJson(afterEndpoint))
    throw new Error("canonical Linear identity/thread endpoint changed while its leases were being acquired");
  if (after.remoteServer !== gateway.server)
    throw new Error(`Linear link requires MCP server ${after.remoteServer}, not ${gateway.server}`);
}

function verifyPreparedManifest(
  manifest: LinearSyncManifest, identity: LinearIssueIdentity, threadId: string,
  issue: LinearIssueDocument, server: string,
): void {
  const provenMarkerThread = identity.identityKind === "linear-uuid"
    ? null : managedLinearThreadId(issue.description);
  if (canonicalJson(manifest.baseline.identity) !== canonicalJson(identity)
      || manifest.baseline.threadId !== threadId
      || manifest.evidence.connector !== server
      || manifest.evidence.createdAt !== issue.createdAt
      || (identity.identityKind !== "linear-uuid"
        && manifest.evidence.initialKey !== issue.key
        && provenMarkerThread !== threadId))
    throw new Error("prepared Linear link manifest does not match the current import identity/thread evidence");
  if (manifest.phase === "prepared" && manifest.evidence.createdThread
      && (manifest.evidence.importedTitleHash !== sha256Text(issue.title)
        || manifest.evidence.importedRawDescriptionHash !== sha256Text(issue.description)))
    throw new Error("Linear title/description changed during a partially prepared import; refusing unstable thread seeding");
}

function assertImportThreadPreconditions(
  options: ParsedOptions,
  threadId: string,
  subject: string,
  threadFacts: readonly { predicate: string; value: string }[],
  manifest: LinearSyncManifest | undefined,
  issue: LinearIssueDocument,
): void {
  if (options.thread && threadId !== options.thread)
    throw new Error(`Linear issue is already prepared for @${threadId}, not @${options.thread}`);
  const otherLinks = [...new Set(threadFacts.filter((fact) => fact.predicate === "linear_link")
    .map((fact) => fact.value.replace(/^@/, "")))];
  if (otherLinks.length && (otherLinks.length !== 1 || otherLinks[0] !== subject))
    throw new Error(`requested North thread @${threadId} already has a different canonical Linear link`);
  const hasTitle = threadFacts.some((fact) => fact.predicate === "title");
  if (!manifest) {
    assertImportableDescription(issue.description);
    if (options.thread && !hasTitle)
      throw new Error(`requested North thread @${threadId} does not exist`);
    if (!options.thread && hasTitle)
      throw new Error(`deterministic North thread @${threadId} already exists without its canonical Linear link`);
  } else if (!manifest.evidence.createdThread && !hasTitle) {
    throw new Error(`canonical link points to missing pre-existing thread @${threadId}`);
  }
}

async function importIssue(
  key: string, options: ParsedOptions, gateway: LinearGateway, deps: LinearCliDependencies,
): Promise<unknown> {
  const issue = normalizeLinearIssueDocument(await gateway.readIssue({ id: key }));
  const resolved = await resolveImportIdentity(issue, gateway.server, deps.graph);
  const identity = resolved.identity;
  const subject = linkSubject(identity);
  if (options.dryRun) {
    const schema = await inspectLinearSchema(deps.graph);
    const migratable = isKnownLinearSchemaMigration(schema);
    if (schema.conflicting.length && !migratable)
      throw new Error(`Linear graph schema conflicts: ${schema.conflicting.join("; ")}`);
    const freshIssue = normalizeLinearIssueDocument(await gateway.readIssue({ id: key }));
    const freshIdentity = (await resolveImportIdentity(
      freshIssue, gateway.server, deps.graph,
    )).identity;
    if (linearIdentityKey(freshIdentity) !== linearIdentityKey(identity))
      throw new Error("Linear issue identity changed during import");
    const latest = await inspectPartialLinearLink(deps.graph, subject);
    if (latest.manifest && latest.threadId)
      verifyPreparedManifest(
        latest.manifest,
        freshIdentity,
        latest.threadId,
        freshIssue,
        gateway.server,
      );
    const existing = latest.complete ? await loadLinkBySubject(deps.graph, subject) : null;
    const threadId = latest.threadId ?? options.thread ?? deps.mintThreadId(freshIdentity);
    const threadFacts = await deps.graph.show(threadId);
    assertImportThreadPreconditions(
      options, threadId, subject, threadFacts, latest.manifest, freshIssue,
    );
    const actions: string[] = [];
    if (!schema.ok) actions.push(migratable ? "migrate-graph-schema" : "seed-graph-schema");
    if (!latest.exists) actions.push("prepare-link");
    else if (!latest.complete) actions.push("heal-link");
    if (!latest.manifest) actions.push(options.thread ? "adopt-thread" : "mint-thread");
    else if (latest.manifest.evidence.createdThread
        && (latest.manifest.phase === "prepared"
          || !threadFacts.some((fact) => fact.predicate === "title")))
      actions.push("heal-thread");
    if (!threadFacts.some((fact) => fact.predicate === "linear" && fact.value === freshIssue.key))
      actions.push("write-compatibility-alias");
    if (!threadFacts.some((fact) =>
      fact.predicate === "linear_link" && fact.value.replace(/^@/, "") === subject))
      actions.push("write-canonical-reverse-link");
    if (latest.manifest?.phase === "prepared") actions.push("adopt-link");
    if (latest.manifest && linearManifestNeedsReceiptCompaction(latest.manifest))
      actions.push("compact-receipts");
    if (!actions.length) actions.push("reuse-link");
    return {
      command: "import", dryRun: true, server: gateway.server, key: freshIssue.key, identity: freshIdentity,
      link: `@${subject}`, thread: `@${existing?.threadId ?? threadId}`, actions,
    };
  }

  let bootstrapLease: SyncLease | undefined;
  let identityLease: SyncLease | undefined;
  let threadLease: SyncLease | undefined;
  let operationCompleted = false;
  try {
    if (identity.identityKind !== "linear-uuid") {
      bootstrapLease = await deps.leases.acquire(
        bootstrapEvidenceLeaseResource(issue, gateway.server),
      );
      const lockedIdentity = (await leaseBoundary(
        bootstrapLease,
        () => resolveImportIdentity(issue, gateway.server, deps.graph),
      )).identity;
      if (linearIdentityKey(lockedIdentity) !== linearIdentityKey(identity))
        throw new Error("Linear issue identity changed while acquiring its bootstrap evidence lease");
    }
    identityLease = await deps.leases.acquire(identityLeaseResource(identity));
    await identityLease.renew();
    const partialUnderIdentity = await inspectPartialLinearLink(deps.graph, subject);
    const chosenThread = partialUnderIdentity.threadId ?? options.thread ?? deps.mintThreadId(identity);
    if (options.thread && chosenThread !== options.thread)
      throw new Error(`Linear issue is already prepared for @${chosenThread}, not @${options.thread}`);

    // Fixed acquisition order is identity -> thread. The prefixes make that
    // order lexical as well as explicit, which keeps every importer/sync caller
    // on the same deadlock-free path.
    threadLease = await deps.leases.acquire(threadLeaseResource(chosenThread));
    const scope = endpointLeaseScope(
      identityLease,
      threadLease,
      bootstrapLease ? [bootstrapLease] : [],
    );
    const freshIssue = normalizeLinearIssueDocument(await leaseBoundary(
      scope, () => gateway.readIssue({ id: key }),
    ));
    const freshIdentity = (await leaseBoundary(
      scope,
      () => resolveImportIdentity(freshIssue, gateway.server, deps.graph),
    )).identity;
    if (linearIdentityKey(freshIdentity) !== linearIdentityKey(identity))
      throw new Error("Linear issue identity changed during import");

    const partialNow = await leaseBoundary(
      scope, () => inspectPartialLinearLink(deps.graph, subject),
    );
    const threadId = partialNow.threadId ?? options.thread ?? deps.mintThreadId(identity);
    if (threadId !== chosenThread)
      throw new Error("canonical Linear identity/thread endpoint changed while its leases were being acquired");
    if (partialNow.manifest)
      verifyPreparedManifest(partialNow.manifest, identity, threadId, freshIssue, gateway.server);

    const currentThread = await leaseBoundary(scope, () => deps.graph.show(threadId));
    assertImportThreadPreconditions(
      options, threadId, subject, currentThread, partialNow.manifest, freshIssue,
    );

    let manifest = partialNow.manifest;
    let createdThread = manifest?.evidence.createdThread ?? !options.thread;
    if (!manifest) {
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

    if (identity.identityKind === "mcp-bootstrap-v2") {
      if (!bootstrapLease)
        throw new Error("Linear bootstrap-v2 import lacks its evidence lease");
      const initialKey = partialNow.bootstrapInitialKey;
      const markerProven = managedLinearThreadId(freshIssue.description) === threadId;
      if (initialKey && initialKey !== manifest.evidence.initialKey)
        throw new Error("Linear bootstrap initial-key evidence conflicts with its manifest");
      if (initialKey && initialKey !== freshIssue.key && !markerProven)
        throw new Error("Linear bootstrap evidence collides with another key; an exact managed marker is required");
    }

    const schema = await leaseBoundary(scope, () => inspectLinearSchema(deps.graph));
    if (schema.conflicting.length && !isKnownLinearSchemaMigration(schema))
      throw new Error(`Linear graph schema conflicts: ${schema.conflicting.join("; ")}`);

    // For native UUIDs and legacy v1 links this is the first mutation. A fresh
    // bootstrap-v2 link first records immutable initial-key collision evidence
    // under its connector+createdAt lease. The helper then validates every reverse
    // linked_thread claimant and the thread's canonical pointer, then commits
    // this durable identity -> thread reservation against one global graph
    // version and the exact identity fence. A crash from here is a healable
    // prepared association, never an unowned thread.
    await scope.renew();
    await deps.graph.reserveLinearBinding(
      scope.identity,
      subject,
      threadId,
      gateway.server,
      identity.identityKind === "mcp-bootstrap-v2"
        ? manifest.evidence.initialKey
        : undefined,
    );
    await scope.renew();
    await leaseBoundary(scope, () => ensureLinearSchema(deps.graph, schema));

    const expected: LinearLinkState = {
      subject, identity, threadId, remoteKey: freshIssue.key, remoteScope: freshIssue.teamId ?? "",
      remoteWorkspaceSlug: freshIssue.workspace, remoteServer: gateway.server, manifest,
    };
    // Within the remaining link projection, the prepared manifest is asserted
    // first; ensureLinearLinkFacts heals any crash after an arbitrary subset.
    await scope.renew();
    const link = await ensureLinearLinkFacts(deps.graph, scope.identity, expected);

    const threadFacts = await leaseBoundary(scope, () => deps.graph.show(link.threadId));
    const threadHasTitle = threadFacts.some((fact) => fact.predicate === "title");
    if (link.manifest.evidence.createdThread
        && (link.manifest.phase === "prepared" || !threadHasTitle)) {
      if (!link.manifest.evidence.importedAt)
        throw new Error(`imported Linear link lacks the timestamp needed to recreate @${link.threadId}`);
      await scope.renew();
      await createImportedThread(
        deps.graph, scope.thread, link.threadId, freshIssue, link.manifest.evidence.owner ?? "personal",
        new Date(link.manifest.evidence.importedAt),
      );
      createdThread = true;
    } else if (!threadHasTitle)
      throw new Error(`canonical link points to missing pre-existing thread @${link.threadId}`);
    await renewAndPut(deps.graph, scope.thread, link.threadId, "linear", freshIssue.key);
    // Preserve the established opaque handle spelling as a true ref to the
    // fact-bearing integration-link entity; integration links are not threads.
    await renewAndPut(deps.graph, scope.thread, link.threadId, "linear_link", `@${link.subject}`);
    if (link.manifest.phase !== "adopted") {
      await scope.renew();
      await writeManifest(deps.graph, scope.identity, link, { ...link.manifest, phase: "adopted" });
    }
    // Public truth comes from the serialized, post-lease observation. A
    // crash-partial association healed by this call is not a reused complete
    // link, even though the durable reservation already existed.
    const action = partialNow.complete ? "reuse-link" : partialNow.exists ? "heal-link" : "create-link";
    const result = {
      command: "import", dryRun: false, action, reused: partialNow.complete === true,
      createdThread, server: gateway.server, key: freshIssue.key, identity,
      link: `@${link.subject}`, thread: `@${link.threadId}`,
    };
    operationCompleted = true;
    return result;
  } finally {
    await releaseLeasesWithoutMaskingFailure(
      [
        ...(bootstrapLease ? [bootstrapLease] : []),
        ...(identityLease ? [identityLease] : []),
        ...(threadLease ? [threadLease] : []),
      ],
      operationCompleted,
    );
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

async function computePlanForLink(
  link: LinearLinkState,
  gateway: LinearGateway,
  graph: GraphStore,
  lease?: SyncLease,
): Promise<PlannedSync> {
  if (link.remoteServer !== gateway.server)
    throw new Error(`Linear link requires MCP server ${link.remoteServer}, not ${gateway.server}`);
  const { issue, comments } = await readRemote(gateway, link, lease);
  const localSource = lease
    ? await leaseBoundary(lease, () => loadNorthThread(graph, link.threadId))
    : await loadNorthThread(graph, link.threadId);
  const local = projectNorthThread(localSource);
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

async function computePlan(
  thread: string,
  gateway: LinearGateway,
  graph: GraphStore,
  lease?: SyncLease,
): Promise<PlannedSync> {
  const link = lease
    ? await leaseBoundary(lease, () => loadLinkForThread(graph, thread))
    : await loadLinkForThread(graph, thread);
  return computePlanForLink(link, gateway, graph, lease);
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
  lease: SyncLease,
  link: LinearLinkState,
): Promise<boolean> {
  if (pending.descriptionReceiptHash || !pending.descriptionHash || !pending.baselineAfter) return false;
  if (pending.titleHash !== undefined && pending.titleHash !== sha256Canonical(issue.title)) return false;
  try {
    const local = projectNorthThread(await leaseBoundary(
      lease, () => loadNorthThread(graph, link.threadId),
    ));
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
  let remoteId: string | undefined;
  if (pending.kind === "issue") {
    const issue = await readRemoteIssue(gateway, link, lease);
    const issueSatisfied = issueOperationSatisfied(pending, issue)
      || await legacyNormalizedIssueOperationSatisfied(pending, issue, graph, lease, link);
    remoteId = issueSatisfied ? issue.key : undefined;
  } else {
    const { comments } = await readRemote(gateway, link, lease);
    remoteId = commentOperationSatisfied(pending, indexManagedLinearComments(comments));
  }
  if (!remoteId) throw new Error(`prior ${pending.kind} write has unknown outcome and is not observable; refusing to retry`);
  const receipts = recordLinearReceipt(
    link.manifest.receipts,
    pending.key,
    { confirmedAt: now.toISOString(), remoteId },
  );
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
  kind: "issue" | "comment", key: string, payload: Record<string, unknown>,
  commentBinding: Pick<ProjectedLinearComment, "kind" | "sourceId" | "marker"> | undefined,
  now: Date,
  onConfirmed?: (manifest: LinearSyncManifest) => LinearSyncManifest,
  baselineAfter?: LinearApplyPlan["expectedBaseline"],
): Promise<{ remoteId: string; manifest: LinearSyncManifest }> {
  const common = {
    key, kind, payloadHash: sha256Canonical(payload), startedAt: now.toISOString(),
  } as const;
  let pending: PendingLinearOperation;
  if (kind === "issue") {
    if (!baselineAfter)
      throw new Error("Linear issue intent requires its full recovery baseline");
    const titleHash = typeof payload.title === "string" ? sha256Canonical(payload.title) : undefined;
    const descriptionHash = typeof payload.description === "string"
      ? sha256Canonical(payload.description) : undefined;
    if (!titleHash && !descriptionHash)
      throw new Error("Linear issue intent requires a title or description");
    pending = {
      ...common, kind: "issue", baselineAfter,
      ...(titleHash ? { titleHash } : {}),
      ...(descriptionHash ? {
        descriptionHash,
        descriptionReceiptHash: managedLinearDescriptionReceiptHash(
          payload.description as string,
          link.threadId,
        ),
      } : {}),
    };
  } else {
    if (typeof payload.body !== "string" || !commentBinding)
      throw new Error("Linear comment intent requires a body and managed identity");
    pending = {
      ...common, kind: "comment",
      bodyHash: sha256Canonical(normalizeBody(payload.body)),
      marker: commentBinding.marker,
      commentKind: commentBinding.kind,
      commentSourceId: commentBinding.sourceId,
    };
  }
  const prepared: LinearSyncManifest = { ...manifest, pending };
  await lease.renew();
  await writeManifest(graph, lease, link, prepared);
  await lease.renew();
  let writeResult: unknown;
  try {
    writeResult = kind === "issue"
      ? await gateway.writeIssue({ id: link.remoteKey, ...payload })
      : await gateway.writeComment(payload);
  } catch {
    // The call may have committed remotely before transport failure. Reconcile, never retry.
  }
  await lease.renew();
  let remoteId: string | undefined;
  if (kind === "issue") {
    const issue = await readRemoteIssue(gateway, link, lease);
    remoteId = issueOperationSatisfied(pending, issue) ? issue.key : undefined;
  } else if (writeResult !== undefined) {
    try {
      const written = record(
        record(writeResult, "Linear save_comment result").comment ?? writeResult,
        "Linear save_comment comment",
      );
      if (typeof written.id === "string"
          && written.id.trim()
          && written.id === written.id.trim()
          && typeof written.body === "string") {
        const indexed = indexManagedLinearComments([{
          id: written.id,
          body: written.body,
        }]);
        remoteId = commentOperationSatisfied(pending, indexed);
      }
    } catch {
      // A malformed success envelope is not commit proof; recover by observation.
    }
  }
  if (kind === "comment" && !remoteId) {
    const { comments } = await readRemote(gateway, link, lease);
    remoteId = commentOperationSatisfied(pending, indexManagedLinearComments(comments));
  }
  if (!remoteId) throw new Error(`${kind} write outcome is unknown and not observable; intent retained, retry refused`);
  const receipts = recordLinearReceipt(
    prepared.receipts,
    key,
    { confirmedAt: now.toISOString(), remoteId },
  );
  const confirmed: LinearSyncManifest = { ...prepared, pending: undefined, receipts };
  const nextManifest = onConfirmed ? onConfirmed(confirmed) : confirmed;
  await lease.renew();
  await writeManifest(graph, lease, link, nextManifest);
  return { remoteId, manifest: nextManifest };
}

async function applySync(thread: string, gateway: LinearGateway, deps: LinearCliDependencies): Promise<unknown> {
  const initialLink = await loadLinkForThread(deps.graph, thread);
  if (initialLink.remoteServer !== gateway.server)
    throw new Error(`Linear link requires MCP server ${initialLink.remoteServer}, not ${gateway.server}`);
  const identityLease = await deps.leases.acquire(identityLeaseResource(initialLink.identity));
  let threadLease: SyncLease | undefined;
  let operationCompleted = false;
  try {
    threadLease = await deps.leases.acquire(threadLeaseResource(initialLink.threadId));
    const scope = endpointLeaseScope(identityLease, threadLease);
    const link = await leaseBoundary(scope, () => loadLinkForThread(deps.graph, thread));
    assertSameLockedEndpoint(initialLink, link, gateway);

    // Validate/repair the durable bijection before pending recovery, remote
    // reads, remote writes, or any mutable link assertion.
    await scope.renew();
    await deps.graph.reserveLinearBinding(
      scope.identity, link.subject, link.threadId, link.remoteServer,
    );
    await scope.renew();
    await leaseBoundary(scope, () => ensureLinearSchema(deps.graph));

    // The thread lease is the transaction fence for all apply state. The
    // durable reservation makes identity -> thread immutable, while both raw
    // endpoint leases remain held and every renewal validates both.
    let manifest = await confirmOrRefusePending(
      gateway, deps.graph, scope.thread, link, deps.now(),
    );
    await scope.renew();
    const planned = await computePlanForLink(link, gateway, deps.graph, scope.thread);
    await scope.renew();
    if (planned.reconciliation.conflicts.length)
      throw new Error(`Linear sync conflict: ${planned.reconciliation.conflicts.map(({ field, category }) => `${field}:${category}`).join(", ")}`);
    if (planned.issue.key !== link.remoteKey)
      await renewAndPut(deps.graph, scope.identity, link.subject, "remote_key", planned.issue.key);
    if (planned.issue.workspace !== link.remoteWorkspaceSlug)
      await renewAndPut(deps.graph, scope.identity, link.subject, "remote_workspace_slug", planned.issue.workspace);
    if (planned.issue.teamId && planned.issue.teamId !== link.remoteScope)
      await renewAndPut(deps.graph, scope.identity, link.subject, "remote_scope", planned.issue.teamId);
    link.remoteKey = planned.issue.key;
    link.remoteWorkspaceSlug = planned.issue.workspace;
    if (planned.issue.teamId) link.remoteScope = planned.issue.teamId;
    let writes = 0;
    if (planned.plan && Object.keys(planned.plan.issue).length) {
      const adoptsMarker = planned.plan.issue.description !== undefined;
      const applied = await applyOperation(
        gateway, deps.graph, scope.thread, link, manifest, "issue", `${planned.plan.hash}:issue`, { ...planned.plan.issue }, undefined, deps.now(),
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
      const bindings = planned.local.comments.filter(({ marker }) => marker === comment.marker);
      if (bindings.length !== 1)
        throw new Error(`Linear comment plan marker ${comment.marker} lacks one exact local identity`);
      const applied = await applyOperation(
        gateway, deps.graph, scope.thread, link, manifest, "comment",
        `${planned.plan!.hash}:comment:${index}`, payload, bindings[0], deps.now(),
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
    if (canonicalJson(finalized) !== canonicalJson(manifest)
        || linearManifestNeedsReceiptCompaction(manifest)) {
      await scope.renew();
      await writeManifest(deps.graph, scope.thread, link, finalized);
    }
    if (writes > 0)
      await renewAndPut(deps.graph, scope.identity, link.subject, "last_synced_at", deps.now().toISOString());
    const result = { command: "sync", applied: true, thread: `@${link.threadId}`, link: `@${link.subject}`, writes, state: "in-sync", planHash: planned.plan?.hash ?? null };
    operationCompleted = true;
    return result;
  } finally {
    await releaseLeasesWithoutMaskingFailure(
      [identityLease, ...(threadLease ? [threadLease] : [])],
      operationCompleted,
    );
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
  normalizeLinearConnector(gateway.server);
  let result: unknown;
  let operationCompleted = false;
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
        identityMode: "mcp-bootstrap-v2",
        identityLimitation: "connector omits native workspace and issue UUIDs; connector + canonical createdAt collisions fail closed without an exact managed marker",
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
    operationCompleted = true;
  } finally {
    try { await gateway.close(); }
    catch (error) {
      if (operationCompleted) throw error;
    }
  }
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
