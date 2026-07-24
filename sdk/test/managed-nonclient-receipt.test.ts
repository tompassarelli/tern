import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact } from "../src/north-client";
import {
  canonicalManagedNonclientJson,
  MANAGED_NONCLIENT_RECEIPT_FILE_ENV,
  MANAGED_NONCLIENT_RECEIPT_FRESHNESS_MS,
  MANAGED_NONCLIENT_RECEIPT_VERSION,
  prepareManagedNonclientReceipt,
} from "../src/providers/managed-nonclient-receipt";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const runId = "run:lane-receipt-fixture-00000000-0000-4000-8000-000000000001";
const threadId = "019f8742-a950-7828-9a7e-571eafa95ed9";
const agentId = "lane-receipt-fixture-00000000-0000-4000-8000-000000000002";
const capability = "a".repeat(64);
const branch = `lane-${agentId}`;
const reservationFields = [
  "run_capability_sha256", "run_reservation_agent", "run_reservation_contract_origin",
  "run_reservation_done_when", "run_reservation_thread", "run_reservation_version",
  "run_reserved_at",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reservation(now: number): Fact[] {
  const values: Record<typeof reservationFields[number], string> = {
    run_capability_sha256: sha256(capability),
    run_reservation_agent: `@agent:${agentId}`,
    run_reservation_contract_origin: "accepted",
    run_reservation_done_when: JSON.stringify(["focused probe passes"]),
    run_reservation_thread: `@${threadId}`,
    run_reservation_version: "north:run-reservation:v1",
    run_reserved_at: new Date(now).toISOString(),
  };
  const body = reservationFields.map((predicate) => `${predicate}\0${values[predicate]}\n`).join("");
  return [
    ...reservationFields.map((predicate) => ({ predicate, value: values[predicate] })),
    { predicate: "run_reservation_manifest_sha256", value: sha256(body) },
  ];
}

interface Fixture {
  root: string;
  main: string;
  worktree: string;
  home: string;
  now: number;
  env: NodeJS.ProcessEnv;
  runFacts: Fact[];
  laneFacts: Fact[];
  readFacts(id: string): Fact[];
  runGit(cwd: string, args: readonly string[]): string;
  authority: {
    providerThreadId: string;
    cwd: string;
    projectRoot: string;
    workspaceRoots: [string];
    sandbox: {
      type: "workspaceWrite";
      writableRoots: [];
      networkAccess: false;
      excludeTmpdirEnvVar: false;
      excludeSlashTmp: false;
    };
  };
}

function fixture(client = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), "north-nonclient-receipt-"));
  roots.push(root);
  const main = client ? join(root, "code", "client", "acme", "main") : join(root, "main");
  const worktree = join(root, "worktree");
  const home = join(root, "private-home");
  mkdirSync(main, { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  execFileSync("git", ["init", "-q", main]);
  execFileSync("git", ["-C", main, "config", "user.name", "North Test"]);
  execFileSync("git", ["-C", main, "config", "user.email", "north@example.test"]);
  writeFileSync(join(main, "README.md"), "fixture\n");
  execFileSync("git", ["-C", main, "add", "README.md"]);
  execFileSync("git", ["-C", main, "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", branch, worktree]);
  const now = Date.parse("2026-07-22T10:00:00.000Z");
  const env = {
    AGENT_ID: agentId,
    NORTH_RUN_ID: runId,
    NORTH_THREAD_ID: threadId,
    NORTH_RUN_CAPABILITY: capability,
  };
  const runFacts = reservation(now);
  const laneFacts: Fact[] = [
    { predicate: "kind", value: "lane" },
    { predicate: "provider", value: "openai" },
    { predicate: "repo", value: realpathSync(main) },
    { predicate: "worktree", value: realpathSync(worktree) },
    { predicate: "branch", value: branch },
  ];
  const readFacts = (id: string): Fact[] => id === runId ? runFacts
    : id === `agent:${agentId}` ? laneFacts : [];
  const runGit = (cwd: string, args: readonly string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    root, main: realpathSync(main), worktree: realpathSync(worktree), home: realpathSync(home),
    now, env, runFacts, laneFacts, readFacts, runGit,
    authority: {
      providerThreadId: "019f8755-247e-7132-93a4-7c900f8eb503",
      cwd: realpathSync(worktree), projectRoot: realpathSync(worktree),
      workspaceRoots: [realpathSync(worktree)],
      sandbox: {
        type: "workspaceWrite", writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    },
  };
}

function prepared(f: Fixture, overrides: Record<string, unknown> = {}) {
  return prepareManagedNonclientReceipt(f.env, f.home, {
    now: () => f.now,
    readFacts: f.readFacts,
    runGit: f.runGit,
    randomSuffix: () => "fixture",
    randomNonce: () => "c".repeat(64),
    ...overrides,
  });
}

test("publishes one private bounded canonical HKDF/HMAC receipt only after exact proof", () => {
  const f = fixture();
  const receipt = prepared(f);
  expect(existsSync(receipt.path)).toBe(false);
  expect(f.env[MANAGED_NONCLIENT_RECEIPT_FILE_ENV]).toBe(receipt.path);

  receipt.refresh(f.authority);
  const raw = readFileSync(receipt.path, "utf8");
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16 * 1024);
  expect(lstatSync(receipt.path).mode & 0o077).toBe(0);
  const envelope = JSON.parse(raw);
  expect(raw).toBe(canonicalManagedNonclientJson(envelope));
  expect(Object.keys(envelope)).toEqual([
    "authority", "issuedAt", "laneRegistration", "mac", "nonce", "notAfter",
    "runReservation", "version",
  ]);
  expect(Object.keys(envelope.authority)).toEqual([
    "agent", "managedLane", "projectRoot", "provider", "providerThread", "sandbox",
    "topology", "workspaceRoot",
  ]);
  expect(Object.keys(envelope.authority.sandbox)).toEqual([
    "excludeSlashTmp", "excludeTmpdirEnvVar", "networkAccess", "runtimeWorkspaceRoots",
    "type", "writableRoots",
  ]);
  expect(Object.keys(envelope.runReservation)).toEqual([
    "capabilitySha256", "manifestSha256", "reporter", "reservedAt", "subject", "thread",
  ]);
  expect(Object.keys(envelope.laneRegistration)).toEqual([
    "branch", "kind", "manifestSha256", "repo", "repoRoot", "subject", "worktree",
  ]);
  expect(envelope).toMatchObject({
    version: MANAGED_NONCLIENT_RECEIPT_VERSION,
    nonce: "c".repeat(64),
    authority: {
      provider: "openai", managedLane: "1", topology: "worker",
      agent: `@agent:${agentId}`, providerThread: f.authority.providerThreadId,
      workspaceRoot: f.worktree, projectRoot: f.worktree,
      sandbox: {
        type: "workspaceWrite", runtimeWorkspaceRoots: [f.worktree],
        writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    },
    runReservation: {
      subject: `@${runId}`, thread: `@${threadId}`, reporter: `@agent:${agentId}`,
      reservedAt: new Date(f.now).toISOString(),
      manifestSha256: f.runFacts.find(
        (fact) => fact.predicate === "run_reservation_manifest_sha256",
      )!.value,
      capabilitySha256: sha256(capability),
    },
    laneRegistration: {
      subject: `@agent:${agentId}`, kind: "lane", repo: f.main, repoRoot: f.main,
      worktree: f.worktree, branch,
    },
  });
  const laneManifest = ["subject", "kind", "repo", "worktree", "branch"]
    .map((field) => `${field}\0${envelope.laneRegistration[field]}\n`).join("");
  expect(envelope.laneRegistration.manifestSha256).toBe(sha256(laneManifest));
  expect(Date.parse(envelope.notAfter) - Date.parse(envelope.issuedAt))
    .toBe(MANAGED_NONCLIENT_RECEIPT_FRESHNESS_MS);
  const unsigned = { ...envelope };
  delete unsigned.mac;
  const key = Buffer.from(hkdfSync(
    "sha256", Buffer.from(capability, "hex"),
    Buffer.from(envelope.runReservation.manifestSha256, "hex"),
    Buffer.from(MANAGED_NONCLIENT_RECEIPT_VERSION, "ascii"), 32,
  ));
  expect(envelope.mac).toBe(createHmac("sha256", key)
    .update(canonicalManagedNonclientJson(unsigned)).digest("hex"));
  receipt.dispose();
  expect(existsSync(receipt.path)).toBe(false);
  expect(f.env).not.toHaveProperty(MANAGED_NONCLIENT_RECEIPT_FILE_ENV);
});

test("tamper and cross-run replay cannot retain valid HMAC integrity", () => {
  const f = fixture();
  const receipt = prepared(f);
  receipt.refresh(f.authority);
  const envelope = JSON.parse(readFileSync(receipt.path, "utf8"));
  envelope.authority.workspaceRoot = f.main;
  const unsigned = { ...envelope };
  delete unsigned.mac;
  const receiptCapability = Buffer.from(hkdfSync(
    "sha256", Buffer.from(capability, "hex"),
    Buffer.from(envelope.runReservation.manifestSha256, "hex"),
    Buffer.from(MANAGED_NONCLIENT_RECEIPT_VERSION, "ascii"), 32,
  ));
  const tampered = createHmac(
    "sha256", receiptCapability,
  ).update(canonicalManagedNonclientJson(unsigned)).digest("hex");
  expect(tampered).not.toBe(envelope.mac);
  const otherRunCapability = Buffer.from("b".repeat(64), "hex");
  const otherReceiptCapability = Buffer.from(hkdfSync(
    "sha256", otherRunCapability,
    Buffer.from(envelope.runReservation.manifestSha256, "hex"),
    Buffer.from(MANAGED_NONCLIENT_RECEIPT_VERSION, "ascii"), 32,
  ));
  const original = JSON.parse(readFileSync(receipt.path, "utf8"));
  const originalUnsigned = { ...original };
  delete originalUnsigned.mac;
  const replayed = createHmac("sha256", otherReceiptCapability)
    .update(canonicalManagedNonclientJson(originalUnsigned))
    .digest("hex");
  expect(replayed).not.toBe(original.mac);
  receipt.dispose();
});

test("reservation, lane, client, workspace, and Git drift all withhold and revoke", () => {
  const cases: Array<[string, (f: Fixture) => void]> = [
    ["missing reservation", (f) => { f.runFacts.splice(0); }],
    ["stale reservation", (f) => {
      f.runFacts.splice(0, f.runFacts.length, ...reservation(
        f.now - MANAGED_NONCLIENT_RECEIPT_FRESHNESS_MS - 1,
      ));
    }],
    ["wrong reporter", (f) => {
      f.runFacts.find((fact) => fact.predicate === "run_reservation_agent")!.value = "@agent:other";
    }],
    ["terminal run", (f) => { f.runFacts.push({ predicate: "kind", value: "run" }); }],
    ["duplicate lane registration", (f) => {
      f.laneFacts.push({ predicate: "worktree", value: f.worktree });
    }],
    ["wrong registered branch", (f) => {
      f.laneFacts.find((fact) => fact.predicate === "branch")!.value = "lane-other";
    }],
    ["wrong cwd", (f) => { f.authority.cwd = f.main; }],
    ["wrong project", (f) => { f.authority.projectRoot = f.main; }],
    ["widened roots", (f) => { f.authority.workspaceRoots.push(f.main); }],
    ["widened sandbox", (f) => { (f.authority.sandbox.writableRoots as string[]).push(f.main); }],
  ];
  for (const [label, mutate] of cases) {
    const f = fixture();
    const receipt = prepared(f, { randomSuffix: () => label.replaceAll(" ", "-") });
    mutate(f);
    expect(() => receipt.refresh(f.authority), label).toThrow();
    expect(existsSync(receipt.path), label).toBe(false);
    receipt.dispose();
  }

  const client = fixture(true);
  const clientReceipt = prepared(client);
  expect(() => clientReceipt.refresh(client.authority)).toThrow("refuses client main roots");
  expect(existsSync(clientReceipt.path)).toBe(false);
  clientReceipt.dispose();
});

test("wrong Git branch, common-dir, registration, and atomic publication leave no receipt", () => {
  for (const kind of ["branch", "common-dir", "registration"] as const) {
    const f = fixture();
    const receipt = prepared(f, {
      runGit: (cwd: string, args: readonly string[]) => {
        if (kind === "branch" && args.join(" ") === "branch --show-current") return "lane-other\n";
        if (kind === "common-dir" && args.includes("--git-common-dir")) return `${f.worktree}/.git\n`;
        if (kind === "registration" && args.join(" ") === "worktree list --porcelain")
          return `worktree ${f.main}\nHEAD ${"1".repeat(40)}\nbranch refs/heads/main\n`;
        return f.runGit(cwd, args);
      },
      randomSuffix: () => kind,
    });
    expect(() => receipt.refresh(f.authority)).toThrow();
    expect(existsSync(receipt.path)).toBe(false);
    receipt.dispose();
  }

  const atomic = fixture();
  const receipt = prepared(atomic, { randomSuffix: () => "collision" });
  writeFileSync(`${receipt.path}.tmp-collision`, "occupied", { mode: 0o600 });
  expect(() => receipt.refresh(atomic.authority)).toThrow();
  expect(existsSync(receipt.path)).toBe(false);
  receipt.dispose();
});

test("failed reproof removes a previously valid receipt before rejecting", () => {
  const f = fixture();
  const receipt = prepared(f);
  receipt.refresh(f.authority);
  expect(existsSync(receipt.path)).toBe(true);
  f.laneFacts.find((fact) => fact.predicate === "branch")!.value = "lane-drifted";
  expect(() => receipt.refresh(f.authority)).toThrow();
  expect(existsSync(receipt.path)).toBe(false);
  receipt.dispose();
});
