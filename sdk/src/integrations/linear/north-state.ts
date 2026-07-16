import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  canonicalJson, linearIdentityKey, normalizeLinearIdentity, normalizeText, sha256Canonical,
} from "./normalize";
import { createLinearSyncBaseline, validateLinearSyncBaseline } from "./reconcile";
import { parseManagedLinearDescription } from "./projection";
import type {
  LinearIssueIdentity, LinearIssueSnapshot, LinearRemoteComment, LinearSyncBaseline,
  LinearSyncFields, NorthLifecycleCategory, NorthThreadSyncSource,
} from "./types";

const execFileAsync = promisify(execFile);
const NORTH_ROOT = resolve(import.meta.dir, "../../../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_MARKER = /<!--\s*\/?north:/i;

export interface GraphFact { predicate: string; value: string }

export interface GraphStore {
  show(subject: string): Promise<readonly GraphFact[]>;
  /** Coordinator-serialized graph assertion. Subject is bare; refs retain @. */
  put(subject: string, predicate: string, value: string): Promise<void>;
}

export interface SyncLease {
  readonly resource: string;
  readonly holder: string;
  readonly epoch: number;
  fence(): Promise<void>;
  release(): Promise<void>;
}

export interface SyncLeaseManager { acquire(resource: string): Promise<SyncLease> }

async function command(file: string, args: readonly string[], options: { timeout?: number } = {}): Promise<string> {
  const result = await execFileAsync(file, [...args], {
    encoding: "utf8",
    timeout: options.timeout ?? 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export class NorthGraphStore implements GraphStore {
  constructor(
    private northBin = process.env.NORTH_BIN ?? resolve(NORTH_ROOT, "bin/north"),
    private framBin = process.env.FRAM_BIN ?? resolve(process.env.FRAM_HOME ?? resolve(NORTH_ROOT, "../fram"), "bin/fram"),
  ) {}

  async show(subject: string): Promise<readonly GraphFact[]> {
    const bare = subject.replace(/^@/, "");
    const parsed = JSON.parse(await command(this.northBin, ["json", "show", bare]));
    if (!Array.isArray(parsed) || parsed.some((fact) => typeof fact?.predicate !== "string" || typeof fact?.value !== "string"))
      throw new Error(`north json show returned invalid facts for @${bare}`);
    return parsed;
  }

  async put(subject: string, predicate: string, value: string): Promise<void> {
    const bare = subject.replace(/^@/, "");
    const output = await command(this.framBin, ["tell", bare, predicate, value]);
    if (!output.startsWith("committed via coordinator"))
      throw new Error(`coordinator rejected @${bare} ${predicate}: ${output || "no response"}`);
  }
}

export class CoordinatorSyncLeaseManager implements SyncLeaseManager {
  constructor(
    private port = process.env.NORTH_PORT ?? "7977",
    private leaseCli = resolve(NORTH_ROOT, "cli/lease-cli.clj"),
    private ttlMs = 300_000,
    private attempts = 50,
  ) {}

  private invoke(args: readonly string[]): Promise<string> {
    return command("bb", [this.leaseCli, this.port, ...args]);
  }

  async acquire(resource: string): Promise<SyncLease> {
    const holder = `linear-${process.pid}-${randomUUID()}`;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const output = await this.invoke(["acquire", resource, holder, String(this.ttlMs)]);
      const epoch = /:epoch\s+(\d+)/.exec(output)?.[1];
      if (epoch && /:ok\s+\d+/.test(output)) {
        const manager = this;
        let released = false;
        return {
          resource, holder, epoch: Number(epoch),
          async fence() {
            if (released) throw new Error(`Linear sync lease ${resource} was already released`);
            const fenced = await manager.invoke(["fence", resource, holder, epoch]);
            if (!/:fence-ok\s+true/.test(fenced)) throw new Error(`lost Linear sync lease ${resource}`);
          },
          async release() {
            if (released) return;
            released = true;
            await manager.invoke(["release", resource, holder]);
          },
        };
      }
      if (!/:reject\s+:held/.test(output)) throw new Error(`could not acquire Linear sync lease ${resource}: ${output}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`timed out waiting for Linear sync lease ${resource}`);
  }
}

export const LINEAR_SCHEMA_FACTS = [
  ["linked_thread", "cardinality", "single"],
  ["remote_uuid", "cardinality", "single"],
  ["remote_workspace", "cardinality", "single"],
  ["remote_fingerprint", "cardinality", "single"],
  ["remote_workspace_slug", "cardinality", "single"],
  ["remote_scope", "cardinality", "single"],
  ["remote_key", "cardinality", "single"],
  ["remote_server", "cardinality", "single"],
  ["identity_kind", "cardinality", "single"],
  ["sync_policy", "cardinality", "single"],
  ["sync_schema", "cardinality", "single"],
  ["sync_manifest", "cardinality", "single"],
  ["last_synced_at", "cardinality", "single"],
  ["remote_missing_at", "cardinality", "single"],
  ["unlinked_at", "cardinality", "single"],
  ["linear_link", "cardinality", "single"],
  ["conflict_field", "cardinality", "multi"],
  ["linked_thread", "value_kind", "ref"],
  ["linear_link", "value_kind", "ref"],
] as const;

export interface SchemaInspection {
  ok: boolean;
  missing: readonly string[];
  conflicting: readonly string[];
}

export async function inspectLinearSchema(graph: GraphStore): Promise<SchemaInspection> {
  const missing: string[] = [];
  const conflicting: string[] = [];
  const subjects = new Map<string, readonly GraphFact[]>();
  for (const [subject] of LINEAR_SCHEMA_FACTS)
    if (!subjects.has(subject)) subjects.set(subject, await graph.show(subject));
  for (const [subject, predicate, value] of LINEAR_SCHEMA_FACTS) {
    const values = [...new Set(subjects.get(subject)!.filter((fact) => fact.predicate === predicate).map((fact) => fact.value))];
    if (!values.includes(value)) missing.push(`@${subject} ${predicate} ${value}`);
    if (values.some((found) => found !== value)) conflicting.push(`@${subject} ${predicate}: ${values.join(", ")}`);
  }
  return { ok: missing.length === 0 && conflicting.length === 0, missing, conflicting };
}

export async function ensureLinearSchema(graph: GraphStore): Promise<void> {
  const inspection = await inspectLinearSchema(graph);
  if (inspection.conflicting.length) throw new Error(`Linear graph schema conflicts: ${inspection.conflicting.join("; ")}`);
  const missing = new Set(inspection.missing);
  for (const [subject, predicate, value] of LINEAR_SCHEMA_FACTS)
    if (missing.has(`@${subject} ${predicate} ${value}`)) await graph.put(subject, predicate, value);
}

function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Linear issue lacks ${name}`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`);
  return value as Record<string, unknown>;
}

export function workspaceFromLinearUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error(`Linear issue URL is invalid: ${JSON.stringify(input)}`); }
  const workspace = url.pathname.split("/").filter(Boolean)[0];
  if (url.protocol !== "https:" || url.hostname !== "linear.app" || !workspace)
    throw new Error(`Linear issue URL does not identify a linear.app workspace: ${input}`);
  return workspace;
}

export interface LinearIssueDocument {
  key: string;
  uuid?: string;
  workspace: string;
  workspaceId?: string;
  title: string;
  description: string;
  url: string;
  createdAt: string;
  updatedAt?: string;
  status?: string;
  statusType?: string;
  teamId?: string;
  team?: { id?: string; name?: string; key?: string };
}

/** Normalize the live top-level get_issue payload. */
export function normalizeLinearIssueDocument(input: unknown): LinearIssueDocument {
  let raw = asRecord(input, "Linear get_issue result");
  if (raw.issue !== undefined) raw = asRecord(raw.issue, "Linear get_issue issue");
  const url = requiredString(raw, "url");
  const id = requiredString(raw, "id");
  const explicitIdentifier = optionalString(raw.identifier);
  const key = explicitIdentifier ?? (UUID.test(id) ? "" : id);
  if (!key) throw new Error("Linear issue lacks a human identifier");
  const uuidCandidates = [raw.uuid, raw.issueId, explicitIdentifier ? raw.id : undefined]
    .map(optionalString).filter((value): value is string => Boolean(value));
  const uuid = uuidCandidates.find((value) => UUID.test(value))?.toLowerCase();
  const teamRaw = typeof raw.team === "object" && raw.team !== null && !Array.isArray(raw.team)
    ? raw.team as Record<string, unknown> : undefined;
  const teamId = optionalString(raw.teamId) ?? optionalString(teamRaw?.id);
  const teamName = optionalString(typeof raw.team === "string" ? raw.team : teamRaw?.name);
  return {
    key, uuid, workspace: workspaceFromLinearUrl(url), workspaceId: optionalString(raw.workspaceId),
    title: requiredString(raw, "title"), description: typeof raw.description === "string" ? raw.description : "",
    url, createdAt: requiredString(raw, "createdAt"), updatedAt: optionalString(raw.updatedAt),
    status: optionalString(raw.status), statusType: optionalString(raw.statusType), teamId,
    team: teamRaw || teamName ? {
      ...(teamId ? { id: teamId } : {}), ...(teamName ? { name: teamName } : {}),
      ...(optionalString(teamRaw?.key) ? { key: optionalString(teamRaw?.key) } : {}),
    } : undefined,
  };
}

export function identityForIssue(issue: LinearIssueDocument, connector: string): LinearIssueIdentity {
  if (issue.uuid && issue.workspaceId && UUID.test(issue.workspaceId)) {
    return normalizeLinearIdentity({ identityKind: "linear-uuid", workspaceId: issue.workspaceId, issueId: issue.uuid });
  }
  return normalizeLinearIdentity({
    identityKind: "mcp-bootstrap-v1", connector,
    fingerprint: sha256Canonical({ connector, createdAt: issue.createdAt, initialKey: issue.key }),
  });
}

export function linkSubject(identity: LinearIssueIdentity): string {
  return `link:${linearIdentityKey(identity)}`;
}

function one(facts: readonly GraphFact[], predicate: string, required = true): string | undefined {
  const values = [...new Set(facts.filter((fact) => fact.predicate === predicate).map((fact) => fact.value))];
  if (values.length > 1) throw new Error(`ambiguous ${predicate}: ${values.join(", ")}`);
  if (!values.length && required) throw new Error(`missing ${predicate}`);
  return values[0];
}

export interface PendingLinearOperation {
  key: string;
  kind: "issue" | "comment";
  payloadHash: string;
  titleHash?: string;
  descriptionHash?: string;
  bodyHash?: string;
  baselineAfter?: LinearSyncBaseline;
  marker?: string;
  startedAt: string;
}

export interface LinearSyncManifest {
  version: 1;
  phase: "prepared" | "adopted";
  baseline: LinearSyncBaseline;
  evidence: {
    connector: string;
    createdAt: string;
    initialKey: string;
    workspace: string;
    importedRawDescriptionHash?: string;
    importedTitleHash?: string;
    adoptRawDescription?: boolean;
    markerBound?: boolean;
    importedAt?: string;
    createdThread?: boolean;
    owner?: string;
  };
  pending?: PendingLinearOperation;
  receipts?: Record<string, { confirmedAt: string; remoteId?: string }>;
}

export interface LinearLinkState {
  subject: string;
  identity: LinearIssueIdentity;
  threadId: string;
  remoteKey: string;
  remoteScope: string;
  remoteWorkspaceSlug: string;
  remoteServer: string;
  manifest: LinearSyncManifest;
}

export interface PartialLinearLinkState {
  exists: boolean;
  complete?: boolean;
  threadId?: string;
  manifest?: LinearSyncManifest;
}

function parseManifest(value: string): LinearSyncManifest {
  const raw = asRecord(JSON.parse(value), "Linear sync manifest");
  if (raw.version !== 1 || (raw.phase !== "prepared" && raw.phase !== "adopted"))
    throw new Error("Linear sync manifest has an unsupported shape");
  const evidence = asRecord(raw.evidence, "Linear sync manifest evidence");
  for (const key of ["connector", "createdAt", "initialKey", "workspace"])
    if (typeof evidence[key] !== "string" || !evidence[key]) throw new Error(`Linear sync manifest evidence lacks ${key}`);
  for (const key of ["markerBound", "adoptRawDescription", "createdThread"])
    if (evidence[key] !== undefined && typeof evidence[key] !== "boolean")
      throw new Error(`Linear sync manifest evidence ${key} must be boolean`);
  if (evidence.importedAt !== undefined && (typeof evidence.importedAt !== "string" || !Number.isFinite(Date.parse(evidence.importedAt))))
    throw new Error("Linear sync manifest evidence importedAt is invalid");
  if (evidence.owner !== undefined && (typeof evidence.owner !== "string" || !evidence.owner))
    throw new Error("Linear sync manifest evidence owner is invalid");
  if (evidence.importedRawDescriptionHash !== undefined
      && (typeof evidence.importedRawDescriptionHash !== "string" || !/^[0-9a-f]{64}$/.test(evidence.importedRawDescriptionHash)))
    throw new Error("Linear sync manifest evidence importedRawDescriptionHash is invalid");
  if (evidence.importedTitleHash !== undefined
      && (typeof evidence.importedTitleHash !== "string" || !/^[0-9a-f]{64}$/.test(evidence.importedTitleHash)))
    throw new Error("Linear sync manifest evidence importedTitleHash is invalid");
  const baseline = validateLinearSyncBaseline(asRecord(raw.baseline, "Linear sync manifest baseline") as unknown as LinearSyncBaseline);
  const pending = raw.pending === undefined ? undefined : asRecord(raw.pending, "Linear sync pending operation");
  if (pending && (typeof pending.key !== "string" || !["issue", "comment"].includes(String(pending.kind))
      || typeof pending.payloadHash !== "string" || typeof pending.startedAt !== "string"))
    throw new Error("Linear sync pending operation has an unsupported shape");
  if (pending) for (const key of ["payloadHash", "titleHash", "descriptionHash", "bodyHash"])
    if (pending[key] !== undefined && (typeof pending[key] !== "string" || !/^[0-9a-f]{64}$/.test(pending[key] as string)))
      throw new Error(`Linear sync pending operation ${key} is invalid`);
  if (pending?.baselineAfter !== undefined)
    pending.baselineAfter = validateLinearSyncBaseline(asRecord(pending.baselineAfter, "Linear sync pending baselineAfter") as unknown as LinearSyncBaseline);
  const receiptRecord = raw.receipts === undefined ? undefined : asRecord(raw.receipts, "Linear sync receipts");
  if (receiptRecord) for (const [key, value] of Object.entries(receiptRecord)) {
    const receipt = asRecord(value, `Linear sync receipt ${key}`);
    if (typeof receipt.confirmedAt !== "string" || !Number.isFinite(Date.parse(receipt.confirmedAt))
        || (receipt.remoteId !== undefined && typeof receipt.remoteId !== "string"))
      throw new Error(`Linear sync receipt ${key} has an unsupported shape`);
  }
  const receipts = receiptRecord as LinearSyncManifest["receipts"];
  return {
    version: 1, phase: raw.phase as LinearSyncManifest["phase"], baseline,
    evidence: evidence as unknown as LinearSyncManifest["evidence"],
    ...(pending ? { pending: pending as unknown as PendingLinearOperation } : {}),
    ...(receipts ? { receipts } : {}),
  };
}

export async function inspectPartialLinearLink(graph: GraphStore, subject: string): Promise<PartialLinearLinkState> {
  const facts = await graph.show(subject);
  if (!facts.length) return { exists: false };
  const singleton = (predicate: string): string | undefined => {
    const values = [...new Set(facts.filter((fact) => fact.predicate === predicate).map((fact) => fact.value))];
    if (values.length > 1) throw new Error(`partial Linear link @${subject} has conflicting ${predicate} values`);
    return values[0];
  };
  const kind = singleton("kind");
  if (kind !== undefined && kind !== "integration_link") throw new Error(`@${subject} is not an integration_link`);
  const identityKind = singleton("identity_kind");
  if (identityKind !== undefined && identityKind !== "linear-uuid" && identityKind !== "mcp-bootstrap-v1")
    throw new Error(`partial Linear link @${subject} has unknown identity_kind ${identityKind}`);
  const policy = singleton("sync_policy");
  if (policy !== undefined && policy !== "north-primary") throw new Error(`partial Linear link @${subject} has unsupported sync_policy`);
  const schema = singleton("sync_schema");
  if (schema !== undefined && schema !== "linear-sync-v1") throw new Error(`partial Linear link @${subject} has unsupported sync_schema`);
  const manifestValue = singleton("sync_manifest");
  const manifest = manifestValue ? parseManifest(manifestValue) : undefined;
  const threadId = singleton("linked_thread")?.replace(/^@/, "") ?? manifest?.baseline.threadId;
  const common = ["kind", "linked_thread", "remote_key", "remote_server", "remote_workspace_slug", "identity_kind", "sync_policy", "sync_schema", "sync_manifest"];
  const identityPredicates = identityKind === "linear-uuid" ? ["remote_uuid", "remote_workspace"]
    : identityKind === "mcp-bootstrap-v1" ? ["remote_fingerprint"] : [];
  const complete = [...common, ...identityPredicates].every((predicate) => singleton(predicate) !== undefined);
  return { exists: true, complete, threadId, manifest };
}

export async function ensureLinearLinkFacts(graph: GraphStore, expected: LinearLinkState): Promise<LinearLinkState> {
  const current = await graph.show(expected.subject);
  const required: readonly (readonly [string, string])[] = [
    // The prepared manifest is first: it carries the deterministic thread id and
    // import timestamp needed to heal a crash after any later individual fact.
    ["sync_manifest", canonicalJson(expected.manifest)],
    ["kind", "integration_link"], ["linked_thread", `@${expected.threadId}`],
    ...(expected.identity.identityKind === "linear-uuid"
      ? [["remote_uuid", expected.identity.issueId], ["remote_workspace", expected.identity.workspaceId]] as const
      : [["remote_fingerprint", expected.identity.fingerprint]] as const),
    ...(expected.remoteScope ? [["remote_scope", expected.remoteScope]] as const : []),
    ["remote_workspace_slug", expected.remoteWorkspaceSlug], ["remote_key", expected.remoteKey],
    ["remote_server", expected.remoteServer], ["identity_kind", expected.identity.identityKind],
    ["sync_policy", "north-primary"], ["sync_schema", "linear-sync-v1"],
  ];
  for (const [predicate, value] of required) {
    const values = [...new Set(current.filter((fact) => fact.predicate === predicate).map((fact) => fact.value))];
    const mutable = ["remote_key", "remote_scope", "remote_workspace_slug"].includes(predicate);
    if (!mutable && values.some((found) => found !== value))
      throw new Error(`partial Linear link @${expected.subject} conflicts on ${predicate}`);
    if (!values.includes(value)) await graph.put(expected.subject, predicate, value);
  }
  const loaded = await loadLinkBySubject(graph, expected.subject);
  if (!loaded) throw new Error(`failed to heal Linear link @${expected.subject}`);
  return loaded;
}

export async function loadLinkBySubject(graph: GraphStore, subject: string): Promise<LinearLinkState | null> {
  const facts = await graph.show(subject);
  if (!facts.length) return null;
  if (one(facts, "kind") !== "integration_link") throw new Error(`@${subject} is not an integration_link`);
  const identityKind = one(facts, "identity_kind");
  if (identityKind !== "linear-uuid" && identityKind !== "mcp-bootstrap-v1")
    throw new Error(`Linear link @${subject} has unknown identity_kind ${String(identityKind)}`);
  const remoteServer = one(facts, "remote_server")!;
  const identity = identityKind === "linear-uuid"
    ? normalizeLinearIdentity({ identityKind, workspaceId: one(facts, "remote_workspace")!, issueId: one(facts, "remote_uuid")! })
    : normalizeLinearIdentity({ identityKind: "mcp-bootstrap-v1", connector: remoteServer, fingerprint: one(facts, "remote_fingerprint")! });
  if (linkSubject(identity) !== subject.replace(/^@/, "")) throw new Error(`Linear link identity does not match @${subject}`);
  const manifest = parseManifest(one(facts, "sync_manifest")!);
  const threadId = one(facts, "linked_thread")!.replace(/^@/, "");
  if (manifest.baseline.threadId !== threadId || canonicalJson(manifest.baseline.identity) !== canonicalJson(identity))
    throw new Error(`Linear link @${subject} manifest identity/thread does not match link facts`);
  return {
    subject: subject.replace(/^@/, ""), identity,
    threadId, remoteKey: one(facts, "remote_key")!,
    remoteScope: one(facts, "remote_scope", false) ?? "", remoteWorkspaceSlug: one(facts, "remote_workspace_slug")!, remoteServer,
    manifest,
  };
}

export async function loadLinkForThread(graph: GraphStore, threadId: string): Promise<LinearLinkState> {
  const facts = await graph.show(threadId.replace(/^@/, ""));
  const links = [...new Set(facts.filter((fact) => fact.predicate === "linear_link").map((fact) => fact.value.replace(/^@/, "")))];
  if (links.length > 1) throw new Error(`North thread @${threadId} has ambiguous canonical Linear links`);
  if (!links.length) {
    if (facts.some((fact) => fact.predicate === "linear"))
      throw new Error(`North thread @${threadId} has only a legacy linear alias; import explicitly to adopt an immutable link`);
    throw new Error(`North thread @${threadId} has no canonical Linear link`);
  }
  const link = await loadLinkBySubject(graph, links[0]!);
  if (!link) throw new Error(`North thread @${threadId} points to missing @${links[0]}`);
  if (link.threadId !== threadId.replace(/^@/, "")) throw new Error(`Linear link @${link.subject} belongs to @${link.threadId}`);
  return link;
}

export async function writeManifest(graph: GraphStore, link: LinearLinkState, manifest: LinearSyncManifest): Promise<void> {
  await graph.put(link.subject, "sync_manifest", canonicalJson(manifest));
  link.manifest = manifest;
}

export function baselineFromRemote(issue: LinearIssueDocument, identity: LinearIssueIdentity, threadId: string): LinearSyncBaseline {
  const managed = parseManagedLinearDescription(issue.description, threadId);
  const fields: LinearSyncFields = {
    title: issue.title, body: managed?.body ?? "", doneWhen: managed?.doneWhen ?? [],
    barEvidence: managed?.barEvidence ?? [], repos: managed?.repos ?? [], lifecycle: managed?.lifecycle ?? "speculative",
  };
  return createLinearSyncBaseline(identity, threadId, fields);
}

export function issueSnapshot(issue: LinearIssueDocument, identity: LinearIssueIdentity, comments: readonly LinearRemoteComment[]): LinearIssueSnapshot {
  return { ...identity, identifier: issue.key, scopeId: issue.teamId, title: issue.title, description: issue.description, comments };
}

async function lifecycle(graph: GraphStore, facts: readonly GraphFact[]): Promise<NorthLifecycleCategory> {
  if (facts.some((fact) => fact.predicate === "outcome")) return "done";
  if (facts.some((fact) => fact.predicate === "abandoned" || fact.predicate === "superseded_by")) return "abandoned";
  if (facts.some((fact) => fact.predicate === "driver")) return "active";
  for (const dependency of facts.filter((fact) => fact.predicate === "depends_on").map((fact) => fact.value.replace(/^@/, ""))) {
    const target = await graph.show(dependency);
    if (!target.some((fact) => ["outcome", "abandoned", "superseded_by"].includes(fact.predicate))) return "blocked";
  }
  if (!facts.some((fact) => fact.predicate === "committed")) return "speculative";
  const doOn = one(facts, "do_on", false);
  if (doOn && doOn > new Date().toISOString().slice(0, 10)) return "dormant";
  return "ready";
}

export async function loadNorthThread(graph: GraphStore, threadId: string): Promise<NorthThreadSyncSource> {
  const bare = threadId.replace(/^@/, "");
  const facts = await graph.show(bare);
  const title = one(facts, "title");
  return {
    threadId: bare, title, body: one(facts, "body", false) ?? "",
    doneWhen: facts.filter((fact) => fact.predicate === "done_when").map((fact) => fact.value),
    barEvidence: facts.filter((fact) => fact.predicate === "bar_evidence").map((fact) => fact.value),
    repos: facts.filter((fact) => fact.predicate === "repo").map((fact) => fact.value),
    lifecycle: await lifecycle(graph, facts),
    progress: facts.filter((fact) => fact.predicate === "progress").map((fact) => ({ body: fact.value })),
    outcome: one(facts, "outcome", false),
    learning: facts.filter((fact) => fact.predicate === "learning").map((fact) => ({ body: fact.value })),
  };
}

export function northThreadIdForIdentity(identity: LinearIssueIdentity): string {
  const bytes = Buffer.from(sha256Canonical({ northThread: linearIdentityKey(identity) }).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createImportedThread(
  graph: GraphStore, threadId: string, issue: LinearIssueDocument, owner: string, now: Date,
): Promise<void> {
  const date = now.toISOString().slice(0, 10);
  const author = (process.env.NORTH_AUTHOR ?? "tom_passarelli").replace(/^@/, "");
  const lead = (process.env.NORTH_LEAD ?? "tom_passarelli").replace(/^@/, "");
  const proposed = (process.env.NORTH_PROPOSED_BY ?? author).replace(/^@/, "");
  const facts: readonly [string, string][] = [
    ["title", issue.title], ["kind", "thread"], ...(owner === "personal" ? [] : [["owner", owner] as [string, string]]),
    ["source", "linear"], ["created_by", `@${author}`], ["lead", `@${lead}`],
    ["proposed_by", `@${proposed}`], ["created_at", now.toISOString()], ["updated_at", date],
    ["committed", date], ["body", issue.description],
  ];
  for (const [predicate, value] of facts) await graph.put(threadId, predicate, value);
}

export function assertImportableDescription(description: string): void {
  if (RESERVED_MARKER.test(description))
    throw new Error("Linear issue already contains a reserved North marker but has no matching canonical link");
}

export function markerForThread(threadId: string): string {
  return `<!-- north:thread:${normalizeText(threadId).replace(/^@/, "")} -->`;
}
