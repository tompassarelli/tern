import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  canonicalJson, linearIdentityKey, MAX_LINEAR_REMOTE_KEY_BYTES,
  normalizeLinearConnector, normalizeLinearIdentity, normalizeLinearRemoteKey,
  normalizeText, normalizeThreadId,
  sha256Canonical,
} from "./normalize";
import { createLinearSyncBaseline, validateLinearSyncBaseline } from "./reconcile";
import { parseManagedLinearDescription } from "./projection";
import type {
  LinearIssueIdentity, LinearIssueSnapshot, LinearRemoteComment, LinearSyncBaseline,
  LinearSyncFields, NorthCommentKind, NorthLifecycleCategory, NorthThreadSyncSource,
} from "./types";

const execFileAsync = promisify(execFile);
const NORTH_ROOT = resolve(import.meta.dir, "../../../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_MARKER = /<!--\s*\/?north:/i;
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;
export const LINEAR_GRAPH_VALUE_MAX_BYTES = 160 * 1024;

function defaultFramExecutable(): string {
  const binDirectory = process.env.FRAM_BIN
    ?? resolve(process.env.FRAM_HOME ?? resolve(NORTH_ROOT, "../fram"), "bin");
  return resolve(binDirectory, "fram");
}

export interface GraphFact { predicate: string; value: string }

export interface GraphStore {
  show(subject: string): Promise<readonly GraphFact[]>;
  showMany?(subjects: readonly string[]): Promise<ReadonlyMap<string, readonly GraphFact[]>>;
  /** Canonical link subjects carrying exact legacy/bootstrap evidence. */
  findBootstrapLinkSubjects(connector: string, createdAt: string): Promise<readonly string[]>;
  /** Coordinator-serialized graph assertion. Subject is bare; refs retain @. */
  put(subject: string, predicate: string, value: string): Promise<void>;
  /**
   * Atomically reserve the identity -> thread edge after validating the reverse
   * thread endpoint against one global coordinator version.
   */
  reserveLinearBinding(
    lease: SyncLease, linkSubject: string, threadId: string, remoteServer: string,
    bootstrapInitialKey?: string,
  ): Promise<void>;
  /** Assertion whose lease check and graph mutation share one coordinator turn. */
  putFenced(lease: SyncLease, subject: string, predicate: string, value: string): Promise<void>;
}

export interface SyncLease {
  readonly resource: string;
  readonly holder: string;
  readonly epoch: number;
  /** Extend the lease and advance its fencing epoch. */
  renew(): Promise<void>;
  fence(): Promise<void>;
  release(): Promise<void>;
}

export interface SyncLeaseManager { acquire(resource: string): Promise<SyncLease> }

export const LINEAR_SYNC_LEASE_TTL_MS = 300_000;

async function command(file: string, args: readonly string[], options: { timeout?: number } = {}): Promise<string> {
  const result = await execFileAsync(file, [...args], {
    encoding: "utf8",
    timeout: options.timeout ?? 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function commandWithPrivateStdin(
  file: string,
  args: readonly string[],
  value: string,
  options: { timeout?: number } = {},
): Promise<string> {
  const input = Buffer.from(value, "utf8");
  if (input.byteLength > LINEAR_GRAPH_VALUE_MAX_BYTES)
    throw new Error(`Linear fenced graph value exceeds ${LINEAR_GRAPH_VALUE_MAX_BYTES} bytes`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let failing = false;
    let childClosed = false;
    let resolveChildClosed!: () => void;
    const childClose = new Promise<void>((resolve) => { resolveChildClosed = resolve; });
    const timeout = setTimeout(() => { void fail("Linear lease helper timed out"); }, options.timeout ?? 10_000);
    timeout.unref?.();

    function finish(): void {
      clearTimeout(timeout);
      settled = true;
    }

    async function waitForClose(): Promise<boolean> {
      if (childClosed) return true;
      return Promise.race([
        childClose.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
    }

    async function reap(): Promise<void> {
      if (!childClosed && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); }
        catch { /* escalate below */ }
      }
      if (await waitForClose()) return;
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); }
        catch { /* the caller still receives the fixed bounded diagnostic */ }
      }
      await waitForClose();
    }

    async function fail(message: string): Promise<void> {
      if (settled || failing) return;
      failing = true;
      clearTimeout(timeout);
      await reap();
      finish();
      rejectPromise(new Error(message));
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || failing) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
        void fail("Linear lease helper returned an oversized response");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stdout.on("error", () => { void fail("Linear lease helper stdout failed"); });
    // Helper diagnostics may echo arguments, coordinator payloads, or provider
    // content. Drain them for liveness but never retain or surface them.
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => { /* diagnostics are non-authoritative; prevent an unhandled stream error */ });
    child.on("error", () => { void fail("Linear lease helper could not start"); });
    child.on("close", (code) => {
      childClosed = true;
      resolveChildClosed();
      if (settled || failing) return;
      if (code !== 0) {
        void fail("Linear lease helper failed");
        return;
      }
      let output: string;
      try { output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)).trim(); }
      catch {
        void fail("Linear lease helper returned invalid UTF-8");
        return;
      }
      finish();
      resolvePromise(output);
    });
    child.stdin.on("error", () => { void fail("Linear lease helper failed"); });
    child.stdin.end(input);
  });
}

function coordinatorObject(output: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseJsonWithoutDuplicateKeys(output, "coordinator response");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function coordinatorRejection(value: Record<string, unknown> | undefined): string | readonly string[] | undefined {
  if (!value || !hasExactKeys(value, ["reject", "version"]) || !nonnegativeSafeInteger(value.version))
    return undefined;
  if (typeof value.reject === "string" && value.reject) return value.reject;
  if (Array.isArray(value.reject) && value.reject.length
      && value.reject.every((reason) => typeof reason === "string" && reason))
    return value.reject as string[];
  return undefined;
}

function heldCoordinatorLease(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value
    && hasExactKeys(value, ["reject", "holder", "exp", "version"])
    && value.reject === "held"
    && typeof value.holder === "string"
    && value.holder
    && positiveSafeInteger(value.exp)
    && nonnegativeSafeInteger(value.version));
}

function successfulCoordinatorEpoch(
  value: Record<string, unknown> | undefined,
  expectedHolder: string,
): { epoch: number; expiry: number } | undefined {
  return value
    && hasExactKeys(value, ["ok", "holder", "exp", "epoch"])
    && positiveSafeInteger(value.ok)
    && positiveSafeInteger(value.epoch)
    && value.ok === value.epoch
    && positiveSafeInteger(value.exp)
    && value.holder === expectedHolder
    ? { epoch: value.epoch, expiry: value.exp }
    : undefined;
}

export interface NorthGraphStoreOptions {
  leaseInvokeOverride?: (args: readonly string[], stdin?: string) => Promise<string>;
  leaseHelperCommand?: string;
  reservationCli?: string;
  reservationInvokeOverride?: (args: readonly string[]) => Promise<string>;
  bootstrapFinderCli?: string;
  bootstrapFinderInvokeOverride?: (args: readonly string[]) => Promise<string>;
}

export class NorthGraphStore implements GraphStore {
  private leaseInvokeOverride?: (args: readonly string[], stdin?: string) => Promise<string>;
  private leaseHelperCommand: string;
  private reservationCli: string;
  private reservationInvokeOverride?: (args: readonly string[]) => Promise<string>;
  private bootstrapFinderCli: string;
  private bootstrapFinderInvokeOverride?: (args: readonly string[]) => Promise<string>;

  constructor(
    private northBin = process.env.NORTH_BIN ?? resolve(NORTH_ROOT, "bin/north"),
    // FRAM_BIN is the stable directory contract shared with bin/north and the
    // Nix wrappers. A caller that needs a test/program override passes the
    // executable itself through this distinct constructor parameter.
    private framExecutable = defaultFramExecutable(),
    private leaseCli = resolve(NORTH_ROOT, "cli/lease-cli.clj"),
    private port = process.env.NORTH_PORT ?? "7977",
    options: NorthGraphStoreOptions = {},
  ) {
    this.leaseInvokeOverride = options.leaseInvokeOverride;
    this.leaseHelperCommand = options.leaseHelperCommand ?? "bb";
    this.reservationCli = options.reservationCli ?? resolve(import.meta.dir, "reserve-link.clj");
    this.reservationInvokeOverride = options.reservationInvokeOverride;
    this.bootstrapFinderCli = options.bootstrapFinderCli ?? resolve(import.meta.dir, "find-bootstrap-links.clj");
    this.bootstrapFinderInvokeOverride = options.bootstrapFinderInvokeOverride;
  }

  async show(subject: string): Promise<readonly GraphFact[]> {
    const bare = subject.replace(/^@/, "");
    const parsed = JSON.parse(await command(this.northBin, ["json", "show", bare]));
    if (!Array.isArray(parsed) || parsed.some((fact) => typeof fact?.predicate !== "string" || typeof fact?.value !== "string"))
      throw new Error(`north json show returned invalid facts for @${bare}`);
    return parsed;
  }

  async showMany(subjects: readonly string[]): Promise<ReadonlyMap<string, readonly GraphFact[]>> {
    const bareSubjects = [...new Set(subjects.map((subject) => subject.replace(/^@/, "")))];
    const grouped = new Map<string, GraphFact[]>(bareSubjects.map((subject) => [subject, []]));
    if (!bareSubjects.length) return grouped;
    if (bareSubjects.some((subject) => subject.includes(",")))
      throw new Error("north json show-many subjects cannot contain commas");
    const parsed = JSON.parse(await command(this.northBin, ["json", "show-many", bareSubjects.join(",")]));
    if (!Array.isArray(parsed) || parsed.some((fact) =>
      typeof fact?.subject !== "string" || typeof fact?.predicate !== "string" || typeof fact?.value !== "string"))
      throw new Error("north json show-many returned invalid facts");
    for (const fact of parsed as { subject: string; predicate: string; value: string }[]) {
      const rows = grouped.get(fact.subject);
      if (!rows) throw new Error(`north json show-many returned unrequested subject @${fact.subject}`);
      rows.push({ predicate: fact.predicate, value: fact.value });
    }
    return grouped;
  }

  async findBootstrapLinkSubjects(connectorInput: string, createdAt: string): Promise<readonly string[]> {
    const connector = normalizeLinearConnector(connectorInput);
    let output: string;
    try {
      const args = [this.port, connector, createdAt];
      output = this.bootstrapFinderInvokeOverride
        ? await this.bootstrapFinderInvokeOverride(args)
        : await command("bb", [this.bootstrapFinderCli, ...args]);
    } catch {
      throw new Error("Linear bootstrap evidence lookup failed");
    }
    const response = coordinatorObject(output);
    if (!response || !hasExactKeys(response, ["ok"]) || !Array.isArray(response.ok)
        || response.ok.some((subject) =>
          typeof subject !== "string"
          || !/^link:linear:[A-Za-z0-9:._!~*'()%-]+$/.test(subject)))
      throw new Error("Linear bootstrap evidence lookup returned an invalid response");
    const subjects = [...new Set(response.ok as string[])].sort();
    if (subjects.length !== response.ok.length)
      throw new Error("Linear bootstrap evidence lookup returned duplicate subjects");
    return subjects;
  }

  async put(subject: string, predicate: string, value: string): Promise<void> {
    const bare = subject.replace(/^@/, "");
    const output = await command(this.framExecutable, ["tell", bare, predicate, value]);
    if (!output.startsWith("committed via coordinator"))
      throw new Error(`coordinator rejected @${bare} ${predicate}: ${output || "no response"}`);
  }

  async reserveLinearBinding(
    lease: SyncLease, linkSubject: string, threadId: string, remoteServer: string,
    bootstrapInitialKey?: string,
  ): Promise<void> {
    const args = [
      this.port, lease.resource, lease.holder, String(lease.epoch),
      linkSubject.replace(/^@/, ""), threadId.replace(/^@/, ""), remoteServer,
      bootstrapInitialKey ?? "-",
    ];
    const output = this.reservationInvokeOverride
      ? await this.reservationInvokeOverride(args)
      : await command("bb", [this.reservationCli, ...args]);
    const response = coordinatorObject(output);
    if (response && hasExactKeys(response, ["ok"]) && positiveSafeInteger(response.ok)) return;
    if (response && hasExactKeys(response, ["reject"]) && typeof response.reject === "string" && response.reject)
      throw new Error(response.reject);
    throw new Error("Linear binding coordinator returned an invalid reservation response");
  }

  async putFenced(lease: SyncLease, subject: string, predicate: string, value: string): Promise<void> {
    const bare = subject.replace(/^@/, "");
    if (Buffer.byteLength(value, "utf8") > LINEAR_GRAPH_VALUE_MAX_BYTES)
      throw new Error(`Linear fenced graph value exceeds ${LINEAR_GRAPH_VALUE_MAX_BYTES} bytes`);
    const args = [
      "put-fenced-stdin",
      lease.resource, lease.holder, String(lease.epoch),
      `@${bare}`, predicate,
    ];
    let output: string;
    try {
      output = this.leaseInvokeOverride
        ? await this.leaseInvokeOverride(args, value)
        : await commandWithPrivateStdin(
          this.leaseHelperCommand,
          [this.leaseCli, this.port, "--json", ...args],
          value,
        );
    } catch {
      throw new Error(`Linear fenced graph helper failed for @${bare} ${predicate}`);
    }
    const response = coordinatorObject(output);
    if (response && hasExactKeys(response, ["ok"]) && positiveSafeInteger(response.ok)) return;
    const rejection = coordinatorRejection(response);
    if (rejection === "fence-lost")
      throw new Error(`lost Linear sync lease before writing @${bare} ${predicate}`);
    if (rejection)
      throw new Error(`coordinator rejected fenced Linear graph write @${bare} ${predicate}`);
    throw new Error(`Linear lease coordinator returned an invalid fenced-write response for @${bare} ${predicate}`);
  }
}

export class CoordinatorSyncLeaseManager implements SyncLeaseManager {
  constructor(
    private port = process.env.NORTH_PORT ?? "7977",
    private leaseCli = resolve(NORTH_ROOT, "cli/lease-cli.clj"),
    private ttlMs = LINEAR_SYNC_LEASE_TTL_MS,
    private attempts = 50,
    private invokeOverride?: (args: readonly string[]) => Promise<string>,
  ) {
    if (!positiveSafeInteger(ttlMs))
      throw new Error("Linear sync lease TTL must be a positive safe integer");
    if (!positiveSafeInteger(attempts))
      throw new Error("Linear sync lease acquisition attempts must be a positive safe integer");
  }

  private invoke(args: readonly string[]): Promise<string> {
    return this.invokeOverride
      ? this.invokeOverride(args)
      : command("bb", [this.leaseCli, this.port, "--json", ...args]);
  }

  async acquire(resource: string): Promise<SyncLease> {
    if (!resource.trim()) throw new Error("Linear sync lease resource must not be blank");
    const holder = `linear-${process.pid}-${randomUUID()}`;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const output = await this.invoke(["acquire", resource, holder, String(this.ttlMs)]);
      const response = coordinatorObject(output);
      const acquired = successfulCoordinatorEpoch(response, holder);
      if (acquired) {
        const manager = this;
        let released = false;
        let epoch = acquired.epoch;
        return {
          resource, holder,
          get epoch() { return epoch; },
          async renew() {
            if (released) throw new Error(`Linear sync lease ${resource} was already released`);
            const renewed = await manager.invoke([
              "renew", resource, holder, String(epoch), String(manager.ttlMs),
            ]);
            const renewedResponse = coordinatorObject(renewed);
            const next = successfulCoordinatorEpoch(renewedResponse, holder);
            const rejection = coordinatorRejection(renewedResponse);
            if (rejection === "fence-lost")
              throw new Error(`lost Linear sync lease ${resource}`);
            if (!next || next.epoch <= epoch)
              throw new Error(`Linear lease coordinator returned an invalid renewal response for ${resource}`);
            epoch = next.epoch;
          },
          async fence() {
            if (released) throw new Error(`Linear sync lease ${resource} was already released`);
            const fenced = coordinatorObject(await manager.invoke(["fence", resource, holder, String(epoch)]));
            if (fenced && hasExactKeys(fenced, ["fence-ok"]) && fenced["fence-ok"] === false)
              throw new Error(`lost Linear sync lease ${resource}`);
            if (!fenced || !hasExactKeys(fenced, ["fence-ok"]) || fenced["fence-ok"] !== true)
              throw new Error(`Linear lease coordinator returned an invalid fence response for ${resource}`);
          },
          async release() {
            if (released) return;
            const releasedResponse = coordinatorObject(
              await manager.invoke(["release", resource, holder, String(epoch)]),
            );
            const exactRelease = releasedResponse
              && (hasExactKeys(releasedResponse, ["ok"])
                || (hasExactKeys(releasedResponse, ["ok", "noop"]) && releasedResponse.noop === true))
              && positiveSafeInteger(releasedResponse.ok);
            if (!exactRelease)
              throw new Error(`Linear lease coordinator returned an invalid release response for ${resource}`);
            released = true;
          },
        };
      }
      if (!heldCoordinatorLease(response))
        throw new Error(`Linear lease coordinator returned an invalid acquire response for ${resource}`);
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
  ["bootstrap_initial_key", "cardinality", "single"],
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
  // Integration links are fact-bearing entities even though they are not
  // threads. Fram validates this as an entity ref; North owns thread-only refs.
  ["linear_link", "value_kind", "ref"],
] as const;

export interface SchemaInspection {
  ok: boolean;
  missing: readonly string[];
  conflicting: readonly string[];
}

export function isKnownLinearSchemaMigration(inspection: SchemaInspection): boolean {
  return inspection.missing.includes("@linear_link value_kind ref")
    && inspection.conflicting.length === 1
    && inspection.conflicting[0] === "@linear_link value_kind: literal";
}

async function showSubjects(
  graph: GraphStore, subjects: readonly string[],
): Promise<ReadonlyMap<string, readonly GraphFact[]>> {
  const unique = [...new Set(subjects.map((subject) => subject.replace(/^@/, "")))];
  if (graph.showMany) return graph.showMany(unique);
  return new Map(await Promise.all(unique.map(async (subject) => [subject, await graph.show(subject)] as const)));
}

export async function inspectLinearSchema(graph: GraphStore): Promise<SchemaInspection> {
  const missing: string[] = [];
  const conflicting: string[] = [];
  const subjects = await showSubjects(graph, LINEAR_SCHEMA_FACTS.map(([subject]) => subject));
  for (const [subject, predicate, value] of LINEAR_SCHEMA_FACTS) {
    const values = [...new Set(subjects.get(subject)!.filter((fact) => fact.predicate === predicate).map((fact) => fact.value))];
    if (!values.includes(value)) missing.push(`@${subject} ${predicate} ${value}`);
    if (values.some((found) => found !== value)) conflicting.push(`@${subject} ${predicate}: ${values.join(", ")}`);
  }
  return { ok: missing.length === 0 && conflicting.length === 0, missing, conflicting };
}

export async function ensureLinearSchema(graph: GraphStore, prior?: SchemaInspection): Promise<void> {
  const inspection = prior ?? await inspectLinearSchema(graph);
  if (inspection.conflicting.length && !isKnownLinearSchemaMigration(inspection))
    throw new Error(`Linear graph schema conflicts: ${inspection.conflicting.join("; ")}`);
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

function canonicalLinearInstant(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Linear issue ${name} is not a valid timestamp`);
  return new Date(parsed).toISOString();
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
  const key = normalizeLinearRemoteKey(explicitIdentifier ?? (UUID.test(id) ? "" : id));
  if (!key) throw new Error("Linear issue lacks a human identifier");
  const uuidCandidates = [raw.uuid, raw.issueId, explicitIdentifier ? raw.id : undefined]
    .map(optionalString).filter((value): value is string => Boolean(value));
  const nativeUuids = [...new Set(uuidCandidates
    .filter((value) => UUID.test(value))
    .map((value) => value.toLowerCase()))];
  if (nativeUuids.length > 1)
    throw new Error("Linear issue has conflicting native UUID evidence");
  const uuid = nativeUuids[0];
  const teamRaw = typeof raw.team === "object" && raw.team !== null && !Array.isArray(raw.team)
    ? raw.team as Record<string, unknown> : undefined;
  const teamId = optionalString(raw.teamId) ?? optionalString(teamRaw?.id);
  const teamName = optionalString(typeof raw.team === "string" ? raw.team : teamRaw?.name);
  const createdAt = canonicalLinearInstant(requiredString(raw, "createdAt"), "createdAt");
  const updatedAtValue = optionalString(raw.updatedAt);
  return {
    key, uuid, workspace: workspaceFromLinearUrl(url), workspaceId: optionalString(raw.workspaceId),
    title: requiredString(raw, "title"), description: typeof raw.description === "string" ? raw.description : "",
    url, createdAt,
    ...(updatedAtValue ? { updatedAt: canonicalLinearInstant(updatedAtValue, "updatedAt") } : {}),
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
    identityKind: "mcp-bootstrap-v2", connector,
    fingerprint: sha256Canonical({ connector: normalizeLinearConnector(connector), createdAt: issue.createdAt }),
  });
}

export function legacyBootstrapIdentityForIssue(
  issue: LinearIssueDocument,
  connector: string,
): LinearIssueIdentity {
  return normalizeLinearIdentity({
    identityKind: "mcp-bootstrap-v1", connector,
    fingerprint: sha256Canonical({
      connector: normalizeLinearConnector(connector),
      createdAt: issue.createdAt,
      initialKey: issue.key,
    }),
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
  descriptionReceiptHash?: string;
  bodyHash?: string;
  commentKind?: NorthCommentKind;
  commentSourceId?: string;
  baselineAfter?: LinearSyncBaseline;
  marker?: string;
  startedAt: string;
}

export interface LinearOperationReceipt {
  confirmedAt: string;
  remoteId?: string;
}

export const MAX_LINEAR_MANIFEST_RECEIPTS = 32;

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
  receipts?: Record<string, LinearOperationReceipt>;
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
  bootstrapInitialKey?: string;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function exactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  const accepted = new Set(allowed);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => accepted.has(key));
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseJsonWithoutDuplicateKeys(value: string, label: string): unknown {
  const stack: Array<{ kind: "object"; keys: Set<string> } | { kind: "array" }> = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\"") {
      const start = index;
      let escaped = false;
      for (index++; index < value.length; index++) {
        const stringCharacter = value[index]!;
        if (escaped) escaped = false;
        else if (stringCharacter === "\\") escaped = true;
        else if (stringCharacter === "\"") break;
      }
      if (index >= value.length) throw new Error(`${label} is invalid JSON`);
      let next = index + 1;
      while (/[ \t\r\n]/.test(value[next] ?? "")) next++;
      const context = stack.at(-1);
      if (value[next] === ":" && context?.kind === "object") {
        const key = JSON.parse(value.slice(start, index + 1)) as unknown;
        if (typeof key !== "string") throw new Error(`${label} is invalid JSON`);
        if (context.keys.has(key)) throw new Error(`${label} contains duplicate object keys`);
        context.keys.add(key);
      }
    } else if (character === "{") stack.push({ kind: "object", keys: new Set() });
    else if (character === "[") stack.push({ kind: "array" });
    else if (character === "}" || character === "]") stack.pop();
  }
  return JSON.parse(value) as unknown;
}

function parsePendingOperation(
  raw: unknown,
  outerBaseline: LinearSyncBaseline,
): PendingLinearOperation | undefined {
  if (raw === undefined) return undefined;
  const pending = asRecord(raw, "Linear sync pending operation");
  const common = ["key", "kind", "payloadHash", "startedAt"] as const;
  if (typeof pending.key !== "string"
      || !pending.key
      || normalizeText(pending.key) !== pending.key
      || !isSha256(pending.payloadHash)
      || !exactIsoTimestamp(pending.startedAt))
    throw new Error("Linear sync pending operation has an unsupported shape");
  if (pending.kind === "issue") {
    const allowed = [
      ...common, "titleHash", "descriptionHash", "descriptionReceiptHash", "baselineAfter",
    ] as const;
    if (!exactObjectKeys(pending, [...common, "baselineAfter"], allowed)
        || (!isSha256(pending.titleHash) && !isSha256(pending.descriptionHash))
        || (pending.titleHash !== undefined && !isSha256(pending.titleHash))
        || (pending.descriptionHash !== undefined && !isSha256(pending.descriptionHash))
        || (pending.descriptionReceiptHash !== undefined && !isSha256(pending.descriptionReceiptHash))
        || (pending.descriptionHash === undefined && pending.descriptionReceiptHash !== undefined))
      throw new Error("Linear sync pending issue operation has an unsupported shape");
    const baselineAfter = validateLinearSyncBaseline(
      asRecord(pending.baselineAfter, "Linear sync pending baselineAfter") as unknown as LinearSyncBaseline,
    );
    if (baselineAfter.threadId !== outerBaseline.threadId
        || linearIdentityKey(baselineAfter.identity) !== linearIdentityKey(outerBaseline.identity))
      throw new Error("Linear sync pending issue baseline does not match its canonical link");
    return {
      key: pending.key,
      kind: "issue",
      payloadHash: pending.payloadHash,
      startedAt: pending.startedAt,
      ...(isSha256(pending.titleHash) ? { titleHash: pending.titleHash } : {}),
      ...(isSha256(pending.descriptionHash) ? { descriptionHash: pending.descriptionHash } : {}),
      ...(isSha256(pending.descriptionReceiptHash)
        ? { descriptionReceiptHash: pending.descriptionReceiptHash } : {}),
      baselineAfter,
    };
  }
  if (pending.kind === "comment") {
    const allowed = [
      ...common, "bodyHash", "marker", "commentKind", "commentSourceId",
    ] as const;
    if (!exactObjectKeys(
      pending,
      [...common, "bodyHash", "marker", "commentKind", "commentSourceId"],
      allowed,
    )
        || !isSha256(pending.bodyHash)
        || typeof pending.commentKind !== "string"
        || !["progress", "outcome", "learning"].includes(pending.commentKind)
        || typeof pending.commentSourceId !== "string"
        || !pending.commentSourceId
        || normalizeText(pending.commentSourceId) !== pending.commentSourceId
        || typeof pending.marker !== "string"
        || pending.marker !== `<!-- north:comment:${pending.commentKind}:${
          sha256Canonical({
            threadId: outerBaseline.threadId,
            kind: pending.commentKind,
            sourceId: normalizeText(pending.commentSourceId),
          })
        } -->`)
      throw new Error("Linear sync pending comment operation has an unsupported shape");
    return {
      key: pending.key,
      kind: "comment",
      payloadHash: pending.payloadHash,
      bodyHash: pending.bodyHash,
      marker: pending.marker,
      commentKind: pending.commentKind as NorthCommentKind,
      commentSourceId: pending.commentSourceId,
      startedAt: pending.startedAt,
    };
  }
  throw new Error("Linear sync pending operation has an unsupported shape");
}

function validatedReceiptEntries(
  receipts: Readonly<Record<string, LinearOperationReceipt>>,
): [string, LinearOperationReceipt][] {
  return Object.entries(receipts).map(([key, raw]) => {
    const receipt = asRecord(raw, "Linear sync receipt");
    if (!key || normalizeText(key) !== key
        || !exactObjectKeys(receipt, ["confirmedAt"], ["confirmedAt", "remoteId"])
        || !exactIsoTimestamp(receipt.confirmedAt)
        || (receipt.remoteId !== undefined
          && (typeof receipt.remoteId !== "string"
            || !receipt.remoteId
            || normalizeText(receipt.remoteId) !== receipt.remoteId)))
      throw new Error("Linear sync receipt has an unsupported shape");
    return [key, {
      confirmedAt: receipt.confirmedAt,
      ...(typeof receipt.remoteId === "string" ? { remoteId: receipt.remoteId } : {}),
    }];
  });
}

function compareReceiptEntries(
  [leftKey, left]: [string, LinearOperationReceipt],
  [rightKey, right]: [string, LinearOperationReceipt],
): number {
  const byTime = Date.parse(left.confirmedAt) - Date.parse(right.confirmedAt);
  if (byTime) return byTime;
  const byText = left.confirmedAt < right.confirmedAt ? -1
    : left.confirmedAt > right.confirmedAt ? 1 : 0;
  return byText || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
}

export function compactLinearReceipts(
  receipts: Readonly<Record<string, LinearOperationReceipt>>,
): Record<string, LinearOperationReceipt> {
  const entries = validatedReceiptEntries(receipts);
  entries.sort(compareReceiptEntries);
  return Object.fromEntries(entries.slice(-MAX_LINEAR_MANIFEST_RECEIPTS));
}

export function recordLinearReceipt(
  receipts: Readonly<Record<string, LinearOperationReceipt>> | undefined,
  key: string,
  receipt: LinearOperationReceipt,
): Record<string, LinearOperationReceipt> {
  const [current] = validatedReceiptEntries({ [key]: receipt });
  const others = validatedReceiptEntries(receipts ?? {})
    .filter(([existingKey]) => existingKey !== key)
    .sort(compareReceiptEntries)
    .slice(-(MAX_LINEAR_MANIFEST_RECEIPTS - 1));
  return Object.fromEntries([...others, current!].sort(compareReceiptEntries));
}

const manifestsNeedingReceiptCompaction = new WeakSet<LinearSyncManifest>();

export function linearManifestNeedsReceiptCompaction(manifest: LinearSyncManifest): boolean {
  return manifestsNeedingReceiptCompaction.has(manifest);
}

function parseManifest(value: string): LinearSyncManifest {
  if (Buffer.byteLength(value, "utf8") > LINEAR_GRAPH_VALUE_MAX_BYTES)
    throw new Error("Linear sync manifest exceeds the bounded graph value size");
  const raw = asRecord(
    parseJsonWithoutDuplicateKeys(value, "Linear sync manifest"),
    "Linear sync manifest",
  );
  if (!exactObjectKeys(
    raw,
    ["version", "phase", "baseline", "evidence"],
    ["version", "phase", "baseline", "evidence", "pending", "receipts"],
  )
      || raw.version !== 1
      || (raw.phase !== "prepared" && raw.phase !== "adopted"))
    throw new Error("Linear sync manifest has an unsupported shape");
  const evidence = asRecord(raw.evidence, "Linear sync manifest evidence");
  const requiredEvidence = ["connector", "createdAt", "initialKey", "workspace"] as const;
  const allowedEvidence = [
    ...requiredEvidence,
    "importedRawDescriptionHash", "importedTitleHash", "adoptRawDescription",
    "markerBound", "importedAt", "createdThread", "owner",
  ] as const;
  if (!exactObjectKeys(evidence, requiredEvidence, allowedEvidence))
    throw new Error("Linear sync manifest evidence has an unsupported shape");
  if (typeof evidence.connector !== "string"
      || normalizeLinearConnector(evidence.connector) !== evidence.connector)
    throw new Error("Linear sync manifest evidence connector is invalid");
  if (!exactIsoTimestamp(evidence.createdAt))
    throw new Error("Linear sync manifest evidence createdAt is invalid");
  if (typeof evidence.initialKey !== "string"
      || normalizeLinearRemoteKey(evidence.initialKey) !== evidence.initialKey)
    throw new Error("Linear sync manifest evidence initialKey is invalid");
  if (typeof evidence.workspace !== "string"
      || !evidence.workspace
      || normalizeText(evidence.workspace) !== evidence.workspace
      || Buffer.byteLength(evidence.workspace, "utf8") > MAX_LINEAR_REMOTE_KEY_BYTES)
    throw new Error("Linear sync manifest evidence workspace is invalid");
  for (const key of ["markerBound", "adoptRawDescription", "createdThread"])
    if (evidence[key] !== undefined && typeof evidence[key] !== "boolean")
      throw new Error(`Linear sync manifest evidence ${key} must be boolean`);
  if (evidence.importedAt !== undefined && !exactIsoTimestamp(evidence.importedAt))
    throw new Error("Linear sync manifest evidence importedAt is invalid");
  if (evidence.owner !== undefined
      && (typeof evidence.owner !== "string"
        || !evidence.owner
        || normalizeText(evidence.owner) !== evidence.owner
        || Buffer.byteLength(evidence.owner, "utf8") > MAX_LINEAR_REMOTE_KEY_BYTES))
    throw new Error("Linear sync manifest evidence owner is invalid");
  if (evidence.importedRawDescriptionHash !== undefined
      && (typeof evidence.importedRawDescriptionHash !== "string" || !/^[0-9a-f]{64}$/.test(evidence.importedRawDescriptionHash)))
    throw new Error("Linear sync manifest evidence importedRawDescriptionHash is invalid");
  if (evidence.importedTitleHash !== undefined
      && (typeof evidence.importedTitleHash !== "string" || !/^[0-9a-f]{64}$/.test(evidence.importedTitleHash)))
    throw new Error("Linear sync manifest evidence importedTitleHash is invalid");
  const baseline = validateLinearSyncBaseline(asRecord(raw.baseline, "Linear sync manifest baseline") as unknown as LinearSyncBaseline);
  const pending = parsePendingOperation(raw.pending, baseline);
  const receiptRecord = raw.receipts === undefined ? undefined : asRecord(raw.receipts, "Linear sync receipts");
  const receipts = receiptRecord
    ? compactLinearReceipts(receiptRecord as Record<string, LinearOperationReceipt>)
    : undefined;
  const parsedEvidence: LinearSyncManifest["evidence"] = {
    connector: evidence.connector,
    createdAt: evidence.createdAt,
    initialKey: evidence.initialKey,
    workspace: evidence.workspace,
    ...(typeof evidence.importedRawDescriptionHash === "string"
      ? { importedRawDescriptionHash: evidence.importedRawDescriptionHash } : {}),
    ...(typeof evidence.importedTitleHash === "string"
      ? { importedTitleHash: evidence.importedTitleHash } : {}),
    ...(typeof evidence.adoptRawDescription === "boolean"
      ? { adoptRawDescription: evidence.adoptRawDescription } : {}),
    ...(typeof evidence.markerBound === "boolean" ? { markerBound: evidence.markerBound } : {}),
    ...(typeof evidence.importedAt === "string" ? { importedAt: evidence.importedAt } : {}),
    ...(typeof evidence.createdThread === "boolean"
      ? { createdThread: evidence.createdThread } : {}),
    ...(typeof evidence.owner === "string" ? { owner: evidence.owner } : {}),
  };
  const manifest: LinearSyncManifest = {
    version: 1, phase: raw.phase as LinearSyncManifest["phase"], baseline,
    evidence: parsedEvidence,
    ...(pending ? { pending } : {}),
    ...(receipts ? { receipts } : {}),
  };
  if (receiptRecord && Object.keys(receiptRecord).length > MAX_LINEAR_MANIFEST_RECEIPTS)
    manifestsNeedingReceiptCompaction.add(manifest);
  return manifest;
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
  if (identityKind !== undefined
      && identityKind !== "linear-uuid"
      && identityKind !== "mcp-bootstrap-v1"
      && identityKind !== "mcp-bootstrap-v2")
    throw new Error(`partial Linear link @${subject} has unknown identity_kind ${identityKind}`);
  const policy = singleton("sync_policy");
  if (policy !== undefined && policy !== "north-primary") throw new Error(`partial Linear link @${subject} has unsupported sync_policy`);
  const schema = singleton("sync_schema");
  if (schema !== undefined && schema !== "linear-sync-v1") throw new Error(`partial Linear link @${subject} has unsupported sync_schema`);
  const manifestValue = singleton("sync_manifest");
  const manifest = manifestValue ? parseManifest(manifestValue) : undefined;
  const bootstrapInitialKey = singleton("bootstrap_initial_key");
  const threadId = singleton("linked_thread")?.replace(/^@/, "") ?? manifest?.baseline.threadId;
  const common = ["kind", "linked_thread", "remote_key", "remote_server", "remote_workspace_slug", "identity_kind", "sync_policy", "sync_schema", "sync_manifest"];
  const identityPredicates = identityKind === "linear-uuid" ? ["remote_uuid", "remote_workspace"]
    : identityKind === "mcp-bootstrap-v1" || identityKind === "mcp-bootstrap-v2"
      ? ["remote_fingerprint", "bootstrap_initial_key"] : [];
  const complete = [...common, ...identityPredicates].every((predicate) => singleton(predicate) !== undefined);
  return { exists: true, complete, threadId, manifest, bootstrapInitialKey };
}

export async function ensureLinearLinkFacts(
  graph: GraphStore, lease: SyncLease, expected: LinearLinkState,
): Promise<LinearLinkState> {
  const current = await graph.show(expected.subject);
  const required: readonly (readonly [string, string])[] = [
    // The prepared manifest is first: it carries the deterministic thread id and
    // import timestamp needed to heal a crash after any later individual fact.
    ["sync_manifest", canonicalJson(expected.manifest)],
    ["kind", "integration_link"], ["linked_thread", `@${expected.threadId}`],
    ...(expected.identity.identityKind === "linear-uuid"
      ? [["remote_uuid", expected.identity.issueId], ["remote_workspace", expected.identity.workspaceId]] as const
      : [
        ["remote_fingerprint", expected.identity.fingerprint],
        ["bootstrap_initial_key", expected.manifest.evidence.initialKey],
      ] as const),
    ...(expected.remoteScope ? [["remote_scope", expected.remoteScope]] as const : []),
    ["remote_workspace_slug", expected.remoteWorkspaceSlug], ["remote_key", expected.remoteKey],
    ["remote_server", expected.remoteServer], ["identity_kind", expected.identity.identityKind],
    ["sync_policy", "north-primary"], ["sync_schema", "linear-sync-v1"],
  ];
  for (const [predicate, value] of required) {
    const values = [...new Set(current.filter((fact) => fact.predicate === predicate).map((fact) => fact.value))];
    const compactingReceipts = predicate === "sync_manifest"
      && linearManifestNeedsReceiptCompaction(expected.manifest);
    if (compactingReceipts && values.some((found) =>
      canonicalJson(parseManifest(found)) !== value))
      throw new Error(`partial Linear link @${expected.subject} conflicts on ${predicate}`);
    const mutable = ["remote_key", "remote_scope", "remote_workspace_slug"].includes(predicate)
      || compactingReceipts;
    if (!mutable && values.some((found) => found !== value))
      throw new Error(`partial Linear link @${expected.subject} conflicts on ${predicate}`);
    if (!values.includes(value)) {
      await lease.renew();
      await graph.putFenced(lease, expected.subject, predicate, value);
    }
  }
  await lease.renew();
  const loaded = await loadLinkBySubject(graph, expected.subject);
  if (!loaded) throw new Error(`failed to heal Linear link @${expected.subject}`);
  return loaded;
}

export async function loadLinkBySubject(graph: GraphStore, subject: string): Promise<LinearLinkState | null> {
  const facts = await graph.show(subject);
  if (!facts.length) return null;
  if (one(facts, "kind") !== "integration_link") throw new Error(`@${subject} is not an integration_link`);
  const identityKind = one(facts, "identity_kind");
  if (identityKind !== "linear-uuid"
      && identityKind !== "mcp-bootstrap-v1"
      && identityKind !== "mcp-bootstrap-v2")
    throw new Error(`Linear link @${subject} has unknown identity_kind ${String(identityKind)}`);
  const remoteServer = one(facts, "remote_server")!;
  const identity = identityKind === "linear-uuid"
    ? normalizeLinearIdentity({ identityKind, workspaceId: one(facts, "remote_workspace")!, issueId: one(facts, "remote_uuid")! })
    : normalizeLinearIdentity({
      identityKind,
      connector: remoteServer,
      fingerprint: one(facts, "remote_fingerprint")!,
    });
  if (linkSubject(identity) !== subject.replace(/^@/, "")) throw new Error(`Linear link identity does not match @${subject}`);
  const manifest = parseManifest(one(facts, "sync_manifest")!);
  const threadId = one(facts, "linked_thread")!.replace(/^@/, "");
  if (manifest.baseline.threadId !== threadId || canonicalJson(manifest.baseline.identity) !== canonicalJson(identity))
    throw new Error(`Linear link @${subject} manifest identity/thread does not match link facts`);
  const bootstrapInitialKey = one(facts, "bootstrap_initial_key", false);
  if (identity.identityKind !== "linear-uuid"
      && bootstrapInitialKey !== undefined
      && bootstrapInitialKey !== manifest.evidence.initialKey)
    throw new Error(`Linear link @${subject} bootstrap key evidence does not match its manifest`);
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

export async function writeManifest(
  graph: GraphStore, lease: SyncLease, link: LinearLinkState, manifest: LinearSyncManifest,
): Promise<void> {
  await lease.renew();
  await graph.putFenced(lease, link.subject, "sync_manifest", canonicalJson(manifest));
  manifestsNeedingReceiptCompaction.delete(manifest);
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
  graph: GraphStore, lease: SyncLease, threadId: string, issue: LinearIssueDocument, owner: string, now: Date,
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
  for (const [predicate, value] of facts) {
    await lease.renew();
    await graph.putFenced(lease, threadId, predicate, value);
  }
}

export function assertImportableDescription(description: string): void {
  if (RESERVED_MARKER.test(description))
    throw new Error("Linear issue already contains a reserved North marker but has no matching canonical link");
}

export function markerForThread(threadId: string): string {
  return `<!-- north:thread:${normalizeText(threadId).replace(/^@/, "")} -->`;
}
