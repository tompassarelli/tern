import { AppServerMcpBroker } from "./app-server-broker";
import { openLinearGateway, type LinearGateway } from "./gateway";
import {
  CoordinatorSyncLeaseManager, NorthGraphStore, assertImportableDescription, baselineFromRemote,
  createImportedThread, ensureLinearLinkFacts, ensureLinearSchema, identityForIssue,
  inspectLinearSchema, inspectPartialLinearLink, issueSnapshot,
  linkSubject, loadLinkBySubject, loadLinkForThread, loadNorthThread, markerForThread,
  northThreadIdForIdentity, normalizeLinearIssueDocument, writeManifest,
} from "./north-state";
import type {
  GraphStore, LinearIssueDocument, LinearLinkState, LinearSyncManifest, SyncLease,
  SyncLeaseManager,
} from "./north-state";
import { canonicalJson, normalizeBody, sha256Canonical, sha256Text } from "./normalize";
import { projectNorthThread } from "./projection";
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

export interface LinearCliDependencies {
  graph: GraphStore;
  leases: SyncLeaseManager;
  openGateway(options: { server?: string }): Promise<LinearGateway>;
  now(): Date;
  mintThreadId(identity: LinearIssueIdentity): string;
}

function defaults(): LinearCliDependencies {
  return {
    graph: new NorthGraphStore(), leases: new CoordinatorSyncLeaseManager(),
    openGateway: ({ server }) => openLinearGateway(new AppServerMcpBroker({ timeoutMs: 20_000 }), { server }),
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
    if (typeof comment.id !== "string") throw new Error("Linear comment lacks id");
    return { id: comment.id, body: typeof comment.body === "string" ? comment.body : "" };
  });
  return {
    comments, nextCursor: typeof raw.cursor === "string" ? raw.cursor
      : typeof raw.nextCursor === "string" ? raw.nextCursor : undefined,
    hasNextPage: raw.hasNextPage === true,
  };
}

async function allComments(gateway: LinearGateway, key: string): Promise<LinearRemoteComment[]> {
  const comments: LinearRemoteComment[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = normalizeComments(await gateway.listComments({ issueId: key, limit: 250, ...(cursor ? { cursor } : {}) }));
    comments.push(...page.comments);
    if (!page.hasNextPage && !page.nextCursor) return comments;
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Linear list_comments returned an invalid pagination cursor");
    cursor = page.nextCursor;
    seen.add(cursor);
  }
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

async function searchByManagedBacklink(gateway: LinearGateway, link: LinearLinkState): Promise<LinearIssueDocument> {
  const candidates = new Map<string, LinearIssueDocument>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  const query = `North thread @${link.threadId}`;
  for (;;) {
    const page = normalizeIssueList(await gateway.listIssues({ query, limit: 250, ...(cursor ? { cursor } : {}) }));
    for (const issue of page.issues) candidates.set(issue.key, issue);
    if (!page.hasNextPage && !page.nextCursor) break;
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Linear list_issues returned an invalid pagination cursor");
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  const exact: LinearIssueDocument[] = [];
  for (const candidate of candidates.values()) {
    const full = normalizeLinearIssueDocument(await gateway.readIssue({ id: candidate.key }));
    if (full.description.includes(markerForThread(link.threadId)) && identityMatchesEvidence(full, link)) exact.push(full);
  }
  if (exact.length !== 1)
    throw new Error(`managed Linear backlink resolution found ${exact.length} exact issue(s); refusing ambiguous or missing link`);
  return exact[0]!;
}

async function resolveLinkedIssue(gateway: LinearGateway, link: LinearLinkState): Promise<LinearIssueDocument> {
  try {
    const issue = normalizeLinearIssueDocument(await gateway.readIssue({ id: link.remoteKey }));
    if (!identityMatchesEvidence(issue, link)) throw new Error("stored Linear identity evidence no longer matches");
    if (link.manifest.evidence.markerBound && !issue.description.includes(markerForThread(link.threadId)))
      throw new Error("managed backlink is missing from the stored key");
    return issue;
  } catch (directError) {
    if (!link.manifest.evidence.markerBound)
      throw new Error(`stored Linear key could not be verified before backlink adoption: ${directError instanceof Error ? directError.message : String(directError)}`);
    return searchByManagedBacklink(gateway, link);
  }
}

async function readRemote(gateway: LinearGateway, link: LinearLinkState) {
  const issue = await resolveLinkedIssue(gateway, link);
  return { issue, comments: await allComments(gateway, issue.key) };
}

function leaseResource(link: LinearLinkState): string {
  return leaseResourceForIdentity(link.remoteServer, link.identity);
}

function leaseResourceForIdentity(server: string, identity: LinearIssueIdentity): string {
  return `linear-sync:${encodeURIComponent(server)}:${identity.identityKind === "linear-uuid" ? identity.issueId : identity.fingerprint}`;
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
  try {
    await ensureLinearSchema(deps.graph);
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
    const link = await ensureLinearLinkFacts(deps.graph, expected);

    const threadFacts = await deps.graph.show(link.threadId);
    const threadHasTitle = threadFacts.some((fact) => fact.predicate === "title");
    if (link.manifest.evidence.createdThread
        && (link.manifest.phase === "prepared" || !threadHasTitle)) {
      if (!link.manifest.evidence.importedAt)
        throw new Error(`imported Linear link lacks the timestamp needed to recreate @${link.threadId}`);
      await createImportedThread(
        deps.graph, link.threadId, freshIssue, link.manifest.evidence.owner ?? "personal",
        new Date(link.manifest.evidence.importedAt),
      );
      createdThread = true;
    } else if (!threadHasTitle)
      throw new Error(`canonical link points to missing pre-existing thread @${link.threadId}`);
    await deps.graph.put(link.threadId, "linear", freshIssue.key);
    await deps.graph.put(link.threadId, "linear_link", `@${link.subject}`);
    if (link.manifest.phase !== "adopted")
      await writeManifest(deps.graph, link, { ...link.manifest, phase: "adopted" });
    return { command: "import", dryRun: false, reused: partial.exists, createdThread, server: gateway.server, key: freshIssue.key, identity, link: `@${link.subject}`, thread: `@${link.threadId}` };
  } finally { await lease.release(); }
}

interface PlannedSync {
  link: LinearLinkState;
  issue: LinearIssueDocument;
  comments: LinearRemoteComment[];
  local: LinearThreadProjection;
  reconciliation: LinearReconciliationResult;
  plan: LinearApplyPlan | null;
  descriptionAdoption: boolean;
}

async function computePlan(thread: string, gateway: LinearGateway, graph: GraphStore): Promise<PlannedSync> {
  const link = await loadLinkForThread(graph, thread);
  if (link.remoteServer !== gateway.server)
    throw new Error(`Linear link requires MCP server ${link.remoteServer}, not ${gateway.server}`);
  const { issue, comments } = await readRemote(gateway, link);
  const local = projectNorthThread(await loadNorthThread(graph, link.threadId));
  const reconciliation = reconcileLinearIssue({
    baseline: link.manifest.baseline, local, remote: issueSnapshot(issue, link.identity, comments),
    ...(link.manifest.evidence.adoptRawDescription ? {
      bootstrap: { importedRawDescriptionHash: link.manifest.evidence.importedRawDescriptionHash! },
    } : {}),
  });
  return {
    link, issue, comments, local, reconciliation, plan: reconciliation.plan,
    descriptionAdoption: Boolean(link.manifest.evidence.adoptRawDescription && reconciliation.plan?.issue.description),
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
  return (pending.titleHash === undefined || pending.titleHash === sha256Canonical(issue.title))
    && (pending.descriptionHash === undefined || pending.descriptionHash === sha256Canonical(issue.description));
}

function commentOperationSatisfied(pending: NonNullable<LinearSyncManifest["pending"]>, comments: readonly LinearRemoteComment[]): string | undefined {
  const found = comments.find((comment) => pending.marker && comment.body?.includes(pending.marker)
    && pending.bodyHash === sha256Canonical(normalizeBody(comment.body)));
  return found?.id;
}

async function confirmOrRefusePending(
  gateway: LinearGateway, graph: GraphStore, link: LinearLinkState, now: Date,
): Promise<void> {
  const pending = link.manifest.pending;
  if (!pending) return;
  const { issue, comments } = await readRemote(gateway, link);
  const remoteId = pending.kind === "issue"
    ? issueOperationSatisfied(pending, issue) ? issue.key : undefined
    : commentOperationSatisfied(pending, comments);
  if (!remoteId) throw new Error(`prior ${pending.kind} write has unknown outcome and is not observable; refusing to retry`);
  const receipts = { ...(link.manifest.receipts ?? {}), [pending.key]: { confirmedAt: now.toISOString(), remoteId } };
  const markerAdopted = pending.kind === "issue" && pending.descriptionHash !== undefined;
  await writeManifest(graph, link, {
    ...link.manifest, pending: undefined, receipts,
    ...(pending.baselineAfter ? { baseline: pending.baselineAfter } : {}),
    ...(markerAdopted ? { evidence: { ...link.manifest.evidence, markerBound: true, adoptRawDescription: false } } : {}),
  });
}

async function applyOperation(
  gateway: LinearGateway, graph: GraphStore, lease: SyncLease, link: LinearLinkState,
  kind: "issue" | "comment", key: string, payload: Record<string, unknown>, marker: string | undefined,
  now: Date,
  onConfirmed?: (manifest: LinearSyncManifest) => LinearSyncManifest,
  baselineAfter?: LinearApplyPlan["expectedBaseline"],
): Promise<string | undefined> {
  const pending = {
    key, kind, payloadHash: sha256Canonical(payload),
    ...(typeof payload.title === "string" ? { titleHash: sha256Canonical(payload.title) } : {}),
    ...(typeof payload.description === "string" ? { descriptionHash: sha256Canonical(payload.description) } : {}),
    ...(typeof payload.body === "string" ? { bodyHash: sha256Canonical(normalizeBody(payload.body)) } : {}),
    ...(baselineAfter ? { baselineAfter } : {}),
    ...(marker ? { marker } : {}), startedAt: now.toISOString(),
  } as const;
  await writeManifest(graph, link, { ...link.manifest, pending });
  await lease.fence();
  let callError: string | undefined;
  try {
    if (kind === "issue") await gateway.writeIssue({ id: link.remoteKey, ...payload });
    else await gateway.writeComment(payload);
  } catch (error) {
    // The call may have committed remotely before transport failure. Reconcile, never retry.
    callError = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
  }
  const { issue, comments } = await readRemote(gateway, link);
  const remoteId = kind === "issue"
    ? issueOperationSatisfied(pending, issue) ? issue.key : undefined
    : commentOperationSatisfied(pending, comments);
  if (!remoteId) throw new Error(`${kind} write outcome is unknown and not observable; intent retained, retry refused${callError ? ` (${callError})` : ""}`);
  const receipts = { ...(link.manifest.receipts ?? {}), [key]: { confirmedAt: now.toISOString(), remoteId } };
  const confirmed = { ...link.manifest, pending: undefined, receipts };
  await writeManifest(graph, link, onConfirmed ? onConfirmed(confirmed) : confirmed);
  return remoteId;
}

async function applySync(thread: string, gateway: LinearGateway, deps: LinearCliDependencies): Promise<unknown> {
  const initialLink = await loadLinkForThread(deps.graph, thread);
  const lease = await deps.leases.acquire(leaseResource(initialLink));
  try {
    await ensureLinearSchema(deps.graph);
    const link = await loadLinkForThread(deps.graph, thread);
    await confirmOrRefusePending(gateway, deps.graph, link, deps.now());
    const planned = await computePlan(thread, gateway, deps.graph);
    if (planned.reconciliation.conflicts.length)
      throw new Error(`Linear sync conflict: ${planned.reconciliation.conflicts.map(({ field, category }) => `${field}:${category}`).join(", ")}`);
    if (planned.issue.key !== link.remoteKey) await deps.graph.put(link.subject, "remote_key", planned.issue.key);
    if (planned.issue.workspace !== link.remoteWorkspaceSlug)
      await deps.graph.put(link.subject, "remote_workspace_slug", planned.issue.workspace);
    if (planned.issue.teamId && planned.issue.teamId !== link.remoteScope)
      await deps.graph.put(link.subject, "remote_scope", planned.issue.teamId);
    link.remoteKey = planned.issue.key;
    link.remoteWorkspaceSlug = planned.issue.workspace;
    if (planned.issue.teamId) link.remoteScope = planned.issue.teamId;
    let writes = 0;
    if (planned.plan && Object.keys(planned.plan.issue).length) {
      const adoptsMarker = planned.plan.issue.description !== undefined;
      await applyOperation(
        gateway, deps.graph, lease, link, "issue", `${planned.plan.hash}:issue`, { ...planned.plan.issue }, undefined, deps.now(),
        (manifest) => adoptsMarker ? {
          ...manifest, baseline: planned.plan!.expectedBaseline,
          evidence: { ...manifest.evidence, markerBound: true, adoptRawDescription: false },
        } : manifest,
        planned.plan.expectedBaseline,
      );
      writes++;
    }
    for (const [index, comment] of (planned.plan?.comments ?? []).entries()) {
      const payload = comment.action === "create"
        ? { issueId: link.remoteKey, body: comment.body }
        : { id: comment.commentId, body: comment.body };
      await applyOperation(gateway, deps.graph, lease, link, "comment", `${planned.plan!.hash}:comment:${index}`, payload, comment.marker, deps.now());
      writes++;
    }
    const baseline = createLinearSyncBaseline(link.identity, link.threadId, planned.local.fields);
    await writeManifest(deps.graph, link, {
      ...link.manifest, phase: "adopted", baseline, pending: undefined,
      evidence: { ...link.manifest.evidence, markerBound: link.manifest.evidence.markerBound || Boolean(planned.plan?.issue.description) },
    });
    await deps.graph.put(link.subject, "last_synced_at", deps.now().toISOString());
    return { command: "sync", applied: true, thread: `@${link.threadId}`, link: `@${link.subject}`, writes, state: "in-sync", planHash: planned.plan?.hash ?? null };
  } finally { await lease.release(); }
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
  try {
    if (verb === "doctor") {
      const schema = await inspectLinearSchema(deps.graph);
      return {
        command: "doctor", server: gateway.server, oauth: true, modelTurn: false,
        identityMode: "mcp-bootstrap-v1", identityLimitation: "connector omits native workspace and issue UUIDs; managed backlink + createdAt fingerprint",
        graphSchema: schema,
      };
    }
    if (verb === "get") {
      const issue = normalizeLinearIssueDocument(await gateway.readIssue({ id: required("get") }));
      return { command: "get", server: gateway.server, issue, identity: identityForIssue(issue, gateway.server) };
    }
    if (verb === "import") return await importIssue(required("import"), options, gateway, deps);
    if (verb === "plan") return publicPlan(await computePlan(required("plan"), gateway, deps.graph));
    if (verb === "sync") {
      const thread = required("sync");
      if (!options.apply) return publicPlan(await computePlan(thread, gateway, deps.graph));
      return await applySync(thread, gateway, deps);
    }
    throw new Error(`unknown north linear verb ${verb}`);
  } finally { await gateway.close(); }
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
