import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  BESPOKE_FINGERPRINT_DOMAIN,
  BESPOKE_FINGERPRINT_VERSION,
  bespokeContractFingerprint,
  canonicalBespokeContract,
  canonicalBespokeContractPayload,
} from "../src/bespoke-contract";
import { gafferAppendix } from "../src/harness";
import { agentIdentityFacts } from "../src/identity";
import { validateRoutingMetadata } from "../src/routing-metadata";
import { runFacts } from "../src/telemetry";

const north = resolve(import.meta.dir, "../..");
const gaffer = resolve(north, "../gaffer");
const cli = resolve(north, "cli/agents-cli.clj");

const contract = {
  responsibility: "évidence\ntrace",
  deliverable: "sourced timeline",
  capabilities: ["filesystem.read", "filesystem.search", "shell.readonly"],
  mayDecide: ["follow trace", "select source"],
  mustEscalate: ["destructive recovery", "missing authority"],
  doneWhen: ["all transitions sourced", "gaps named"],
  report: "timeline and gaps",
};

const semanticallyEquivalent = {
  responsibility: " \te\u0301vidence\r\ntrace \r",
  deliverable: "  sourced timeline\t",
  capabilities: [" shell.readonly ", "filesystem.search", "filesystem.read"],
  mayDecide: [" select source ", "follow trace"],
  mustEscalate: ["missing authority", " destructive recovery "],
  doneWhen: ["gaps named", "all transitions sourced"],
  report: " timeline and gaps ",
};

const routing = (value: any) => validateRoutingMetadata({
  role: "migration-forensics",
  taskGrade: "staff",
  domainRequirements: [],
  topology: "worker",
  tier: "frontier",
  reasoning: "xhigh",
  posture: "preserve",
  composition: {
    kind: "bespoke",
    id: "migration-forensics",
    bespokeReason: "no preset has this authority boundary",
    promotionCandidate: false,
    contract: value,
  },
} as any);

test("bespoke fingerprint canonicalizes semantic sets with an explicit versioned domain", () => {
  expect(canonicalBespokeContract(semanticallyEquivalent)).toEqual(canonicalBespokeContract(contract));
  expect(bespokeContractFingerprint(semanticallyEquivalent)).toBe(bespokeContractFingerprint(contract));
  expect(canonicalBespokeContractPayload(contract).split("\n")[0]).toBe(BESPOKE_FINGERPRINT_DOMAIN);
  expect(BESPOKE_FINGERPRINT_VERSION).toBe("v1");

  expect(bespokeContractFingerprint({ ...contract, responsibility: `\u00a0${contract.responsibility}\u00a0` }))
    .not.toBe(bespokeContractFingerprint(contract));
  expect(bespokeContractFingerprint({ ...contract, deliverable: "different deliverable" }))
    .not.toBe(bespokeContractFingerprint(contract));
});

test("bespoke semantic sets reject duplicates instead of silently weakening the contract", () => {
  for (const malformed of [
    { ...contract, capabilities: [...contract.capabilities, "filesystem.search"] },
    { ...contract, mayDecide: [...contract.mayDecide, "follow trace"] },
    { ...contract, doneWhen: [...contract.doneWhen, "gaps named"] },
  ]) {
    expect(() => canonicalBespokeContract(malformed)).toThrow("must not contain duplicates");
  }
});

test("routing and harness consume the same canonical contract and fingerprint", () => {
  const metadata = routing(semanticallyEquivalent);
  expect((metadata.composition as any).contract).toEqual(canonicalBespokeContract(contract));
  const composed = gafferAppendix(metadata, north);
  expect(composed.evidence).toMatchObject({
    bespokeContractHash: bespokeContractFingerprint(contract),
    bespokeContractFingerprintVersion: BESPOKE_FINGERPRINT_VERSION,
    bespokeContractFingerprintDomain: BESPOKE_FINGERPRINT_DOMAIN,
    capabilities: ["filesystem.read", "filesystem.search", "shell.readonly"],
  });

  const composition = metadata.composition!;
  const identity = Object.fromEntries(agentIdentityFacts("lane-proof", {
    kind: "lane",
    role: metadata.role!,
    model: "gpt-5.6-sol",
    provider: "openai",
    providerTarget: "codex-personal",
    liveInput: "unsupported",
    liveInputState: "frozen",
    liveInputEpoch: "00000000-0000-4000-8000-000000000021",
    effort: "xhigh",
    compositionKind: composition.kind,
    compositionId: composition.id,
    compositionBespokeReason: composition.kind === "bespoke" ? composition.bespokeReason : undefined,
    compositionPromotionCandidate: composition.kind === "bespoke" ? composition.promotionCandidate : undefined,
    compositionContractFingerprint: composed.evidence.bespokeContractHash,
    compositionContractFingerprintVersion: composed.evidence.bespokeContractFingerprintVersion,
    compositionContractFingerprintDomain: composed.evidence.bespokeContractFingerprintDomain,
    repo: "~/code/north",
    goal: "prove identity/application integrity",
  }, "2026-07-17T00:00:00.000Z"));
  const applied = Object.fromEntries(runFacts({
    thread: "thread-proof",
    agent: "lane-proof",
    durationMs: 1,
    posture: "spawn",
    outcome: "ran",
    routingMetadata: metadata,
    promptComposition: composed.evidence,
  }));
  expect([
    identity.composition_contract_sha256,
    identity.composition_contract_fingerprint_version,
    identity.composition_contract_fingerprint_domain,
  ]).toEqual([
    applied.applied_bespoke_contract_sha256,
    applied.applied_bespoke_contract_fingerprint_version,
    applied.applied_bespoke_contract_fingerprint_domain,
  ]);
});

test("Clojure dry-run fingerprint is byte-identical and its UI is contract-redacted", () => {
  const rationale = "PRIVATE RATIONALE CANARY";
  const result = spawnSync("bb", [
    cli, "spawn", "migration-forensics", "probe", "--provider", "openai", "--nearest", "analyst",
    "--rationale", rationale, "--contract", JSON.stringify(semanticallyEquivalent),
    "--no-promotion-candidate", "--dry-run",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      GAFFER_HOME: gaffer,
      GAFFER_STAFFING_CATALOG: resolve(gaffer, "staffing/catalog.json"),
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.match(/sha256=([0-9a-f]{64})/)?.[1]).toBe(bespokeContractFingerprint(contract));
  expect(result.stdout).toContain(`version=${BESPOKE_FINGERPRINT_VERSION}`);
  expect(result.stdout).toContain(`domain=${BESPOKE_FINGERPRINT_DOMAIN}`);
  expect(result.stdout).toContain("AGENT_COMPOSITION=REDACTED_BESPOKE_CONTRACT");
  for (const secret of [rationale, "évidence", "sourced timeline", "timeline and gaps"])
    expect(result.stdout).not.toContain(secret);
});

test("CLI forwards the canonical contract to the child behind the redacted display seam", () => {
  const expected = JSON.stringify(canonicalBespokeContract(contract));
  const expression = `
    (load-file ${JSON.stringify(cli)})
    (def captured-env (atom nil))
    (with-redefs [north.topology-authority/require-coordination! (fn [& _] true)
                  north.spawn-process/create-agent-id (fn [_] "lane-env-probe")
                  north.spawn-process/launch-detached!
                  (fn [_ env _] (reset! captured-env env) :fake-process)
                  north.spawn-process/await-startup
                  (fn [& _] {:status :completed :handle "probe" :outcome "ran"})]
      (cmd-spawn ["migration-forensics" "probe" "--provider" "openai"
                  "--nearest" "analyst" "--rationale" "private rationale"
                  "--contract" ${JSON.stringify(JSON.stringify(semanticallyEquivalent))}
                  "--no-promotion-candidate"])
      (let [composition (json/parse-string (get @captured-env "AGENT_COMPOSITION") true)
            expected (json/parse-string ${JSON.stringify(expected)} true)]
        (println (str "CANONICAL_CHILD_CONTRACT=" (= expected (:contract composition))))))`;
  const result = spawnSync("bb", ["-e", expression], {
    encoding: "utf8",
    cwd: north,
    env: {
      ...process.env,
      NORTH_AGENTS_LIB: "1",
      NO_COLOR: "1",
      GAFFER_HOME: gaffer,
      GAFFER_STAFFING_CATALOG: resolve(gaffer, "staffing/catalog.json"),
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("AGENT_COMPOSITION=REDACTED_BESPOKE_CONTRACT");
  expect(result.stdout).toContain("CANONICAL_CHILD_CONTRACT=true");
});
