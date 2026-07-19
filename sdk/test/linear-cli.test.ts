import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LINEAR_LEASE_TIMEOUT_SAFETY_FACTOR, LINEAR_MCP_CALL_TIMEOUT_MS,
  runLinearCommand, type LinearCliDependencies,
} from "../src/integrations/linear/cli";
import {
  assertLinearGraphValue, bootstrapIdentityFromEvidence, compactLinearReceipts,
  CoordinatorSyncLeaseManager, ensureLinearLinkFacts, ensureLinearSchema,
  LINEAR_GRAPH_VALUE_MAX_BYTES,
  LINEAR_SCHEMA_FACTS, LINEAR_SYNC_LEASE_TTL_MS, MAX_LINEAR_MANIFEST_RECEIPTS,
  NorthGraphStore,
  legacyBootstrapIdentityForIssue, linkSubject, loadLinkBySubject,
  loadLinkForThread, normalizeLinearIssueDocument, northThreadIdForIdentity,
  recordLinearReceipt,
  bootstrapEvidenceSubject, canonicalBootstrapEvidence,
  parseBootstrapElection, serializeBootstrapElection,
  type GraphFact, type GraphStore, type LinearBindingReservation, type SyncLease,
  type SyncLeaseManager,
} from "../src/integrations/linear/north-state";
import {
  canonicalJson, MAX_LINEAR_CONNECTOR_BYTES, MAX_LINEAR_REMOTE_KEY_BYTES,
  MAX_LINEAR_THREAD_ID_BYTES, normalizeBody, normalizeLinearConnector,
  sha256Canonical,
} from "../src/integrations/linear/normalize";
import { createLinearSyncBaseline } from "../src/integrations/linear/reconcile";
import { replaceManagedLinearDescription } from "../src/integrations/linear/projection";
import {
  LinearGatewayError, type LinearGateway, type LinearCallEnvelope,
} from "../src/integrations/linear/gateway";
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
  beforeReservationPut?: () => void | Promise<void>;
  beforeSchemaCommit?: (subject: string, predicate: string, value: string) => void | Promise<void>;
  reservations: { link: string; thread: string }[] = [];
  private matchingWrites = 0;
  private version = 0;

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

  async findBootstrapLinkSubjects(connector: string, createdAt: string): Promise<readonly string[]> {
    return [...this.rows.entries()].flatMap(([subject, facts]) => {
      const manifests = facts.filter((fact) => fact.predicate === "sync_manifest");
      if (!manifests.length) {
        return facts.some((fact) => fact.predicate === "linked_thread")
            && subject.startsWith(
              `link:linear:mcp-bootstrap-v1:${encodeURIComponent(connector)}:`,
            )
          ? [subject] : [];
      }
      if (manifests.length !== 1)
        throw new Error("malformed Linear manifest set during bootstrap lookup");
      const manifest = JSON.parse(manifests[0]!.value);
      return manifest.evidence?.connector === connector && manifest.evidence?.createdAt === createdAt
        ? [subject] : [];
    }).sort();
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
    this.version++;
    this.afterPut?.(subject, predicate, value);
  }

  async ensureSchemaFact(
    subject: string,
    predicate: string,
    value: string,
    allowedPrevious?: string,
  ): Promise<void> {
    const bare = subject.replace(/^@/, "");
    let values = new Set((this.rows.get(bare) ?? [])
      .filter((fact) => fact.predicate === predicate)
      .map((fact) => fact.value));
    if (values.size > 1 || [...values].some((found) =>
      found !== value && found !== allowedPrevious))
      throw new Error(`Linear graph schema conflicts on @${subject} ${predicate}`);
    await this.beforeSchemaCommit?.(bare, predicate, value);
    values = new Set((this.rows.get(bare) ?? [])
      .filter((fact) => fact.predicate === predicate)
      .map((fact) => fact.value));
    if (values.size > 1 || [...values].some((found) =>
      found !== value && found !== allowedPrevious))
      throw new Error(`Linear graph schema conflicts on @${subject} ${predicate}`);
    await this.put(subject, predicate, value);
  }

  async putFenced(lease: SyncLease, subject: string, predicate: string, value: string): Promise<void> {
    await lease.fence();
    await this.put(subject, predicate, value);
  }

  async reserveLinearBinding(
    reservation: LinearBindingReservation,
    linkInput: string,
    threadInput: string,
    remoteServer: string,
  ): Promise<void> {
    const link = linkInput.replace(/^@/, "");
    const thread = threadInput.replace(/^@/, "");
    if (Buffer.byteLength(link, "utf8") > 1023
        || !/^link:linear:[A-Za-z0-9:._!~*'()%-]+$/.test(link))
      throw new Error("link subject is not a canonical Linear link id");
    if (Buffer.byteLength(thread, "utf8") > 512
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(thread))
      throw new Error("thread is not a canonical North thread id");
    normalizeLinearConnector(remoteServer);
    const validLease = (lease: SyncLease): boolean =>
      typeof lease.resource === "string" && lease.resource.trim() === lease.resource
      && lease.resource.length > 0
      && typeof lease.holder === "string" && lease.holder.trim() === lease.holder
      && lease.holder.length > 0
      && Number.isSafeInteger(lease.epoch) && lease.epoch > 0;
    if (!validLease(reservation.identityLease))
      throw new Error("identity lease is not canonical");

    const uuidIdentity
      = /^link:linear:uuid:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(link);
    const bootstrapIdentity
      = /^link:linear:(mcp-bootstrap-v[12]):([^:]+):([0-9a-f]{64})$/.exec(link);
    if (!uuidIdentity && !bootstrapIdentity)
      throw new Error("link subject does not contain a canonical Linear identity");
    const parsedKind = uuidIdentity ? "linear-uuid" : bootstrapIdentity![1]!;
    if (parsedKind !== reservation.kind)
      throw new Error("reservation kind does not match its canonical link identity");
    const identityKey = link.slice("link:".length);
    if (reservation.identityLease.resource
        !== `linear-sync:identity:${encodeURIComponent(identityKey)}`)
      throw new Error("identity lease resource does not match the canonical identity");

    let expectedWorkspace: string | undefined;
    let expectedUuid: string | undefined;
    let expectedFingerprint: string | undefined;
    if (reservation.kind === "linear-uuid") {
      expectedWorkspace = uuidIdentity![1]!;
      expectedUuid = uuidIdentity![2]!;
    } else {
      const canonicalEvidence = canonicalBootstrapEvidence(reservation.evidence);
      if (canonicalEvidence.connector !== reservation.evidence.connector
          || canonicalEvidence.createdAt !== reservation.evidence.createdAt
          || canonicalEvidence.initialKey !== reservation.evidence.initialKey)
        throw new Error("bootstrap evidence is not canonical");
      if (!validLease(reservation.evidenceLease))
        throw new Error("bootstrap evidence lease is not canonical");
      const expectedEvidenceResource = `linear-sync:bootstrap:${
        bootstrapEvidenceSubject(canonicalEvidence).slice("linear-bootstrap:".length)
      }`;
      if (reservation.evidenceLease.resource !== expectedEvidenceResource)
        throw new Error("bootstrap evidence lease does not match connector+createdAt");
      if (remoteServer !== canonicalEvidence.connector)
        throw new Error("bootstrap identity connector does not match remote server");
      const expectedIdentity = bootstrapIdentityFromEvidence(
        reservation.kind,
        canonicalEvidence,
      );
      if (link !== linkSubject(expectedIdentity))
        throw new Error("bootstrap identity fingerprint does not match its evidence");
      expectedFingerprint = expectedIdentity.fingerprint;
    }
    const threadRef = `@${thread}`;
    const linkRef = `@${link}`;
    const bootstrapInitialKey = reservation.kind === "linear-uuid"
      ? undefined
      : reservation.evidence.initialKey;
    const evidenceSubject = reservation.kind === "linear-uuid"
      ? undefined
      : bootstrapEvidenceSubject(reservation.evidence);
    const election = reservation.kind === "linear-uuid"
      ? undefined
      : serializeBootstrapElection(
        reservation.evidence,
        linkRef,
        threadRef,
      );
    const projections = reservation.kind === "linear-uuid"
      ? []
      : [
        ["kind", "linear_bootstrap_reservation"],
        ["bootstrap_connector", reservation.evidence.connector],
        ["bootstrap_created_at", reservation.evidence.createdAt],
        ["bootstrap_initial_key", reservation.evidence.initialKey],
        ["canonical_link", linkRef],
        ["linked_thread", threadRef],
      ] as const;
    const values = (subject: string, predicate: string): Set<string> =>
      new Set((this.rows.get(subject) ?? [])
        .filter((fact) => fact.predicate === predicate)
        .map((fact) => fact.value));
    const compatible = (
      subject: string, predicate: string, expected: string, message: string,
    ): void => {
      const found = values(subject, predicate);
      if (found.size > 1 || (found.size === 1 && !found.has(expected)))
        throw new Error(message);
    };
    const queryAuthorityPairs = (predicate: string): readonly (readonly [string, string])[] => {
      const unique = new Map<string, readonly [string, string]>();
      for (const [subject, facts] of this.rows) {
        const subjectRef = `@${subject.replace(/^@/, "")}`;
        for (const fact of facts) {
          if (fact.predicate !== predicate) continue;
          if (typeof fact.value !== "string"
              || Buffer.byteLength(subjectRef, "utf8") > 160 * 1024
              || Buffer.byteLength(fact.value, "utf8") > 160 * 1024)
            throw new Error("Linear reservation received an invalid authority-query response");
          unique.set(JSON.stringify([subjectRef, fact.value]), [subjectRef, fact.value]);
        }
      }
      const rows = [...unique.values()];
      if (rows.length > 10_000)
        throw new Error("Linear reservation received an invalid authority-query response");
      return rows;
    };
    const authorityValuesBySubject = (
      rows: readonly (readonly [string, string])[],
    ): Map<string, Set<string>> => {
      const result = new Map<string, Set<string>>();
      for (const [subject, value] of rows) {
        if (!/^@linear-bootstrap:[0-9a-f]{64}$/.test(subject)) continue;
        const found = result.get(subject) ?? new Set<string>();
        found.add(value);
        result.set(subject, found);
      }
      return result;
    };
    const validateLink = (): void => {
      const existing = values(link, "linked_thread");
      if (existing.size > 1 || (existing.size === 1 && !existing.has(threadRef)))
        throw new Error("canonical Linear identity is already reserved for a different North thread");

      // The real coordinator queries each authority predicate globally, then
      // filters subjects. Model that fail-closed boundary: unrelated hostile
      // rows still count toward the per-relation cardinality and byte limits.
      const linkedRows = queryAuthorityPairs("linked_thread");
      const electionRows = queryAuthorityPairs("bootstrap_election");
      const canonicalLinkRows = queryAuthorityPairs("canonical_link");
      const reverseLinks = linkedRows.filter(([subject, claimedThread]) =>
        subject !== linkRef && subject.startsWith("@link:linear:")
        && claimedThread === threadRef);
      if (reverseLinks.length)
        throw new Error("requested North thread is already reserved by another Linear authority");

      const electionsBySubject = authorityValuesBySubject(electionRows);
      const linksBySubject = authorityValuesBySubject(canonicalLinkRows);
      const threadsBySubject = authorityValuesBySubject(linkedRows);
      const bootstrapSubjects = new Set([
        ...electionsBySubject.keys(),
        ...linksBySubject.keys(),
        ...threadsBySubject.keys(),
      ]);
      for (const subject of bootstrapSubjects) {
        const electionValues = electionsBySubject.get(subject) ?? new Set();
        const projectedLinks = linksBySubject.get(subject) ?? new Set();
        const projectedThreads = threadsBySubject.get(subject) ?? new Set();
        if (electionValues.size > 1)
          throw new Error("Linear reservation found an ambiguous bootstrap election");
        if (electionValues.size === 1) {
          const stored = [...electionValues][0]!;
          if (Buffer.byteLength(stored, "utf8") > 4096)
            throw new Error("Linear reservation found an oversized bootstrap election");
          const parsed = parseBootstrapElection(stored);
          if (`@${bootstrapEvidenceSubject(parsed)}` !== subject)
            throw new Error("Linear reservation found a bootstrap election on the wrong evidence subject");
          if (projectedLinks.size > 1
              || (projectedLinks.size === 1 && !projectedLinks.has(parsed.canonicalLink))
              || projectedThreads.size > 1
              || (projectedThreads.size === 1 && !projectedThreads.has(parsed.linkedThread))) {
            throw new Error("Linear reservation found conflicting bootstrap projections");
          }
          if (parsed.linkedThread === threadRef && parsed.canonicalLink !== linkRef)
            throw new Error("requested North thread is already reserved by another Linear authority");
        } else if (projectedThreads.size) {
          const projectedLink = [...projectedLinks][0];
          const projectedThread = [...projectedThreads][0];
          if (projectedThreads.size !== 1 || projectedLinks.size !== 1
              || !/^@link:linear:[A-Za-z0-9:._!~*'()%-]+$/.test(projectedLink ?? "")
              || !/^@[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(projectedThread ?? ""))
            throw new Error("Linear reservation found partial legacy bootstrap authority");
          if (projectedThreads.has(threadRef) && !projectedLinks.has(linkRef))
            throw new Error("requested North thread is already reserved by another Linear authority");
        }
      }

      const threadLinks = values(thread, "linear_link");
      if (threadLinks.size > 1 || (threadLinks.size === 1 && !threadLinks.has(linkRef)))
        throw new Error("requested North thread already has a different canonical Linear link");
      compatible(link, "kind", "integration_link", "partial Linear link conflicts on kind");
      compatible(
        link, "identity_kind", reservation.kind,
        "partial Linear link conflicts on identity_kind",
      );
      compatible(
        link, "remote_server", remoteServer,
        "partial Linear link conflicts on remote_server",
      );
      compatible(
        link, "sync_policy", "north-primary",
        "partial Linear link conflicts on sync_policy",
      );
      compatible(
        link, "sync_schema", "linear-sync-v1",
        "partial Linear link conflicts on sync_schema",
      );
      if (expectedWorkspace) {
        compatible(
          link, "remote_workspace", expectedWorkspace,
          "partial Linear link conflicts on remote_workspace",
        );
        compatible(
          link, "remote_uuid", expectedUuid!,
          "partial Linear link conflicts on remote_uuid",
        );
      } else {
        compatible(
          link, "remote_fingerprint", expectedFingerprint!,
          "partial Linear link conflicts on remote_fingerprint",
        );
      }
      if (bootstrapInitialKey)
        compatible(
          link, "bootstrap_initial_key", bootstrapInitialKey,
          "partial Linear link conflicts on bootstrap_initial_key",
        );
    };
    const validateEvidence = (): void => {
      if (reservation.kind === "linear-uuid") return;
      const evidenceRows = this.rows.get(evidenceSubject!) ?? [];
      const electionValues = values(evidenceSubject!, "bootstrap_election");
      if (electionValues.size > 1
          || (electionValues.size === 1 && !electionValues.has(election!)))
        throw new Error("Linear bootstrap evidence conflicts on bootstrap_election");
      if (electionValues.size === 0) {
        const legacyPresent = projections.some(([predicate]) =>
          evidenceRows.some((fact) => fact.predicate === predicate));
        const legacyComplete = projections.every(([predicate, expected]) => {
          const found = values(evidenceSubject!, predicate);
          return found.size === 1 && found.has(expected);
        });
        if (legacyPresent && !legacyComplete)
          throw new Error("legacy Linear bootstrap evidence is partial or conflicting");
      }
      for (const [predicate, expected] of projections)
        compatible(
          evidenceSubject!, predicate, expected,
          `Linear bootstrap evidence conflicts on ${predicate}`,
        );
    };
    const validateBinding = (): void => {
      validateEvidence();
      validateLink();
    };
    const casPut = async (
      lease: SyncLease, subject: string, predicate: string, value: string,
      validate: () => void,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const base = this.version;
        validate();
        await lease.fence();
        if (this.version !== base) continue;
        if (values(subject, predicate).has(value)) return;
        await this.put(subject, predicate, value);
        return;
      }
      throw new Error(`Linear reservation raced while healing ${predicate}`);
    };

    validateBinding();
    await this.beforeReservationPut?.();
    if (reservation.kind !== "linear-uuid") {
      await casPut(
        reservation.evidenceLease,
        evidenceSubject!,
        "bootstrap_election",
        election!,
        validateBinding,
      );
      for (const [predicate, value] of projections)
        await casPut(
          reservation.evidenceLease,
          evidenceSubject!,
          predicate,
          value,
          validateEvidence,
        );
      validateEvidence();
    }
    if (bootstrapInitialKey)
      await casPut(
        reservation.identityLease,
        link,
        "bootstrap_initial_key",
        bootstrapInitialKey,
        validateBinding,
      );
    await casPut(
      reservation.identityLease,
      link,
      "linked_thread",
      threadRef,
      validateBinding,
    );
    this.reservations.push({ link, thread });
  }

  seed(subject: string, predicate: string, value: string) {
    const rows = this.rows.get(subject) ?? [];
    rows.push({ predicate, value });
    this.rows.set(subject, rows);
    this.version++;
  }

  replace(subject: string, predicate: string, value: string) {
    const rows = (this.rows.get(subject) ?? [])
      .filter((fact) => fact.predicate !== predicate);
    rows.push({ predicate, value });
    this.rows.set(subject, rows);
    this.version++;
  }
}

class FakeLeases implements SyncLeaseManager {
  private active = new Map<string, { holder: string; epoch: number }>();
  private nextEpoch = 0;
  private renewalCount = 0;
  private loseAtRenewal?: number;
  private throwAtRenewal?: number;
  releaseFailure?: string;
  failAcquireResource?: string;
  onAcquired?: (resource: string) => void | Promise<void>;
  readonly requestedResources: string[] = [];
  readonly acquiredResources: string[] = [];

  activeResources(): readonly string[] {
    return [...this.active.keys()];
  }

  loseOnNthNextRenewal(n: number): void {
    this.loseAtRenewal = this.renewalCount + n;
  }

  throwOnNthNextRenewal(n: number): void {
    this.throwAtRenewal = this.renewalCount + n;
  }

  takeoverActive(matching: (resource: string) => boolean = () => true): void {
    for (const [resource] of this.active)
      if (matching(resource))
        this.active.set(resource, { holder: `successor:${resource}`, epoch: ++this.nextEpoch });
  }

  clearTakeovers(): void {
    for (const [resource, state] of this.active)
      if (state.holder.startsWith("successor:")) this.active.delete(resource);
  }

  async acquire(resource: string): Promise<SyncLease> {
    this.requestedResources.push(resource);
    if (resource === this.failAcquireResource) {
      this.failAcquireResource = undefined;
      throw new Error(`injected acquire failure for ${resource}`);
    }
    while (this.active.has(resource)) await new Promise((done) => setTimeout(done, 1));
    const holder = `fake:${resource}:${this.nextEpoch + 1}`;
    let epoch = ++this.nextEpoch;
    this.active.set(resource, { holder, epoch });
    this.acquiredResources.push(resource);
    await this.onAcquired?.(resource);
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
  commentReadCalls = 0;
  infiniteIssuePages = false;
  oversizedIssueCandidates = false;
  duplicateIssueKey = false;
  issuePaginationFault?: "terminal-cursor" | "missing-cursor";
  issuePageCalls = 0;
  issueReadCalls = 0;
  issueListCalls = 0;
  transientIssueReadFailure = false;
  malformedComment?: "blank-id" | "non-string-body";
  duplicateCommentAcrossPages = false;
  inconsistentCommentCursor = false;
  commentPaginationFault?: "terminal-cursor" | "missing-cursor";
  prepareWriteFailure?: string;
  dispatchWriteFailure?: string;
  closeFailure?: string;
  afterIssueWrite?: () => void;
  afterWrittenIssueRead?: () => void;
  afterCommentPage?: () => void;
  beforeFirstIssueRead?: () => Promise<void>;
  afterIssueRead?: () => void;
  constructor(readonly server = "linear-test") {}

  prepare(envelope: LinearCallEnvelope): { dispatch(): Promise<unknown> } {
    // Mirror the production two-phase boundary: clone the exact accepted
    // envelope now and consume only that prepared value on dispatch.
    const prepared = structuredClone(envelope);
    if (prepared.access === "write" && this.prepareWriteFailure)
      throw new Error(this.prepareWriteFailure);
    let dispatched = false;
    return {
      dispatch: () => {
        if (dispatched) throw new Error("prepared fake Linear call was already dispatched");
        dispatched = true;
        if (prepared.access === "write" && this.dispatchWriteFailure) {
          const message = this.dispatchWriteFailure;
          this.dispatchWriteFailure = undefined;
          throw new Error(message);
        }
        return this.call(prepared);
      },
    };
  }

  async call(envelope: LinearCallEnvelope): Promise<unknown> {
    if (envelope.method === "get_issue") return this.readIssue(envelope.arguments);
    if (envelope.method === "list_issues") return this.listIssues(envelope.arguments);
    if (envelope.method === "save_issue") return this.writeIssue(envelope.arguments);
    if (envelope.method === "list_comments") return this.listComments(envelope.arguments);
    return this.writeComment(envelope.arguments);
  }
  async readIssue(args: Record<string, unknown>): Promise<unknown> {
    if (this.beforeFirstIssueRead) {
      const before = this.beforeFirstIssueRead;
      this.beforeFirstIssueRead = undefined;
      await before();
    }
    this.issueReadCalls++;
    if (this.transientIssueReadFailure) throw new Error("temporary Linear provider outage");
    const key = String(args.id);
    let result: unknown;
    if (key === this.issue.id
        || key === (this.issue as { identifier?: string }).identifier
        || (!this.rejectOldKey && key === "MSA-236")) {
      result = structuredClone(this.issue);
      if (this.issueWrites > 0) this.afterWrittenIssueRead?.();
    } else if (key === this.falsePositive.id) result = structuredClone(this.falsePositive);
    else if (key === "DUP-1" && this.duplicateExact)
      result = {
        ...structuredClone(this.issue),
        id: "DUP-1",
        url: "https://linear.app/msa-team/issue/DUP-1/mechanical-linear-bridge",
      };
    else throw new LinearGatewayError("not-found", `missing issue ${key}`);
    this.afterIssueRead?.();
    return result;
  }
  async listIssues(): Promise<unknown> {
    this.issueListCalls++;
    if (this.issuePaginationFault === "terminal-cursor")
      return { issues: [], hasNextPage: false, nextCursor: "unexpected-terminal-cursor" };
    if (this.issuePaginationFault === "missing-cursor")
      return { issues: [], hasNextPage: true };
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
        ...(this.duplicateExact ? [{
          ...structuredClone(this.issue),
          id: "DUP-1",
          url: "https://linear.app/msa-team/issue/DUP-1/mechanical-linear-bridge",
        }] : [])],
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
  async listComments(args: Record<string, unknown> = {}): Promise<unknown> {
    this.commentReadCalls++;
    if (this.commentPaginationFault === "terminal-cursor")
      return { comments: [], hasNextPage: false, nextCursor: "unexpected-terminal-cursor" };
    if (this.commentPaginationFault === "missing-cursor")
      return { comments: [], hasNextPage: true };
    if (this.malformedComment === "blank-id")
      return { comments: [{ id: " ", body: "managed-looking" }], hasNextPage: false };
    if (this.malformedComment === "non-string-body")
      return { comments: [{ id: "comment-malformed", body: 42 }], hasNextPage: false };
    if (this.infiniteCommentPages) {
      const page = ++this.commentPageCalls;
      this.afterCommentPage?.();
      return { comments: [], hasNextPage: true, nextCursor: `comments-${page}` };
    }
    if (this.duplicateCommentAcrossPages) {
      if (args.cursor === undefined)
        return {
          comments: [{ id: "same-comment", body: "first" }],
          hasNextPage: true,
          nextCursor: "comment-page-2",
        };
      return {
        comments: [{ id: "same-comment", body: "second" }],
        hasNextPage: false,
      };
    }
    if (this.inconsistentCommentCursor)
      return {
        comments: [],
        hasNextPage: true,
        cursor: "cursor-a",
        nextCursor: "cursor-b",
      };
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
  async close(): Promise<void> {
    if (this.closeFailure) throw new Error(this.closeFailure);
  }
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

function seedLegacyBootstrapLink(
  h: ReturnType<typeof harness>,
  key = "MSA-51",
): { link: string; thread: string } {
  h.gateway.issue = {
    ...issue(key),
    id: key,
    teamId: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa",
  };
  const normalized = normalizeLinearIssueDocument(h.gateway.issue);
  const identity = legacyBootstrapIdentityForIssue(normalized, h.gateway.server);
  const link = linkSubject(identity);
  const thread = northThreadIdForIdentity(identity);
  const fields = {
    title: normalized.title,
    body: "Imported body",
    doneWhen: [],
    barEvidence: [],
    repos: [],
    lifecycle: "ready" as const,
  };
  const description = replaceManagedLinearDescription("", thread, fields);
  h.gateway.issue.description = description;
  const manifest = {
    version: 1 as const,
    phase: "adopted" as const,
    baseline: createLinearSyncBaseline(identity, thread, fields),
    evidence: {
      connector: h.gateway.server,
      createdAt: normalized.createdAt,
      initialKey: key,
      workspace: normalized.workspace,
      importedAt: "2026-07-16T15:00:00.000Z",
      createdThread: true,
      owner: "personal",
      markerBound: true,
      adoptRawDescription: false,
      importedRawDescriptionHash: "a".repeat(64),
      importedTitleHash: "b".repeat(64),
    },
    receipts: {},
  };
  for (const [predicate, value] of [
    ["kind", "integration_link"],
    ["linked_thread", `@${thread}`],
    ["remote_key", key],
    ["remote_server", h.gateway.server],
    ["remote_workspace_slug", normalized.workspace],
    ["remote_scope", normalized.teamId ?? ""],
    ["identity_kind", identity.identityKind],
    ["remote_fingerprint", identity.fingerprint],
    ["sync_policy", "north-primary"],
    ["sync_schema", "linear-sync-v1"],
    ["sync_manifest", canonicalJson(manifest)],
  ] as const) {
    if (value) h.graph.seed(link, predicate, value);
  }
  h.graph.seed(thread, "title", normalized.title);
  h.graph.seed(thread, "linear_link", `@${link}`);
  return { link, thread };
}

async function fakeCoordinator() {
  const requests: Buffer[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    const chunks: Buffer[] = [];
    let replied = false;
    socket.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      const request = Buffer.concat(chunks);
      if (!replied && request.includes(0x0a)) {
        replied = true;
        requests.push(request);
        socket.end("{:ok 11}\n");
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as { port: number };
  return {
    port: String(address.port),
    requests,
    connections: () => connections,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

async function fakeCoordinatorReplies(replies: readonly string[]) {
  const requests: Buffer[] = [];
  let nextReply = 0;
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    let replied = false;
    socket.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      const request = Buffer.concat(chunks);
      if (replied || !request.includes(0x0a)) return;
      replied = true;
      requests.push(request);
      socket.end(replies[nextReply++] ?? "{:error \"unexpected query\"}\n");
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as { port: number };
  return {
    port: String(address.port),
    requests,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

async function runProcessWithInput(
  command: string,
  args: readonly string[],
  chunks: readonly Buffer[],
): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.on("error", () => {});
  for (const chunk of chunks) child.stdin.write(chunk);
  child.stdin.end();
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
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

test("import dry-run enforces real binding preconditions and reports healing instead of reuse", async () => {
  const h = harness();
  const thread = await importThread(h);
  const writes = h.graph.writes.length;
  await expect(runLinearCommand(
    ["import", "MSA-236", "--thread", "different-thread", "--dry-run"],
    h.dependencies,
  )).rejects.toThrow(`already prepared for @${thread}`);

  h.graph.rows.set(
    thread,
    h.graph.rows.get(thread)!.filter(({ predicate }) => predicate !== "linear_link"),
  );
  const healing = await runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    h.dependencies,
  ) as { actions: string[] };
  expect(healing.actions).toContain("write-canonical-reverse-link");
  expect(healing.actions).not.toContain("reuse-link");
  expect(h.graph.writes).toHaveLength(writes);

  const missing = harness();
  await expect(runLinearCommand(
    ["import", "MSA-236", "--thread", "missing-thread", "--dry-run"],
    missing.dependencies,
  )).rejects.toThrow("does not exist");

  const conflicting = harness();
  conflicting.graph.seed("occupied-thread", "title", "Occupied");
  conflicting.graph.seed("occupied-thread", "linear_link", "@link:someone-else");
  await expect(runLinearCommand(
    ["import", "MSA-236", "--thread", "occupied-thread", "--dry-run"],
    conflicting.dependencies,
  )).rejects.toThrow("different canonical Linear link");

  const reserved = harness();
  reserved.gateway.issue.description = "<!-- north:thread:someone-else -->";
  await expect(runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    reserved.dependencies,
  )).rejects.toThrow("unclosed North-managed Linear block");
});

test("import dry-run checks schema, fresh identity, and prepared-manifest drift without writes", async () => {
  const schemaConflict = harness();
  schemaConflict.graph.seed("linked_thread", "cardinality", "multi");
  const schemaWrites = schemaConflict.graph.writes.length;
  await expect(runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    schemaConflict.dependencies,
  )).rejects.toThrow("Linear graph schema conflicts");
  expect(schemaConflict.graph.writes).toHaveLength(schemaWrites);

  const identityDrift = harness();
  let drifted = false;
  identityDrift.gateway.afterIssueRead = () => {
    if (drifted) return;
    drifted = true;
    identityDrift.gateway.issue.createdAt = "2026-07-16T14:08:21.639Z";
  };
  await expect(runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    identityDrift.dependencies,
  )).rejects.toThrow("identity changed during import");
  expect(identityDrift.graph.writes).toHaveLength(0);

  const preparedDrift = harness();
  const preview = await runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    preparedDrift.dependencies,
  ) as { link: string };
  preparedDrift.graph.failSubjectPrefix = preview.link.replace(/^@/, "");
  // Bootstrap key and linked_thread are mutations one/two. Let the prepared
  // manifest land as mutation three, then crash before the remaining link facts.
  preparedDrift.graph.failAfter = 3;
  await expect(importThread(preparedDrift)).rejects.toThrow("injected graph crash");
  preparedDrift.gateway.issue.title = "Changed during prepared import";
  const preparedWrites = preparedDrift.graph.writes.length;
  await expect(runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    preparedDrift.dependencies,
  )).rejects.toThrow("title/description changed");
  expect(preparedDrift.graph.writes).toHaveLength(preparedWrites);
});

test("minted import fails closed when its deterministic thread id is already occupied", async () => {
  const h = harness();
  const preview = await runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    h.dependencies,
  ) as { thread: string };
  h.graph.seed(preview.thread.replace(/^@/, ""), "title", "Unrelated existing thread");
  const writes = h.graph.writes.length;

  await expect(runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    h.dependencies,
  )).rejects.toThrow("already exists without its canonical Linear link");
  expect(h.graph.writes).toHaveLength(writes);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);

  await expect(runLinearCommand(["import", "MSA-236"], h.dependencies))
    .rejects.toThrow("already exists without its canonical Linear link");
  expect(h.graph.writes).toHaveLength(writes);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);
});

test("representative mechanical lifecycle converges, no-ops, and recovers from conflict", async () => {
  const h = harness();
  const doctorBefore = await runLinearCommand(["doctor"], h.dependencies) as {
    modelTurn: boolean; oauth: boolean; graphSchema: { ok: boolean };
    graphSchemaBootstrap: { applied: boolean; assertions: number };
  };
  expect(doctorBefore).toMatchObject({
    modelTurn: false, oauth: true, graphSchema: { ok: true, missing: [], conflicting: [] },
    graphSchemaBootstrap: { applied: true, assertions: 25 },
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

  const commentReadsBeforeApply = h.gateway.commentReadCalls;
  const applied = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as {
    writes: number; state: string;
  };
  expect(applied).toMatchObject({ writes: 2, state: "in-sync" });
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.gateway.commentReadCalls - commentReadsBeforeApply).toBe(1);
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

test("repeated UUID import preserves identity across mutable Linear metadata", async () => {
  const h = harness();
  const issueUuid = "11111111-1111-8111-8111-111111111111";
  const workspaceUuid = "22222222-2222-8222-8222-222222222222";
  h.gateway.issue = Object.assign(issue("MSA-236"), {
    id: issueUuid,
    identifier: "MSA-236",
    workspaceId: workspaceUuid,
  });
  const first = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string;
  };
  h.gateway.issue = {
    ...h.gateway.issue,
    identifier: "PLATFORM-9",
    workspaceId: workspaceUuid.toUpperCase(),
    teamId: "team-b",
    url: "https://linear.app/renamed-workspace/issue/PLATFORM-9/mechanical-linear-bridge",
  };

  const repeated = await runLinearCommand(["import", "PLATFORM-9"], h.dependencies) as {
    link: string; thread: string; reused: boolean;
  };
  expect(repeated).toMatchObject({
    link: first.link,
    thread: first.thread,
    reused: true,
  });
  const linkFacts = await h.graph.show(first.link);
  expect(linkFacts.find(({ predicate }) => predicate === "remote_key")?.value)
    .toBe("PLATFORM-9");
  expect(linkFacts.find(({ predicate }) => predicate === "remote_scope")?.value)
    .toBe("team-b");
  expect(linkFacts.find(({ predicate }) => predicate === "remote_workspace_slug")?.value)
    .toBe("renamed-workspace");

  h.gateway.issue.workspaceId = "33333333-3333-8333-8333-333333333333";
  await expect(runLinearCommand(["plan", first.thread], h.dependencies))
    .rejects.toThrow("could not be verified before backlink adoption");
});

test("conflicting native issue UUID evidence fails before graph mutation", async () => {
  const h = harness();
  h.gateway.issue = Object.assign(issue("MSA-236"), {
    id: "11111111-1111-8111-8111-111111111111",
    identifier: "MSA-236",
    uuid: "33333333-3333-8333-8333-333333333333",
    workspaceId: "22222222-2222-8222-8222-222222222222",
  });
  await expect(runLinearCommand(["import", "MSA-236"], h.dependencies))
    .rejects.toThrow("conflicting native UUID evidence");
  expect(h.graph.writes).toHaveLength(0);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);
});

test("helper-bound connector, thread, and remote-key metadata reject oversized argv inputs", async () => {
  const native = harness("x".repeat(MAX_LINEAR_CONNECTOR_BYTES + 1));
  native.gateway.issue = Object.assign(issue("MSA-236"), {
    id: "11111111-1111-8111-8111-111111111111",
    identifier: "MSA-236",
    workspaceId: "22222222-2222-8222-8222-222222222222",
  });
  await expect(runLinearCommand(["import", "MSA-236"], native.dependencies))
    .rejects.toThrow("connector must be canonical");
  expect(native.graph.writes).toHaveLength(0);
  expect(native.leases.requestedResources).toHaveLength(0);

  const thread = harness();
  await expect(runLinearCommand([
    "import",
    "MSA-236",
    "--thread",
    "t".repeat(MAX_LINEAR_THREAD_ID_BYTES + 1),
  ], thread.dependencies)).rejects.toThrow("threadId is not safe");
  expect(thread.opened).toHaveLength(0);
  expect(thread.graph.writes).toHaveLength(0);

  const key = "K".repeat(MAX_LINEAR_REMOTE_KEY_BYTES + 1);
  const remote = harness();
  remote.gateway.issue = issue(key);
  await expect(runLinearCommand(["import", key], remote.dependencies))
    .rejects.toThrow("issue id must be canonical");
  expect(remote.graph.writes).toHaveLength(0);
  expect(remote.leases.requestedResources).toHaveLength(0);
});

test("authority text profile rejects U+0085 and U+FEFF in intake and stored elections", () => {
  for (const character of ["\u0085", "\uFEFF"]) {
    const connector = `linear-${character}-authority`;
    const createdAt = "2026-07-16T14:08:20.639Z";
    const initialKey = "MSA-236";
    expect(() => bootstrapIdentityFromEvidence("mcp-bootstrap-v2", {
      connector, createdAt, initialKey,
    })).toThrow("connector must be canonical");
    const fingerprint = sha256Canonical({ connector, createdAt });
    expect(() => parseBootstrapElection(canonicalJson({
      canonicalLink: `@link:linear:mcp-bootstrap-v2:${
        encodeURIComponent(connector)
      }:${fingerprint}`,
      connector,
      createdAt,
      initialKey,
      linkedThread: "@thread-authority-text",
    }))).toThrow("connector must be canonical");

    const safeConnector = "linear-authority-text";
    const unsafeInitialKey = `MSA-${character}-236`;
    const safeFingerprint = sha256Canonical({
      connector: safeConnector,
      createdAt,
    });
    expect(() => canonicalBootstrapEvidence({
      connector: safeConnector,
      createdAt,
      initialKey: unsafeInitialKey,
    })).toThrow("issue key must be canonical");
    expect(() => parseBootstrapElection(canonicalJson({
      canonicalLink: `@link:linear:mcp-bootstrap-v2:${safeConnector}:${
        safeFingerprint
      }`,
      connector: safeConnector,
      createdAt,
      initialKey: unsafeInitialKey,
      linkedThread: "@thread-authority-text",
    }))).toThrow("issue key must be canonical");
  }
});

test("provider timestamps canonicalize equivalent instants and reject invalid evidence", async () => {
  const h = harness();
  const first = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string;
  };
  h.gateway.issue.createdAt = "2026-07-16T10:08:20.639-04:00";
  const repeated = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string; reused: boolean;
  };
  expect(repeated).toMatchObject({
    link: first.link,
    thread: first.thread,
    reused: true,
  });

  h.gateway.issue.createdAt = "2026-07-16T14:08:20.639000Z";
  const zeroPrecision = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string;
  };
  expect(zeroPrecision).toMatchObject({ link: first.link, thread: first.thread });

  for (const timestamp of [
    "not-an-instant",
    "0",
    "1/2/03",
    "2026-07-19",
    "2026-07-19T12:00:00",
    "2026-07-19 12:00:00Z",
    "2026-02-29T12:00:00Z",
    "2026-07-19T24:00:00Z",
    "2026-07-19T12:00:60Z",
    "2026-07-19T12:00:00+14:01",
    "2026-07-19T12:00:00+15:00",
    "2026-07-19T12:00:00-00:00",
    "2026-07-19T12:00:00.1234Z",
  ]) {
    const invalid = harness();
    invalid.gateway.issue.createdAt = timestamp;
    await expect(runLinearCommand(["import", "MSA-236"], invalid.dependencies))
      .rejects.toThrow(
        /must be canonical|supported canonical instant|unsupported sub-millisecond precision/,
      );
    expect(invalid.graph.writes).toHaveLength(0);
    expect(invalid.leases.requestedResources).toHaveLength(0);
    expect(invalid.gateway.issueWrites).toBe(0);
    expect(invalid.gateway.commentWrites).toBe(0);
  }

  const modulePath = resolve(
    import.meta.dir,
    "../src/integrations/linear/north-state.ts",
  );
  const script = `
    import { bootstrapEvidenceSubject } from ${JSON.stringify(modulePath)};
    process.stdout.write(bootstrapEvidenceSubject({
      connector: "linear-test",
      createdAt: "2026-07-16T10:08:20.639-04:00",
      initialKey: "MSA-236",
    }));
  `;
  const subjectInTimezone = async (timezone: string): Promise<string> => {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, TZ: timezone },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    return stdout;
  };
  const timezoneSubjects = await Promise.all([
    subjectInTimezone("UTC"),
    subjectInTimezone("America/New_York"),
    subjectInTimezone("Asia/Taipei"),
  ]);
  expect(new Set(timezoneSubjects).size).toBe(1);
});

test("bootstrap-v2 collisions fail closed until an exact managed marker proves reuse", async () => {
  const h = harness();
  const first = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string;
  };
  h.gateway.issue = {
    ...h.gateway.issue,
    id: "PLATFORM-9",
    url: "https://linear.app/renamed/issue/PLATFORM-9/same-created-at",
  };
  const writes = h.graph.writes.length;
  await expect(runLinearCommand(["import", "PLATFORM-9"], h.dependencies))
    .rejects.toThrow("exact managed marker is required");
  expect(h.graph.writes).toHaveLength(writes);
  expect([...h.graph.rows.keys()].filter((subject) =>
    subject.startsWith("link:linear:mcp-bootstrap-v2:"))).toHaveLength(1);

  h.gateway.issue.description = replaceManagedLinearDescription(
    "",
    first.thread.replace(/^@/, ""),
    {
      title: h.gateway.issue.title,
      body: "Imported body",
      doneWhen: [],
      barEvidence: [],
      repos: [],
      lifecycle: "ready",
    },
  );
  const proven = await runLinearCommand(["import", "PLATFORM-9"], h.dependencies) as {
    link: string; thread: string;
  };
  expect(proven).toMatchObject({ link: first.link, thread: first.thread });
});

test("live-shaped bootstrap-v1 marker reimport preserves the old canonical subject", async () => {
  const h = harness();
  const legacy = seedLegacyBootstrapLink(h);
  h.gateway.issue = {
    ...h.gateway.issue,
    id: "PLATFORM-51",
    url: "https://linear.app/renamed/issue/PLATFORM-51/live-shaped",
  };

  const imported = await runLinearCommand(["import", "PLATFORM-51"], h.dependencies) as {
    identity: { identityKind: string };
    link: string;
    thread: string;
  };
  expect(imported).toMatchObject({
    identity: { identityKind: "mcp-bootstrap-v1" },
    link: `@${legacy.link}`,
    thread: `@${legacy.thread}`,
  });
  expect([...h.graph.rows.keys()].filter((subject) =>
    subject.startsWith("link:linear:mcp-bootstrap-v2:"))).toHaveLength(0);
  expect((await h.graph.show(legacy.link))
    .find((fact) => fact.predicate === "remote_key")?.value).toBe("PLATFORM-51");
  expect((await h.graph.show(legacy.link))
    .find((fact) => fact.predicate === "bootstrap_initial_key")?.value).toBe("MSA-51");
});

test("renamed bootstrap-v1 evidence without a marker cannot mint a v2 identity", async () => {
  const h = harness();
  const legacy = seedLegacyBootstrapLink(h);
  h.gateway.issue = {
    ...h.gateway.issue,
    id: "PLATFORM-51",
    description: "No managed marker yet",
    url: "https://linear.app/renamed/issue/PLATFORM-51/pre-marker",
  };
  const writes = h.graph.writes.length;
  await expect(runLinearCommand(["import", "PLATFORM-51"], h.dependencies))
    .rejects.toThrow("bootstrap evidence already exists under another identity");
  expect(h.graph.writes).toHaveLength(writes);
  expect(h.graph.rows.has(legacy.link)).toBe(true);
  expect([...h.graph.rows.keys()].filter((subject) =>
    subject.startsWith("link:linear:mcp-bootstrap-v2:"))).toHaveLength(0);

  const partial = harness();
  const oldIssue = normalizeLinearIssueDocument(partial.gateway.issue);
  const oldIdentity = legacyBootstrapIdentityForIssue(oldIssue, partial.gateway.server);
  const partialLink = linkSubject(oldIdentity);
  partial.graph.seed(partialLink, "linked_thread", "@legacy-crash-thread");
  partial.gateway.issue = {
    ...partial.gateway.issue,
    id: "RENAMED-236",
    description: "Still no marker",
    url: "https://linear.app/renamed/issue/RENAMED-236/partial-v1",
  };
  await expect(runLinearCommand(["import", "RENAMED-236"], partial.dependencies))
    .rejects.toThrow("bootstrap evidence already exists under another identity");
  expect([...partial.graph.rows.keys()].filter((subject) =>
    subject.startsWith("link:linear:mcp-bootstrap-v2:"))).toHaveLength(0);
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

test("bootstrap, identity, and thread acquisition is canonical with durable collision evidence first", async () => {
  const h = harness();
  const imported = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string;
  };
  const [bootstrapResource, identityResource, threadResource] = h.leases.requestedResources;
  expect(bootstrapResource).toStartWith("linear-sync:bootstrap:");
  expect(identityResource).toStartWith("linear-sync:identity:");
  expect(threadResource).toBe(`linear-sync:thread:${encodeURIComponent(imported.thread.replace(/^@/, ""))}`);
  expect(identityResource! < threadResource!).toBe(true);
  expect(identityResource).toContain("%3A");
  expect(h.graph.writes[0]?.subject).toMatch(/^linear-bootstrap:/);
  expect(h.graph.writes[0]?.predicate).toBe("bootstrap_election");
  expect(JSON.parse(h.graph.writes[0]!.value)).toMatchObject({
    canonicalLink: imported.link,
    linkedThread: imported.thread,
    initialKey: "MSA-236",
  });
  expect(h.graph.writes.some(({ subject, predicate, value }) =>
    subject === imported.link.replace(/^@/, "")
    && predicate === "linked_thread"
    && value === imported.thread)).toBe(true);
});

test("distinct Linear identities cannot concurrently reserve the same explicit North thread", async () => {
  const graph = new FakeGraph();
  const leases = new FakeLeases();
  const thread = "shared-explicit-thread";
  graph.seed(thread, "title", "Shared thread");
  const first = new FakeGateway("linear-first");
  const second = new FakeGateway("linear-second");
  second.issue = {
    ...issue("MSA-237"),
    createdAt: "2026-07-16T14:09:20.639Z",
    updatedAt: "2026-07-16T14:09:20.639Z",
  };
  const dependencies = (gateway: FakeGateway): Partial<LinearCliDependencies> => ({
    graph, leases, mintThreadId: northThreadIdForIdentity,
    now: () => new Date("2026-07-16T15:00:00.000Z"),
    openGateway: async () => gateway,
  });
  const settled = await Promise.allSettled([
    runLinearCommand(["import", "MSA-236", "--thread", thread], dependencies(first)),
    runLinearCommand(["import", "MSA-237", "--thread", thread], dependencies(second)),
  ]);
  expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
  const claimants = [...graph.rows.entries()].filter(([subject, facts]) =>
    subject.startsWith("link:linear:")
    &&
    facts.some(({ predicate, value }) => predicate === "linked_thread" && value === `@${thread}`));
  expect(claimants).toHaveLength(1);
  expect((await graph.show(thread)).filter(({ predicate }) => predicate === "linear_link")).toHaveLength(1);
  expect(first.issueWrites + second.issueWrites).toBe(0);
  expect(first.commentWrites + second.commentWrites).toBe(0);
  expect(leases.activeResources()).toEqual([]);
});

test("reverse reservation includes partial links without a kind fact", async () => {
  const h = harness();
  const thread = "partial-claim-thread";
  h.graph.seed(thread, "title", "Existing");
  h.graph.seed("link:linear:partial-crash", "linked_thread", `@${thread}`);
  const writesBefore = h.graph.writes.length;
  await expect(runLinearCommand(
    ["import", "MSA-236", "--thread", thread], h.dependencies,
  )).rejects.toThrow("already reserved by");
  expect(h.graph.writes).toHaveLength(writesBefore);
  expect(h.gateway.issueWrites).toBe(0);
});

test("canonical UUID identity uses one alias-free lock across two server aliases", async () => {
  const graph = new FakeGraph();
  const leases = new FakeLeases();
  const issueUuid = "11111111-1111-8111-8111-111111111111";
  const workspaceUuid = "22222222-2222-8222-8222-222222222222";
  const first = new FakeGateway("linear-alias-a");
  const second = new FakeGateway("linear-alias-b");
  first.issue = Object.assign(issue("MSA-236"), {
    id: issueUuid, identifier: "MSA-236", workspaceId: workspaceUuid,
  });
  second.issue = Object.assign(structuredClone(first.issue), {
    id: issueUuid.toUpperCase(),
    workspaceId: workspaceUuid.toUpperCase(),
  });
  let arrived = 0;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const rendezvous = async () => {
    arrived++;
    if (arrived === 2) openGate();
    await gate;
  };
  first.beforeFirstIssueRead = rendezvous;
  second.beforeFirstIssueRead = rendezvous;
  const dependencies = (gateway: FakeGateway): Partial<LinearCliDependencies> => ({
    graph, leases, mintThreadId: northThreadIdForIdentity,
    now: () => new Date("2026-07-16T15:00:00.000Z"),
    openGateway: async () => gateway,
  });
  const settled = await Promise.allSettled([
    runLinearCommand(["import", "MSA-236"], dependencies(first)),
    runLinearCommand(["import", "MSA-236"], dependencies(second)),
  ]);
  expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
  const identityRequests = leases.requestedResources.filter((resource) =>
    resource.startsWith("linear-sync:identity:"));
  expect(identityRequests).toHaveLength(2);
  expect(new Set(identityRequests).size).toBe(1);
  expect(identityRequests[0]).not.toContain("alias");
  const canonicalLinks = [...graph.rows.entries()].filter(([subject, facts]) =>
    subject.startsWith("link:linear:uuid:")
      && facts.some(({ predicate }) => predicate === "linked_thread"));
  expect(canonicalLinks).toHaveLength(1);
  expect(first.issueWrites + second.issueWrites).toBe(0);
  expect(leases.activeResources()).toEqual([]);
});

test("thread lease acquisition failure releases identity without graph or remote mutation", async () => {
  const h = harness();
  const thread = "acquire-failure-thread";
  h.graph.seed(thread, "title", "Existing");
  h.leases.failAcquireResource = `linear-sync:thread:${encodeURIComponent(thread)}`;
  const writesBefore = h.graph.writes.length;
  await expect(runLinearCommand(
    ["import", "MSA-236", "--thread", thread], h.dependencies,
  )).rejects.toThrow("injected acquire failure");
  expect(h.graph.writes).toHaveLength(writesBefore);
  expect(h.graph.reservations).toHaveLength(0);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);
  expect(h.leases.activeResources()).toEqual([]);
});

test("thread takeover inside the identity-fenced reservation leaves only healable ownership", async () => {
  const h = harness();
  const preview = await runLinearCommand(
    ["import", "MSA-236", "--dry-run"], h.dependencies,
  ) as { link: string; thread: string };
  const link = preview.link.replace(/^@/, "");
  const thread = preview.thread.replace(/^@/, "");
  const threadResource = `linear-sync:thread:${encodeURIComponent(thread)}`;
  h.graph.beforeReservationPut = () => {
    h.graph.beforeReservationPut = undefined;
    h.leases.takeoverActive((resource) => resource === threadResource);
  };

  await expect(runLinearCommand(["import", "MSA-236"], h.dependencies))
    .rejects.toThrow("lost fake lease");
  expect((await h.graph.show(link))
    .filter(({ predicate, value }) => predicate === "linked_thread" && value === `@${thread}`))
    .toHaveLength(1);
  expect(h.graph.writes.some(({ subject, predicate, value }) =>
    subject.startsWith("linear-bootstrap:")
    && predicate === "bootstrap_election"
    && JSON.parse(value).canonicalLink === `@${link}`
    && JSON.parse(value).linkedThread === `@${thread}`)).toBe(true);
  expect(h.graph.writes.some(({ subject, predicate, value }) =>
    subject === link && predicate === "linked_thread" && value === `@${thread}`)).toBe(true);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);
  expect(h.leases.activeResources()).toEqual([threadResource]);

  h.leases.clearTakeovers();
  const recovered = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string; reused: boolean; action: string;
  };
  expect(recovered).toMatchObject({
    link: `@${link}`, thread: `@${thread}`, reused: false, action: "heal-link",
  });
  expect((await h.graph.show(link))
    .filter(({ predicate, value }) => predicate === "linked_thread" && value === `@${thread}`))
    .toHaveLength(1);
  expect(h.leases.activeResources()).toEqual([]);
});

test("partial link and partial thread crashes heal using the prepared identity and importedAt", async () => {
  const linkCrash = harness();
  linkCrash.graph.failSubjectPrefix = "link:linear:";
  linkCrash.graph.failAfter = 3;
  await expect(importThread(linkCrash)).rejects.toThrow("injected graph crash");
  const healed = await runLinearCommand(["import", "MSA-236"], linkCrash.dependencies) as {
    thread: string; reused: boolean; action: string;
  };
  expect(healed).toMatchObject({ reused: false, action: "heal-link" });
  expect((await linkCrash.graph.show(healed.thread.replace(/^@/, "")))
    .some(({ predicate }) => predicate === "committed")).toBe(true);

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

test("pending comment recovery rejects a padded provider comment identifier", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  await h.graph.put(thread, "progress", "Canonical remote comment identity.");
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  h.graph.failSubjectPrefix = link;
  h.graph.failPredicate = "sync_manifest";
  h.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("injected graph crash");
  expect(h.gateway.comments).toHaveLength(1);
  h.gateway.comments[0]!.id = ` ${h.gateway.comments[0]!.id} `;

  const writesBeforeRecovery = h.graph.writes.length;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("comment id must be canonical");
  const recovered = JSON.parse(
    (await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value,
  );
  expect(recovered.pending).toBeDefined();
  expect(h.graph.writes).toHaveLength(writesBeforeRecovery);
  expect(h.gateway.commentWrites).toBe(1);
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

test("pending manifests are exact, operation-specific, and reject before remote or graph work", async () => {
  const malformedPending = [
    {
      key: "bad-issue", kind: "issue", payloadHash: "a".repeat(64),
      startedAt: "2026-07-16T15:00:00.000Z",
    },
    {
      key: "bad-comment", kind: "comment", payloadHash: "a".repeat(64),
      bodyHash: "b".repeat(64), startedAt: "2026-07-16T15:00:00.000Z",
    },
    {
      key: "crossed-fields", kind: "comment", payloadHash: "a".repeat(64),
      bodyHash: "b".repeat(64), marker: "north:comment:x", titleHash: "c".repeat(64),
      startedAt: "2026-07-16T15:00:00.000Z",
    },
  ];
  for (const pending of malformedPending) {
    const h = harness();
    const thread = await importThread(h);
    const link = (await h.graph.show(thread))
      .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
    h.graph.rows.set(link, h.graph.rows.get(link)!.map((fact) => {
      if (fact.predicate !== "sync_manifest") return fact;
      return {
        ...fact,
        value: JSON.stringify({ ...JSON.parse(fact.value), pending }),
      };
    }));
    const reads = h.gateway.issueReadCalls;
    const writes = h.graph.writes.length;
    await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
      .rejects.toThrow("pending");
    expect(h.gateway.issueReadCalls).toBe(reads);
    expect(h.gateway.issueWrites).toBe(0);
    expect(h.gateway.commentWrites).toBe(0);
    expect(h.graph.writes).toHaveLength(writes);
  }

  for (const foreign of ["thread", "identity"] as const) {
    const h = harness();
    const thread = await importThread(h);
    const link = (await h.graph.show(thread))
      .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
    h.graph.rows.set(link, h.graph.rows.get(link)!.map((fact) => {
      if (fact.predicate !== "sync_manifest") return fact;
      const manifest = JSON.parse(fact.value);
      const identity = foreign === "identity"
        ? {
          identityKind: "mcp-bootstrap-v1",
          connector: manifest.baseline.identity.connector,
          fingerprint: "f".repeat(64),
        }
        : manifest.baseline.identity;
      const threadId = foreign === "thread" ? "foreign-thread" : manifest.baseline.threadId;
      const baselineAfter = {
        ...manifest.baseline,
        identity,
        threadId,
        hash: sha256Canonical({ identity, threadId, fieldHashes: manifest.baseline.fieldHashes }),
      };
      return {
        ...fact,
        value: JSON.stringify({
          ...manifest,
          pending: {
            key: `foreign-${foreign}`,
            kind: "issue",
            payloadHash: "a".repeat(64),
            titleHash: "b".repeat(64),
            baselineAfter,
            startedAt: "2026-07-16T15:00:00.000Z",
          },
        }),
      };
    }));
    const reads = h.gateway.issueReadCalls;
    const writes = h.graph.writes.length;
    await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
      .rejects.toThrow("pending issue baseline does not match its canonical link");
    expect(h.gateway.issueReadCalls).toBe(reads);
    expect(h.gateway.issueWrites).toBe(0);
    expect(h.gateway.commentWrites).toBe(0);
    expect(h.graph.writes).toHaveLength(writes);
  }
});

test("legacy underspecified comment pending fails before its first provider read", async () => {
  const h = harness();
  const thread = await importThread(h);
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  h.graph.rows.set(link, h.graph.rows.get(link)!.map((fact) => {
    if (fact.predicate !== "sync_manifest") return fact;
    const manifest = JSON.parse(fact.value);
    manifest.pending = {
      key: "legacy-comment",
      kind: "comment",
      payloadHash: "a".repeat(64),
      bodyHash: "b".repeat(64),
      marker: `<!-- north:comment:progress:${"c".repeat(64)} -->`,
      startedAt: "2026-07-16T15:00:00.000Z",
    };
    return { ...fact, value: JSON.stringify(manifest) };
  }));
  const reads = h.gateway.issueReadCalls;
  const writes = h.graph.writes.length;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("pending comment operation has an unsupported shape");
  expect(h.gateway.issueReadCalls).toBe(reads);
  expect(h.graph.writes).toHaveLength(writes);
});

test("pending comment identity cannot be rebound to another thread's managed marker", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  await h.graph.put(thread, "progress", "Original pending comment.");
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  h.graph.failSubjectPrefix = link;
  h.graph.failPredicate = "sync_manifest";
  h.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("injected graph crash");
  expect(h.gateway.comments).toHaveLength(1);

  const foreignKind = "progress";
  const foreignSourceId = "foreign-source";
  const foreignMarker = `<!-- north:comment:${foreignKind}:${
    sha256Canonical({
      threadId: "different-thread",
      kind: foreignKind,
      sourceId: foreignSourceId,
    })
  } -->`;
  const foreignBody = `Original pending comment.\n\n${foreignMarker}`;
  h.gateway.comments[0]!.body = foreignBody;
  h.graph.rows.set(link, h.graph.rows.get(link)!.map((fact) => {
    if (fact.predicate !== "sync_manifest") return fact;
    const manifest = JSON.parse(fact.value);
    manifest.pending.marker = foreignMarker;
    manifest.pending.commentKind = foreignKind;
    manifest.pending.commentSourceId = foreignSourceId;
    manifest.pending.bodyHash = sha256Canonical(normalizeBody(foreignBody));
    return { ...fact, value: JSON.stringify(manifest) };
  }));
  const reads = h.gateway.issueReadCalls;
  const writes = h.graph.writes.length;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("pending comment operation has an unsupported shape");
  expect(h.gateway.issueReadCalls).toBe(reads);
  expect(h.gateway.commentWrites).toBe(1);
  expect(h.graph.writes).toHaveLength(writes);
});

test("receipt retention stays constant through 1000 operations and pending recovery survives compaction", async () => {
  let receipts = {};
  let cumulativeBytes = 0;
  let maximumBytes = 0;
  for (let index = 0; index < 1_000; index++) {
    receipts = recordLinearReceipt(receipts, `operation-${String(index).padStart(4, "0")}`, {
      confirmedAt: new Date(Date.UTC(2026, 6, 16, 15, 0, 0, index)).toISOString(),
      remoteId: `remote-${index}`,
    });
    const bytes = Buffer.byteLength(JSON.stringify(receipts));
    cumulativeBytes += bytes;
    maximumBytes = Math.max(maximumBytes, bytes);
    expect(Object.keys(receipts).length).toBeLessThanOrEqual(MAX_LINEAR_MANIFEST_RECEIPTS);
  }
  expect(maximumBytes).toBeLessThan(8 * 1024);
  expect(cumulativeBytes).toBeLessThan(8 * 1024 * 1_000);

  const equalTimestamp = "2026-07-16T15:00:00.000Z";
  const forward = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
    `equal-${String(index).padStart(3, "0")}`, { confirmedAt: equalTimestamp },
  ]));
  const reverse = Object.fromEntries(Object.entries(forward).reverse());
  expect(compactLinearReceipts(forward)).toEqual(compactLinearReceipts(reverse));
  const tiedAtCapacity = Object.fromEntries(Array.from(
    { length: MAX_LINEAR_MANIFEST_RECEIPTS },
    (_, index) => [
      `zz-existing-${String(index).padStart(3, "0")}`,
      { confirmedAt: equalTimestamp },
    ],
  ));
  const withCurrent = recordLinearReceipt(
    tiedAtCapacity,
    "aa-current-confirmation",
    { confirmedAt: equalTimestamp, remoteId: "current-remote" },
  );
  expect(Object.keys(withCurrent)).toHaveLength(MAX_LINEAR_MANIFEST_RECEIPTS);
  expect(withCurrent["aa-current-confirmation"]).toEqual({
    confirmedAt: equalTimestamp,
    remoteId: "current-remote",
  });
  expect(() => compactLinearReceipts({
    valid: { confirmedAt: equalTimestamp },
    invalid: { confirmedAt: "not-a-timestamp" },
  })).toThrow("unsupported shape");

  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  const historicalReceipts = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
    `historical-${String(index).padStart(4, "0")}`,
    {
      confirmedAt: new Date(Date.UTC(2026, 6, 15, 0, 0, 0, index)).toISOString(),
      remoteId: `historical-remote-${index}`,
    },
  ]));
  h.graph.rows.set(link, h.graph.rows.get(link)!.map((fact) => {
    if (fact.predicate !== "sync_manifest") return fact;
    return {
      ...fact,
      value: JSON.stringify({ ...JSON.parse(fact.value), receipts: historicalReceipts }),
    };
  }));
  const writesBeforePreview = h.graph.writes.length;
  const receiptPreview = await runLinearCommand(
    ["import", "MSA-236", "--dry-run"],
    h.dependencies,
  ) as { actions: string[] };
  expect(receiptPreview.actions).toContain("compact-receipts");
  expect(receiptPreview.actions).not.toContain("reuse-link");
  expect(h.graph.writes).toHaveLength(writesBeforePreview);

  const expected = (await loadLinkBySubject(h.graph, link))!;
  const historicalManifest = h.graph.rows.get(link)!
    .find(({ predicate }) => predicate === "sync_manifest")!.value;
  h.graph.rows.set(link, h.graph.rows.get(link)!.map((fact) => {
    if (fact.predicate !== "sync_manifest") return fact;
    const concurrent = JSON.parse(fact.value);
    concurrent.evidence.owner = "concurrent-writer";
    return { ...fact, value: JSON.stringify(concurrent) };
  }));
  const compactionLease = await h.leases.acquire("linear-sync:identity:compaction-test");
  const writesBeforeConflict = h.graph.writes.length;
  await expect(ensureLinearLinkFacts(h.graph, compactionLease, expected))
    .rejects.toThrow("conflicts on sync_manifest");
  expect(h.graph.writes).toHaveLength(writesBeforeConflict);
  await compactionLease.release();
  h.graph.rows.set(link, h.graph.rows.get(link)!.map((fact) =>
    fact.predicate === "sync_manifest"
      ? { ...fact, value: historicalManifest }
      : fact));

  const graphWritesBeforeCompaction = h.graph.writes.length;
  const compacted = await runLinearCommand(["sync", thread, "--apply"], h.dependencies) as {
    writes: number;
  };
  expect(compacted.writes).toBe(0);
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.graph.writes).toHaveLength(graphWritesBeforeCompaction + 1);
  const storedCompacted = JSON.parse(
    (await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value,
  );
  expect(Object.keys(storedCompacted.receipts ?? {})).toHaveLength(
    MAX_LINEAR_MANIFEST_RECEIPTS,
  );

  await h.graph.put(thread, "progress", "Compaction survives pending recovery.");
  h.graph.failSubjectPrefix = link;
  h.graph.failPredicate = "sync_manifest";
  h.graph.failAfter = 1;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("injected graph crash");
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  const interrupted = JSON.parse(
    (await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value,
  );
  expect(Object.keys(interrupted.receipts ?? {})).toHaveLength(MAX_LINEAR_MANIFEST_RECEIPTS);
  expect(interrupted.pending).toMatchObject({ kind: "comment" });

  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  expect(h.gateway.issueWrites).toBe(1);
  expect(h.gateway.commentWrites).toBe(1);
  const recovered = JSON.parse(
    (await h.graph.show(link)).find(({ predicate }) => predicate === "sync_manifest")!.value,
  );
  expect(recovered.pending).toBeUndefined();
  expect(Object.keys(recovered.receipts ?? {}).length).toBeLessThanOrEqual(MAX_LINEAR_MANIFEST_RECEIPTS);
  expect(await runLinearCommand(["plan", thread], h.dependencies))
    .toMatchObject({ state: "in-sync", actions: [] });
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

test("apply revalidates the exact locked endpoint before pending recovery or remote work", async () => {
  const h = harness();
  h.gateway.issue = Object.assign(issue("MSA-236"), {
    id: "11111111-1111-8111-8111-111111111111",
    identifier: "MSA-236",
    workspaceId: "22222222-2222-8222-8222-222222222222",
  });
  const thread = await importThread(h);
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  const writesBefore = h.graph.writes.length;
  h.leases.onAcquired = (resource) => {
    if (!resource.startsWith("linear-sync:identity:")) return;
    const rows = h.graph.rows.get(link)!;
    h.graph.rows.set(link, rows.map((fact) =>
      fact.predicate === "remote_server" ? { ...fact, value: "linear-other" } : fact));
  };

  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("endpoint changed while its leases were being acquired");
  expect(h.graph.writes).toHaveLength(writesBefore);
  expect(h.gateway.issueWrites).toBe(0);
  expect(h.gateway.commentWrites).toBe(0);
  expect(h.leases.activeResources()).toEqual([]);
});

for (const endpoint of ["identity", "thread"] as const) {
  test(`loss of ${endpoint} endpoint after pending intent prevents a remote side effect`, async () => {
    const h = harness();
    const thread = await importThread(h);
    h.graph.afterPut = (_subject, predicate, value) => {
      if (predicate !== "sync_manifest" || !JSON.parse(value).pending) return;
      h.graph.afterPut = undefined;
      h.leases.takeoverActive((resource) => resource.startsWith(`linear-sync:${endpoint}:`));
    };
    await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
      .rejects.toThrow("lost fake lease");
    expect(h.gateway.issueWrites).toBe(0);
    expect(h.gateway.commentWrites).toBe(0);
    const link = (await h.graph.show(thread))
      .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
    expect(JSON.parse((await h.graph.show(link))
      .find(({ predicate }) => predicate === "sync_manifest")!.value).pending)
      .toMatchObject({ kind: "issue" });
    h.leases.clearTakeovers();
  });

  test(`loss of ${endpoint} endpoint after remote commit preserves intent for no-duplicate recovery`, async () => {
    const h = harness();
    const thread = await importThread(h);
    h.gateway.afterIssueWrite = () => {
      h.gateway.afterIssueWrite = undefined;
      h.leases.takeoverActive((resource) => resource.startsWith(`linear-sync:${endpoint}:`));
    };
    await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
      .rejects.toThrow("lost fake lease");
    expect(h.gateway.issueWrites).toBe(1);
    const link = (await h.graph.show(thread))
      .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
    expect(JSON.parse((await h.graph.show(link))
      .find(({ predicate }) => predicate === "sync_manifest")!.value).pending)
      .toMatchObject({ kind: "issue" });
    h.leases.clearTakeovers();
    await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
    expect(h.gateway.issueWrites).toBe(1);
    expect(await runLinearCommand(["plan", thread], h.dependencies))
      .toMatchObject({ state: "in-sync", actions: [] });
  });
}

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
    { leaseInvokeOverride: async () => response.value },
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

test("binding reservation accepts only exact coordinator envelopes", async () => {
  const calls: string[][] = [];
  const lease: SyncLease = {
    resource: "linear-sync:identity:linear%3Auuid%3Aws%3A11111111-1111-8111-8111-111111111111",
    holder: "holder", epoch: 10,
    renew: async () => {}, fence: async () => {}, release: async () => {},
  };
  const response = { value: JSON.stringify({ ok: 11 }) };
  const store = new NorthGraphStore(
    "/unused/north", "/unused/fram", "/unused/lease-cli.clj", "7977",
    {
      reservationCli: "/unused/reserve-link.clj",
      reservationInvokeOverride: async (args) => {
        calls.push([...args]);
        return response.value;
      },
    },
  );
  await store.reserveLinearBinding(
    { kind: "linear-uuid", identityLease: lease },
    "link:linear:uuid:ws:11111111-1111-8111-8111-111111111111", "thread-a",
    "linear-test",
  );
  expect(calls[0]).toEqual([
    "7977", lease.resource, lease.holder, "10",
    "link:linear:uuid:ws:11111111-1111-8111-8111-111111111111", "thread-a", "linear-test",
    "linear-uuid",
  ]);
  response.value = JSON.stringify({ reject: "reservation collision" });
  await expect(store.reserveLinearBinding(
    { kind: "linear-uuid", identityLease: lease },
    "link:x", "thread-a", "linear-test",
  ))
    .rejects.toThrow("reservation collision");
  response.value = JSON.stringify({ ok: 12, surplus: true });
  await expect(store.reserveLinearBinding(
    { kind: "linear-uuid", identityLease: lease },
    "link:x", "thread-a", "linear-test",
  ))
    .rejects.toThrow("invalid reservation response");
});

test("fenced graph values use bounded private stdin and accept payloads beyond argv limits", async () => {
  const coordinator = await fakeCoordinator();
  const leaseCli = resolve(import.meta.dir, "../../cli/lease-cli.clj");
  const lease: SyncLease = {
    resource: "linear-sync:private", holder: "holder", epoch: 10,
    renew: async () => {}, fence: async () => {}, release: async () => {},
  };
  try {
    const escapeUnit = "\"\\\n";
    const value = escapeUnit.repeat(Math.floor(LINEAR_GRAPH_VALUE_MAX_BYTES / 3))
      + "x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES % 3);
    expect(Buffer.byteLength(value, "utf8")).toBe(LINEAR_GRAPH_VALUE_MAX_BYTES);
    const store = new NorthGraphStore(
      "/unused/north", "/unused/fram", leaseCli, coordinator.port,
    );
    await store.putFenced(lease, "link:x", "sync_manifest", value);
    expect(coordinator.requests).toHaveLength(1);
    expect(coordinator.requests[0]!.byteLength).toBeGreaterThan(value.length);
    expect(coordinator.requests[0]!.byteLength).toBeLessThanOrEqual(1024 * 1024 + 1);
    expect(coordinator.requests[0]!.includes(Buffer.from(':te "@link:x"'))).toBe(true);

    let invoked = false;
    const bounded = new NorthGraphStore(
      "/unused/north", "/unused/fram", "/unused/lease-cli.clj", "7977",
      {
        leaseInvokeOverride: async () => {
          invoked = true;
          return JSON.stringify({ ok: 12 });
        },
      },
    );
    await expect(bounded.putFenced(
      lease,
      "link:x",
      "sync_manifest",
      "x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES + 1),
    )).rejects.toThrow(`exceeds ${LINEAR_GRAPH_VALUE_MAX_BYTES} bytes`);
    expect(invoked).toBe(false);

    let capturedArgs: readonly string[] = [];
    let capturedStdin = "";
    const canary = "private-manifest-canary";
    const inspected = new NorthGraphStore(
      "/unused/north", "/unused/fram", "/unused/lease-cli.clj", "7977",
      {
        leaseInvokeOverride: async (args, stdin) => {
          capturedArgs = args;
          capturedStdin = stdin ?? "";
          return JSON.stringify({ ok: 13 });
        },
      },
    );
    await inspected.putFenced(lease, "link:x", "sync_manifest", canary);
    expect(capturedArgs).toEqual([
      "put-fenced-stdin", lease.resource, lease.holder, "10", "@link:x", "sync_manifest",
    ]);
    expect(JSON.stringify(capturedArgs)).not.toContain(canary);
    expect(capturedStdin).toBe(canary);
  } finally {
    await coordinator.close();
  }
});

test("bootstrap evidence helper bounds scans and validates exact coordinator metadata", async () => {
  const finder = resolve(
    import.meta.dir,
    "../src/integrations/linear/find-bootstrap-links.clj",
  );
  const createdAt = "2026-07-16T14:08:20.639Z";
  const oversizedRows = Array.from(
    { length: 10_001 },
    () => '["@link:linear:mcp-bootstrap-v1:linear-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "{}"]',
  ).join(" ");
  const duplicateManifest = JSON.stringify(
    `{"evidence":{"connector":"linear-test","connector":"linear-test","createdAt":"${createdAt}"}}`,
  );
  const cases = [
    '{:ok [] :version -1 :engine "index"}\n',
    '{:ok [] :version 1 :engine "unreviewed"}\n',
    `{:ok [${oversizedRows}] :version 1 :engine "index"}\n`,
    `{:ok [["@link:linear:mcp-bootstrap-v1:linear-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ${
      JSON.stringify("x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES + 1))
    }]] :version 1 :engine "index"}\n`,
    `{:ok [["@link:linear:mcp-bootstrap-v1:linear-test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ${
      duplicateManifest
    }]] :version 1 :engine "index"}\n`,
  ];
  for (const reply of cases) {
    const coordinator = await fakeCoordinatorReplies([reply]);
    try {
      const result = await runProcessWithInput(
        "bb",
        [finder, coordinator.port, "linear-test", createdAt],
        [],
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
        reject: "Linear bootstrap evidence lookup failed",
      });
      expect(coordinator.requests).toHaveLength(1);
    } finally {
      await coordinator.close();
    }
  }
});

test("lease helper enforces its own byte/UTF-8 boundary before coordinator mutation", async () => {
  const coordinator = await fakeCoordinator();
  const leaseCli = resolve(import.meta.dir, "../../cli/lease-cli.clj");
  const args = [
    leaseCli, coordinator.port, "--json", "put-fenced-stdin",
    "linear-sync:private", "holder", "10", "@link:x", "sync_manifest",
  ];
  try {
    const scalar = Buffer.from("é");
    const value = Buffer.from(`${"x".repeat(130 * 1024)}é-tail`);
    const scalarAt = value.indexOf(scalar);
    const split = await runProcessWithInput("bb", args, [
      value.subarray(0, scalarAt + 1),
      value.subarray(scalarAt + 1),
    ]);
    expect(split.code).toBe(0);
    expect(JSON.parse(split.stdout.toString("utf8"))).toEqual({ ok: 11 });
    expect(coordinator.connections()).toBe(1);
    expect(coordinator.requests[0]!.includes(value)).toBe(true);

    const beforeOversize = coordinator.connections();
    const oversized = await runProcessWithInput(
      "bb", args, [Buffer.alloc(LINEAR_GRAPH_VALUE_MAX_BYTES + 1, 0x78)],
    );
    expect(oversized.code).toBe(2);
    expect(oversized.stderr.toString("utf8")).toContain(
      `fenced value exceeds ${LINEAR_GRAPH_VALUE_MAX_BYTES} bytes`,
    );
    expect(coordinator.connections()).toBe(beforeOversize);

    const invalid = await runProcessWithInput("bb", args, [
      Buffer.from([0x7b, 0xc3, 0x28, 0x7d]),
    ]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr.toString("utf8")).toContain("fenced value must be valid UTF-8");
    expect(coordinator.connections()).toBe(beforeOversize);
  } finally {
    await coordinator.close();
  }
});

test("private helper failures are sanitized, fatally decoded, and reap stubborn children", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-linear-private-helper-"));
  try {
    const canary = "manifest-canary-never-surface";
    const echoFailure = join(directory, "echo-failure");
    const echoPid = join(directory, "echo-failure.pid");
    writeFileSync(echoFailure, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[2], String(process.pid));
let value = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { value += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => { process.stderr.write(value); process.exit(17); }, 100);
});
`);
    chmodSync(echoFailure, 0o700);
    const lease: SyncLease = {
      resource: "linear-sync:private", holder: "holder", epoch: 10,
      renew: async () => {}, fence: async () => {}, release: async () => {},
    };
    const failing = new NorthGraphStore(
      "/unused/north", "/unused/fram", echoPid, "7977",
      { leaseHelperCommand: echoFailure },
    );
    const failure = failing.putFenced(lease, "link:x", "sync_manifest", canary);
    for (let attempt = 0; attempt < 50 && !existsSync(echoPid); attempt++)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const echoHelperPid = Number(readFileSync(echoPid, "utf8"));
    const commandLine = readFileSync(`/proc/${echoHelperPid}/cmdline`);
    expect(commandLine.includes(Buffer.from(canary))).toBe(false);
    try {
      await failure;
      throw new Error("expected private helper failure");
    } catch (error) {
      expect((error as Error).message).toBe(
        "Linear fenced graph helper failed for @link:x sync_manifest",
      );
      expect(String(error)).not.toContain(canary);
    }

    const invalidUtf8 = join(directory, "invalid-utf8");
    writeFileSync(invalidUtf8, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
});
`);
    chmodSync(invalidUtf8, 0o700);
    const invalid = new NorthGraphStore(
      "/unused/north", "/unused/fram", "/unused/lease-cli.clj", "7977",
      { leaseHelperCommand: invalidUtf8 },
    );
    await expect(invalid.putFenced(lease, "link:x", "sync_manifest", "safe"))
      .rejects.toThrow("Linear fenced graph helper failed");

    const pidPath = join(directory, "stubborn.pid");
    const stubborn = join(directory, "stubborn");
    writeFileSync(stubborn, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
process.stdout.write(Buffer.alloc(${4 * 1024 * 1024 + 1}, 0x78));
setInterval(() => {}, 1000);
`);
    chmodSync(stubborn, 0o700);
    const reaping = new NorthGraphStore(
      "/unused/north", "/unused/fram", pidPath, "7977",
      { leaseHelperCommand: stubborn },
    );
    const startedAt = Date.now();
    await expect(reaping.putFenced(lease, "link:x", "sync_manifest", "safe"))
      .rejects.toThrow("Linear fenced graph helper failed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  h.gateway.afterCommentPage = () => h.leases.takeoverActive();

  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("lost fake lease");
  expect(h.gateway.commentPageCalls).toBe(1);
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
  expect(primary.leases.activeResources()).toEqual([]);

  const successful = harness();
  const successfulThread = await importThread(successful);
  successful.leases.releaseFailure = "release transport failed";
  await expect(runLinearCommand(["sync", successfulThread, "--apply"], successful.dependencies))
    .rejects.toThrow("release transport failed");
  expect(successful.leases.activeResources()).toEqual([]);
});

test("gateway close never masks a primary failure but fails an otherwise successful command", async () => {
  const primary = harness();
  const primaryThread = await importThread(primary);
  primary.gateway.infiniteCommentPages = true;
  primary.gateway.closeFailure = "gateway close failed";
  await expect(runLinearCommand(["plan", primaryThread], primary.dependencies))
    .rejects.toThrow("Linear list_comments exceeded 20 pages");

  const successful = harness();
  successful.gateway.closeFailure = "gateway close failed";
  await expect(runLinearCommand(["get", "MSA-236"], successful.dependencies))
    .rejects.toThrow("gateway close failed");
});

for (const malformed of ["blank-id", "non-string-body"] as const) {
  test(`malformed Linear comment ${malformed} fails closed`, async () => {
    const h = harness();
    const thread = await importThread(h);
    h.gateway.malformedComment = malformed;
    await expect(runLinearCommand(["plan", thread], h.dependencies))
      .rejects.toThrow(malformed === "blank-id" ? "comment id must be canonical" : "string body");
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
  issues.gateway.issue = {
    ...issues.gateway.issue,
    id: "NEW-1",
    url: "https://linear.app/msa-team/issue/NEW-1/mechanical-linear-bridge",
  };
  issues.gateway.rejectOldKey = true;
  issues.gateway.infiniteIssuePages = true;
  await expect(runLinearCommand(["plan", issuesThread], issues.dependencies))
    .rejects.toThrow("Linear list_issues exceeded 20 pages");
  expect(issues.gateway.issuePageCalls).toBe(20);

  const issueItems = harness();
  const issueItemsThread = await importThread(issueItems);
  await runLinearCommand(["sync", issueItemsThread, "--apply"], issueItems.dependencies);
  issueItems.gateway.issue = {
    ...issueItems.gateway.issue,
    id: "NEW-1",
    url: "https://linear.app/msa-team/issue/NEW-1/mechanical-linear-bridge",
  };
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

test("transient stored-key outage is one failed read and never amplifies into backlink search", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  h.gateway.issueReadCalls = 0;
  h.gateway.issueListCalls = 0;
  h.gateway.transientIssueReadFailure = true;
  await expect(runLinearCommand(["plan", thread], h.dependencies))
    .rejects.toThrow("temporary Linear provider outage");
  expect(h.gateway.issueReadCalls).toBe(1);
  expect(h.gateway.issueListCalls).toBe(0);
});

test("marker relocation rejects duplicate exact matches", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  h.gateway.issue = {
    ...h.gateway.issue,
    id: "NEW-1",
    url: "https://linear.app/msa-team/issue/NEW-1/mechanical-linear-bridge",
  };
  h.gateway.rejectOldKey = true;
  h.gateway.duplicateExact = true;
  await expect(runLinearCommand(["plan", thread], h.dependencies)).rejects.toThrow("found 2 exact issue");
});

test("marker relocation rejects duplicate issue keys before last-write-wins collection", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  h.gateway.issue = {
    ...h.gateway.issue,
    id: "NEW-1",
    url: "https://linear.app/msa-team/issue/NEW-1/mechanical-linear-bridge",
  };
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
    graphSchemaBootstrap: { applied: true, assertions: 25 },
  });
  expect(h.graph.writes).toHaveLength(25);
  expect(h.graph.bulkReads).toBe(3);
  expect(h.graph.showReads).toBe(0);
  const readsBeforeSecondDoctor = h.graph.bulkReads;
  const second = await runLinearCommand(["doctor"], h.dependencies);
  expect(second).toMatchObject({
    graphSchema: { ok: true, missing: [], conflicting: [] },
    graphSchemaBootstrap: { applied: false, assertions: 0 },
  });
  expect(h.graph.writes).toHaveLength(25);
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
    graphSchemaBootstrap: { applied: true, assertions: 25 },
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
  await expect(runLinearCommand(["import", "MSA-236"], h.dependencies))
    .rejects.toThrow("bootstrap link evidence does not match");
});

test("stored manifests reject unknown fields, noncanonical instants, and duplicate JSON keys", async () => {
  const h = harness();
  const thread = await importThread(h);
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  const rows = h.graph.rows.get(link)!;
  const manifestIndex = rows.findIndex(({ predicate }) => predicate === "sync_manifest");
  const original = rows[manifestIndex]!.value;
  const parsed = JSON.parse(original);
  const variants = [
    JSON.stringify({ ...parsed, unsupportedTopLevel: true }),
    JSON.stringify({
      ...parsed,
      evidence: { ...parsed.evidence, unsupportedEvidence: true },
    }),
    JSON.stringify({
      ...parsed,
      evidence: {
        ...parsed.evidence,
        importedAt: "2026-07-16T11:00:00-04:00",
      },
    }),
    JSON.stringify({
      ...parsed,
      baseline: { ...parsed.baseline, unsupportedBaseline: true },
    }),
    JSON.stringify({
      ...parsed,
      baseline: {
        ...parsed.baseline,
        identity: { ...parsed.baseline.identity, unsupportedIdentity: true },
      },
    }),
    JSON.stringify({
      ...parsed,
      baseline: {
        ...parsed.baseline,
        fieldHashes: { ...parsed.baseline.fieldHashes, unsupportedHash: "a".repeat(64) },
      },
    }),
    original.replace(/"version":1}$/, '"version":1,"version":1}'),
  ];
  for (const value of variants) {
    rows[manifestIndex] = { predicate: "sync_manifest", value };
    await expect(loadLinkBySubject(h.graph, link)).rejects.toThrow(/manifest|JSON|baseline/);
  }
  rows[manifestIndex] = { predicate: "sync_manifest", value: original };
  expect((await loadLinkBySubject(h.graph, link))?.threadId).toBe(thread);
});

test("UUID, bootstrap-v1, and bootstrap-v2 links all survive import then apply", async () => {
  const uuidHarness = harness();
  uuidHarness.gateway.issue = {
    ...issue(),
    id: "11111111-1111-8111-8111-111111111111",
    identifier: "MSA-236",
    workspaceId: "22222222-2222-8222-8222-222222222222",
  } as any;
  const uuidThread = await importThread(uuidHarness);
  uuidHarness.graph.replace(uuidThread, "title", "UUID update");
  expect(await runLinearCommand(
    ["sync", uuidThread, "--apply"],
    uuidHarness.dependencies,
  )).toMatchObject({ applied: true, state: "in-sync" });
  expect((await loadLinkForThread(uuidHarness.graph, uuidThread)).identity.identityKind)
    .toBe("linear-uuid");

  const v1Harness = harness();
  const v1 = seedLegacyBootstrapLink(v1Harness);
  await runLinearCommand(["import", v1Harness.gateway.issue.id], v1Harness.dependencies);
  v1Harness.graph.replace(v1.thread, "title", "v1 update");
  expect(await runLinearCommand(
    ["sync", v1.thread, "--apply"],
    v1Harness.dependencies,
  )).toMatchObject({ applied: true, state: "in-sync" });
  expect((await loadLinkForThread(v1Harness.graph, v1.thread)).identity.identityKind)
    .toBe("mcp-bootstrap-v1");

  const v2Harness = harness();
  const v2Thread = await importThread(v2Harness);
  v2Harness.graph.replace(v2Thread, "title", "v2 update");
  expect(await runLinearCommand(
    ["sync", v2Thread, "--apply"],
    v2Harness.dependencies,
  )).toMatchObject({ applied: true, state: "in-sync" });
  expect((await loadLinkForThread(v2Harness.graph, v2Thread)).identity.identityKind)
    .toBe("mcp-bootstrap-v2");
});

test("native UUID enrichment preserves an established bootstrap winner", async () => {
  const h = harness();
  const first = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string;
  };
  h.gateway.issue = {
    ...h.gateway.issue,
    id: "11111111-1111-8111-8111-111111111111",
    identifier: "MSA-236",
    workspaceId: "22222222-2222-8222-8222-222222222222",
  } as any;
  const enriched = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; thread: string; identity: { identityKind: string };
  };
  expect(enriched).toMatchObject({
    link: first.link,
    thread: first.thread,
    identity: { identityKind: "mcp-bootstrap-v2" },
  });
  expect([...h.graph.rows.keys()].filter((subject) =>
    subject.startsWith("link:linear:"))).toHaveLength(1);
});

test("v1 and v2 identities sharing bootstrap evidence elect one durable winner", async () => {
  const graph = new FakeGraph();
  const evidence = {
    connector: "linear-test",
    createdAt: "2026-07-16T14:08:20.639Z",
    initialKey: "MSA-236",
  };
  const lease = (resource: string): SyncLease => ({
    resource,
    holder: `holder:${resource}`,
    epoch: 1,
    renew: async () => {},
    fence: async () => {},
    release: async () => {},
  });
  const evidenceLease = lease(`linear-sync:bootstrap:${
    bootstrapEvidenceSubject(evidence).replace("linear-bootstrap:", "")
  }`);
  const v1 = bootstrapIdentityFromEvidence("mcp-bootstrap-v1", evidence);
  const v2 = bootstrapIdentityFromEvidence("mcp-bootstrap-v2", evidence);
  await graph.reserveLinearBinding({
    kind: "mcp-bootstrap-v1",
    identityLease: lease(`linear-sync:identity:${encodeURIComponent(
      `linear:${v1.identityKind}:${v1.connector}:${v1.fingerprint}`,
    )}`),
    evidenceLease,
    evidence,
  }, linkSubject(v1), "thread-v1", evidence.connector);
  await expect(graph.reserveLinearBinding({
    kind: "mcp-bootstrap-v2",
    identityLease: lease(`linear-sync:identity:${encodeURIComponent(
      `linear:${v2.identityKind}:${v2.connector}:${v2.fingerprint}`,
    )}`),
    evidenceLease,
    evidence,
  }, linkSubject(v2), "thread-v2", evidence.connector))
    .rejects.toThrow("bootstrap_election");
  expect((await graph.show(bootstrapEvidenceSubject(evidence)))
    .filter(({ predicate }) => predicate === "canonical_link"))
    .toEqual([{ predicate: "canonical_link", value: `@${linkSubject(v1)}` }]);
});

test("FakeGraph reservation mirrors the production bootstrap authority denial matrix", async () => {
  const evidence = {
    connector: "linear-test",
    createdAt: "2026-07-16T14:20:00.639Z",
    initialKey: "MSA-430",
  };
  const identity = bootstrapIdentityFromEvidence("mcp-bootstrap-v2", evidence);
  const candidateLink = linkSubject(identity);
  const candidateLinkRef = `@${candidateLink}`;
  const thread = "thread-authority-matrix";
  const threadRef = `@${thread}`;
  const lease = (resource: string): SyncLease => ({
    resource,
    holder: `holder:${resource}`,
    epoch: 1,
    renew: async () => {},
    fence: async () => {},
    release: async () => {},
  });
  const reservation: LinearBindingReservation = {
    kind: "mcp-bootstrap-v2",
    identityLease: lease(`linear-sync:identity:${encodeURIComponent(
      `linear:${identity.identityKind}:${identity.connector}:${identity.fingerprint}`,
    )}`),
    evidenceLease: lease(`linear-sync:bootstrap:${
      bootstrapEvidenceSubject(evidence).replace("linear-bootstrap:", "")
    }`),
    evidence,
  };
  const reserve = (graph: FakeGraph) => graph.reserveLinearBinding(
    reservation,
    candidateLink,
    thread,
    evidence.connector,
  );
  const validElection = serializeBootstrapElection(
    evidence,
    candidateLinkRef,
    threadRef,
  );
  const duplicateElection = validElection.replace(
    `"canonicalLink":${JSON.stringify(candidateLinkRef)}`,
    `"canonicalLink":${JSON.stringify(candidateLinkRef)},`
      + `"canonicalLink":${JSON.stringify(candidateLinkRef)}`,
  );
  const otherEvidence = {
    connector: "linear-other-authority",
    createdAt: "2026-07-16T14:21:00.639Z",
    initialKey: "MSA-431",
  };
  const otherIdentity = bootstrapIdentityFromEvidence("mcp-bootstrap-v2", otherEvidence);
  const otherSubject = bootstrapEvidenceSubject(otherEvidence);
  const otherElection = serializeBootstrapElection(
    otherEvidence,
    `@${linkSubject(otherIdentity)}`,
    threadRef,
  );
  const corruptions: Array<(graph: FakeGraph) => void> = [
    (graph) => graph.seed(
      "linear-bootstrap:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bootstrap_election",
      "{",
    ),
    (graph) => graph.seed(
      bootstrapEvidenceSubject(evidence),
      "bootstrap_election",
      duplicateElection,
    ),
    (graph) => graph.seed(
      bootstrapEvidenceSubject(evidence),
      "bootstrap_election",
      JSON.stringify({
        canonicalLink: candidateLinkRef,
        connector: evidence.connector,
        createdAt: evidence.createdAt,
        initialKey: "x".repeat(5000),
        linkedThread: threadRef,
      }),
    ),
    (graph) => graph.seed(
      "linear-bootstrap:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "bootstrap_election",
      validElection,
    ),
    (graph) => {
      graph.seed(otherSubject, "bootstrap_election", otherElection);
      graph.seed(otherSubject, "canonical_link", candidateLinkRef);
    },
    (graph) => graph.seed(
      "linear-bootstrap:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "linked_thread",
      threadRef,
    ),
    (graph) => graph.seed(otherSubject, "bootstrap_election", otherElection),
    (graph) => graph.seed(
      candidateLink,
      "remote_fingerprint",
      identity.fingerprint === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
    ),
  ];
  for (const seedCorruption of corruptions) {
    const graph = new FakeGraph();
    seedCorruption(graph);
    await expect(reserve(graph)).rejects.toThrow();
    expect(graph.reservations).toHaveLength(0);
  }

  const raced = new FakeGraph();
  raced.beforeReservationPut = () => {
    raced.beforeReservationPut = undefined;
    raced.seed(
      "link:linear:uuid:11111111-1111-8111-8111-111111111111:22222222-2222-8222-8222-222222222222",
      "linked_thread",
      threadRef,
    );
  };
  await expect(reserve(raced))
    .rejects.toThrow("requested North thread is already reserved");
  expect((await raced.show(bootstrapEvidenceSubject(evidence)))
    .filter(({ predicate }) => predicate === "bootstrap_election"))
    .toHaveLength(0);
});

test("FakeGraph enforces production identity intake and partial-link authority", async () => {
  const lease = (resource: string): SyncLease => ({
    resource,
    holder: `holder:${resource}`,
    epoch: 1,
    renew: async () => {},
    fence: async () => {},
    release: async () => {},
  });
  const workspace = "22222222-2222-8222-8222-222222222222";
  const issueId = "11111111-1111-8111-8111-111111111111";
  const uuidIdentityKey = `linear:uuid:${workspace}:${issueId}`;
  const uuidLink = `link:${uuidIdentityKey}`;
  const uuidReservation: LinearBindingReservation = {
    kind: "linear-uuid",
    identityLease: lease(
      `linear-sync:identity:${encodeURIComponent(uuidIdentityKey)}`,
    ),
  };
  for (const [predicate, wrong] of [
    ["remote_workspace", "33333333-3333-8333-8333-333333333333"],
    ["remote_uuid", "44444444-4444-8444-8444-444444444444"],
  ] as const) {
    const graph = new FakeGraph();
    graph.seed(uuidLink, predicate, wrong);
    await expect(graph.reserveLinearBinding(
      uuidReservation,
      uuidLink,
      "thread-uuid-authority",
      "linear-test",
    )).rejects.toThrow(`partial Linear link conflicts on ${predicate}`);
    expect(graph.reservations).toHaveLength(0);
  }

  const evidence = {
    connector: "linear-intake",
    createdAt: "2026-07-16T15:00:00.639Z",
    initialKey: "MSA-440",
  };
  const v1Identity = bootstrapIdentityFromEvidence("mcp-bootstrap-v1", evidence);
  const v2Identity = bootstrapIdentityFromEvidence("mcp-bootstrap-v2", evidence);
  const evidenceResource = `linear-sync:bootstrap:${
    bootstrapEvidenceSubject(evidence).slice("linear-bootstrap:".length)
  }`;
  const reservationFor = (
    kind: "mcp-bootstrap-v1" | "mcp-bootstrap-v2",
    identity = kind === "mcp-bootstrap-v1" ? v1Identity : v2Identity,
  ): LinearBindingReservation => {
    const identityKey = linkSubject(identity).slice("link:".length);
    return {
      kind,
      identityLease: lease(
        `linear-sync:identity:${encodeURIComponent(identityKey)}`,
      ),
      evidenceLease: lease(evidenceResource),
      evidence,
    };
  };
  const validV2 = reservationFor("mcp-bootstrap-v2");
  const cases: Array<{
    reservation: LinearBindingReservation;
    link: string;
    thread: string;
    server: string;
    message: string;
  }> = [
    {
      reservation: uuidReservation,
      link: "link:linear:uuid:not-a-uuid:also-not-a-uuid",
      thread: "thread-intake",
      server: "linear-test",
      message: "canonical Linear identity",
    },
    ...["linear-\u0085-server", "linear-\uFEFF-server", "x".repeat(257)]
      .map((server) => ({
        reservation: uuidReservation,
        link: uuidLink,
        thread: "thread-uuid-server-intake",
        server,
        message: "connector must be canonical",
      })),
    {
      reservation: validV2,
      link: linkSubject(v2Identity),
      thread: "invalid thread",
      server: evidence.connector,
      message: "canonical North thread",
    },
    {
      reservation: validV2,
      link: linkSubject(v1Identity),
      thread: "thread-intake",
      server: evidence.connector,
      message: "reservation kind",
    },
    {
      reservation: validV2,
      link: linkSubject(v2Identity),
      thread: "thread-intake",
      server: "linear-other",
      message: "connector does not match",
    },
    {
      reservation: {
        ...validV2,
        identityLease: lease("linear-sync:identity:wrong"),
      },
      link: linkSubject(v2Identity),
      thread: "thread-intake",
      server: evidence.connector,
      message: "identity lease resource",
    },
    {
      reservation: {
        ...validV2,
        evidenceLease: lease("linear-sync:bootstrap:wrong"),
      } as LinearBindingReservation,
      link: linkSubject(v2Identity),
      thread: "thread-intake",
      server: evidence.connector,
      message: "evidence lease",
    },
  ];
  for (const candidate of cases) {
    const graph = new FakeGraph();
    await expect(graph.reserveLinearBinding(
      candidate.reservation,
      candidate.link,
      candidate.thread,
      candidate.server,
    )).rejects.toThrow(candidate.message);
    expect(graph.rows.size).toBe(0);
    expect(graph.reservations).toHaveLength(0);
  }
});

test("FakeGraph mirrors global authority query bounds before subject filtering", async () => {
  const evidence = {
    connector: "linear-global-authority",
    createdAt: "2026-07-16T15:10:00.639Z",
    initialKey: "MSA-450",
  };
  const identity = bootstrapIdentityFromEvidence("mcp-bootstrap-v2", evidence);
  const identityKey = linkSubject(identity).slice("link:".length);
  const lease = (resource: string): SyncLease => ({
    resource,
    holder: `holder:${resource}`,
    epoch: 1,
    renew: async () => {},
    fence: async () => {},
    release: async () => {},
  });
  const reservation: LinearBindingReservation = {
    kind: "mcp-bootstrap-v2",
    identityLease: lease(
      `linear-sync:identity:${encodeURIComponent(identityKey)}`,
    ),
    evidenceLease: lease(`linear-sync:bootstrap:${
      bootstrapEvidenceSubject(evidence).slice("linear-bootstrap:".length)
    }`),
    evidence,
  };
  const reserve = (graph: FakeGraph) => graph.reserveLinearBinding(
    reservation,
    linkSubject(identity),
    "thread-global-authority",
    evidence.connector,
  );

  for (const predicate of [
    "linked_thread", "bootstrap_election", "canonical_link",
  ]) {
    const graph = new FakeGraph();
    graph.seed("unrelated-authority", predicate, "x".repeat(160 * 1024 + 1));
    await expect(reserve(graph))
      .rejects.toThrow("invalid authority-query response");
    expect(graph.reservations).toHaveLength(0);
  }

  const tooMany = new FakeGraph();
  for (let index = 0; index <= 10_000; index++)
    tooMany.seed(`unrelated-${index}`, "canonical_link", `value-${index}`);
  await expect(reserve(tooMany))
    .rejects.toThrow("invalid authority-query response");
  expect(tooMany.reservations).toHaveLength(0);

  const malformedPrefix = new FakeGraph();
  malformedPrefix.seed(
    "linear-bootstrap:not-a-canonical-subject",
    "bootstrap_election",
    "{",
  );
  await expect(reserve(malformedPrefix)).resolves.toBeUndefined();
  expect(malformedPrefix.reservations).toHaveLength(1);

  const malformedLegacy = new FakeGraph();
  malformedLegacy.seed(
    "linear-bootstrap:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "canonical_link",
    "not-a-reference",
  );
  malformedLegacy.seed(
    "linear-bootstrap:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "linked_thread",
    "@unrelated-thread",
  );
  await expect(reserve(malformedLegacy))
    .rejects.toThrow("partial legacy bootstrap authority");
  expect(malformedLegacy.reservations).toHaveLength(0);
});

test("a crash after bootstrap election heals only the same winner", async () => {
  const h = harness();
  h.graph.failSubjectPrefix = "linear-bootstrap:";
  h.graph.failAfter = 1;
  await expect(runLinearCommand(["import", "MSA-236"], h.dependencies))
    .rejects.toThrow("injected graph crash");
  const writesAfterCrash = h.graph.writes.length;
  h.gateway.issue = issue("MSA-999");
  await expect(runLinearCommand(["import", "MSA-999"], h.dependencies))
    .rejects.toThrow("exact managed marker is required");
  h.gateway.issue = issue();
  await expect(runLinearCommand(
    ["import", "MSA-236", "--thread", "attacker-thread"],
    h.dependencies,
  )).rejects.toThrow("already prepared");
  expect(h.graph.writes).toHaveLength(writesAfterCrash);
  const recovered = await runLinearCommand(["import", "MSA-236"], h.dependencies) as {
    link: string; action: string;
  };
  const evidenceSubjects = [...h.graph.rows.keys()].filter((subject) =>
    subject.startsWith("linear-bootstrap:"));
  expect(evidenceSubjects).toHaveLength(1);
  expect((await h.graph.show(evidenceSubjects[0]!))
    .filter(({ predicate }) => predicate === "canonical_link"))
    .toEqual([{ predicate: "canonical_link", value: recovered.link }]);
});

test("authority intake rejects contradictory or ambiguous identity before reservation", async () => {
  const rejectsBeforeReservation = async (
    mutate: (value: ReturnType<typeof harness>) => void,
    message: string,
  ): Promise<void> => {
    const candidate = harness();
    mutate(candidate);
    await expect(runLinearCommand(["import", "MSA-236"], candidate.dependencies))
      .rejects.toThrow(message);
    expect(candidate.graph.writes).toHaveLength(0);
    expect(candidate.leases.requestedResources).toHaveLength(0);
    expect(candidate.gateway.issueWrites).toBe(0);
    expect(candidate.gateway.commentWrites).toBe(0);
  };

  const owner = harness();
  await expect(runLinearCommand(
    ["import", "MSA-236", "--owner", " padded "],
    owner.dependencies,
  )).rejects.toThrow("owner must be canonical");
  expect(owner.graph.writes).toHaveLength(0);
  expect(owner.leases.requestedResources).toHaveLength(0);

  const workspace = harness();
  workspace.gateway.issue.url = `https://linear.app/${"w".repeat(513)}/issue/MSA-236/x`;
  await expect(runLinearCommand(["import", "MSA-236"], workspace.dependencies))
    .rejects.toThrow("workspace slug must be canonical");
  expect(workspace.graph.writes).toHaveLength(0);
  expect(workspace.leases.requestedResources).toHaveLength(0);

  const native = harness();
  (native.gateway.issue as any).uuid = "11111111-1111-8111-8111-111111111111";
  await expect(runLinearCommand(["import", "MSA-236"], native.dependencies))
    .rejects.toThrow("incomplete native UUID evidence");
  expect(native.graph.writes).toHaveLength(0);
  expect(native.leases.requestedResources).toHaveLength(0);

  await rejectsBeforeReservation((candidate) => {
    candidate.gateway.issue = {
      ...candidate.gateway.issue,
      id: "MSA-999",
      identifier: "MSA-236",
    } as any;
  }, "id and identifier disagree");
  await rejectsBeforeReservation((candidate) => {
    candidate.gateway.issue = {
      ...candidate.gateway.issue,
      team: { id: "team-b", name: "Technology" },
    } as any;
  }, "teamId and team.id disagree");
  await rejectsBeforeReservation((candidate) => {
    candidate.gateway.issue = {
      issue: candidate.gateway.issue,
      id: "OUTER-AUTHORITY-SENTINEL",
    } as any;
  }, "wrapper contains ambiguous outer authority");

  const credential = harness();
  const passwordSentinel = "password-sentinel-do-not-log";
  credential.gateway.issue.url =
    `https://user:${passwordSentinel}@linear.app/msa-team/issue/MSA-236/x`;
  try {
    await runLinearCommand(["import", "MSA-236"], credential.dependencies);
    throw new Error("expected credential-bearing Linear URL rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("does not identify a linear.app workspace");
    expect(String(error)).not.toContain(passwordSentinel);
  }
  expect(credential.graph.writes).toHaveLength(0);
  expect(credential.leases.requestedResources).toHaveLength(0);

  await rejectsBeforeReservation((candidate) => {
    candidate.gateway.issue.url =
      "https://linear.app:444/msa-team/issue/MSA-236/x";
  }, "does not identify a linear.app workspace");
  await rejectsBeforeReservation((candidate) => {
    candidate.gateway.issue.url =
      "https://linear.app/msa%2Dteam/issue/MSA-236/x";
  }, "malformed or encoded workspace slug");
  await rejectsBeforeReservation((candidate) => {
    candidate.gateway.issue.url =
      "https://linear.app/_msa-team/issue/MSA-236/x";
  }, "malformed or encoded workspace slug");
  await rejectsBeforeReservation((candidate) => {
    candidate.gateway.issue.url =
      "https://linear.app/msa-team/issue/MSA-999/x";
  }, "URL identifier disagrees");
});

test("graph value preflight admits the exact limit and rejects max+1 before a lease", async () => {
  expect(() => assertLinearGraphValue("x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES)))
    .not.toThrow();
  expect(() => assertLinearGraphValue("x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES + 1)))
    .toThrow("exceeds");

  const oversized = harness();
  oversized.gateway.issue.description = "x".repeat(LINEAR_GRAPH_VALUE_MAX_BYTES + 1);
  await expect(runLinearCommand(["import", "MSA-236"], oversized.dependencies))
    .rejects.toThrow("imported thread");
  expect(oversized.graph.writes).toHaveLength(0);
  expect(oversized.leases.requestedResources).toHaveLength(0);
});

test("prepared dispatch keeps live-schema rejection pre-intent and transport failure unknown", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  h.graph.replace(thread, "title", "prepared title");

  h.gateway.prepareWriteFailure = "live schema minLength rejection";
  const writesBeforePrepare = h.graph.writes.length;
  const issueWritesBefore = h.gateway.issueWrites;
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("live schema minLength rejection");
  expect(h.graph.writes).toHaveLength(writesBeforePrepare);
  expect(h.gateway.issueWrites).toBe(issueWritesBefore);
  expect(JSON.parse((await h.graph.show(link))
    .find(({ predicate }) => predicate === "sync_manifest")!.value).pending)
    .toBeUndefined();

  h.gateway.prepareWriteFailure = undefined;
  h.gateway.dispatchWriteFailure = "callback outcome unknown";
  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("outcome is unknown");
  expect(h.gateway.issueWrites).toBe(issueWritesBefore);
  expect(JSON.parse((await h.graph.show(link))
    .find(({ predicate }) => predicate === "sync_manifest")!.value).pending)
    .toMatchObject({ kind: "issue" });
});

test("apply re-reads the issue immediately before intent and refuses a stale payload", async () => {
  const h = harness();
  const thread = await importThread(h);
  await runLinearCommand(["sync", thread, "--apply"], h.dependencies);
  h.graph.replace(thread, "body", "North body changed after adoption");
  const link = (await h.graph.show(thread))
    .find(({ predicate }) => predicate === "linear_link")!.value.replace(/^@/, "");
  const writesBefore = h.graph.writes.length;
  const issueWritesBefore = h.gateway.issueWrites;
  let injected = false;
  h.gateway.afterIssueRead = () => {
    if (injected) return;
    injected = true;
    h.gateway.issue.description += "\n\nConcurrent unmanaged Linear edit";
  };

  await expect(runLinearCommand(["sync", thread, "--apply"], h.dependencies))
    .rejects.toThrow("issue changed after planning");
  expect(injected).toBe(true);
  expect(h.gateway.issueWrites).toBe(issueWritesBefore);
  expect(h.graph.writes).toHaveLength(writesBefore);
  expect(JSON.parse((await h.graph.show(link))
    .find(({ predicate }) => predicate === "sync_manifest")!.value).pending)
    .toBeUndefined();
});

test("comment ids and cursors are exact and globally consistent across pages", async () => {
  const duplicate = harness();
  const duplicateThread = await importThread(duplicate);
  duplicate.gateway.duplicateCommentAcrossPages = true;
  await expect(runLinearCommand(["plan", duplicateThread], duplicate.dependencies))
    .rejects.toThrow("duplicate comment id");

  const cursor = harness();
  const cursorThread = await importThread(cursor);
  cursor.gateway.inconsistentCommentCursor = true;
  await expect(runLinearCommand(["plan", cursorThread], cursor.dependencies))
    .rejects.toThrow("more than one cursor field");
});

test("issue and comment pagination require coherent explicit terminal state", async () => {
  for (const fault of ["terminal-cursor", "missing-cursor"] as const) {
    const comments = harness();
    const commentThread = await importThread(comments);
    comments.gateway.commentPaginationFault = fault;
    await expect(runLinearCommand(["plan", commentThread], comments.dependencies))
      .rejects.toThrow("incoherent hasNextPage/cursor fields");

    const issues = harness();
    const issueThread = await importThread(issues);
    await runLinearCommand(["sync", issueThread, "--apply"], issues.dependencies);
    issues.gateway.issue = {
      ...issues.gateway.issue,
      id: "NEW-1",
      url: "https://linear.app/msa-team/issue/NEW-1/mechanical-linear-bridge",
    };
    issues.gateway.rejectOldKey = true;
    issues.gateway.issuePaginationFault = fault;
    await expect(runLinearCommand(["plan", issueThread], issues.dependencies))
      .rejects.toThrow("incoherent hasNextPage/cursor fields");
  }
});

test("schema bootstrap reinspection refuses a concurrent conflicting value", async () => {
  const graph = new FakeGraph();
  const target = "@canonical_link cardinality single";
  for (const [subject, predicate, value] of LINEAR_SCHEMA_FACTS)
    if (`@${subject} ${predicate} ${value}` !== target)
      graph.seed(subject, predicate, value);
  graph.beforeSchemaCommit = (subject, predicate) => {
    if (subject === "canonical_link" && predicate === "cardinality") {
      graph.beforeSchemaCommit = undefined;
      graph.seed(subject, predicate, "multi");
    }
  };
  await expect(ensureLinearSchema(graph)).rejects.toThrow("schema conflicts");
  expect((await graph.show("canonical_link"))
    .filter(({ predicate }) => predicate === "cardinality"))
    .toEqual([{ predicate: "cardinality", value: "multi" }]);
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

test("NorthGraphStore resolves FRAM_BIN as its public bin-directory contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-linear-fram-bin-"));
  const previousFramBin = process.env.FRAM_BIN;
  try {
    const north = join(directory, "north");
    const framBin = join(directory, "bin");
    const fram = join(framBin, "fram");
    const calls = join(directory, "fram-calls");
    mkdirSync(framBin);
    writeFileSync(north, "#!/bin/sh\nprintf '[]\\n'\n");
    writeFileSync(fram, `#!/bin/sh\nprintf '%s\\n' "$*" > '${calls}'\nprintf '%s\\n' 'committed via coordinator v1'\n`);
    chmodSync(north, 0o700);
    chmodSync(fram, 0o700);
    process.env.FRAM_BIN = framBin;

    await new NorthGraphStore(north).put("link:x", "kind", "integration_link");
    expect(readFileSync(calls, "utf8").trim()).toBe("tell link:x kind integration_link");
  } finally {
    if (previousFramBin === undefined) delete process.env.FRAM_BIN;
    else process.env.FRAM_BIN = previousFramBin;
    rmSync(directory, { recursive: true, force: true });
  }
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
