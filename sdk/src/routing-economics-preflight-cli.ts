import { admitRoutingRequest } from "./routing-admission";
import { admitRoutingEconomics } from "./routing-economics";

interface PreflightEnvelope {
  routingMetadata?: unknown;
  routingAssessment?: unknown;
  pinEvidence?: unknown;
  provider?: string;
  target?: string;
  model?: string;
}

async function main(): Promise<void> {
  let payload: PreflightEnvelope;
  try {
    payload = JSON.parse(await Bun.stdin.text()) as PreflightEnvelope;
  } catch {
    throw new Error("routing economics preflight expects one JSON object on stdin");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("routing economics preflight expects one JSON object on stdin");
  const request = admitRoutingRequest(
    payload.routingMetadata ?? {}, "managed North routing preflight",
  );
  const admitted = admitRoutingEconomics({
    request,
    routingAssessment: payload.routingAssessment,
    pinEvidence: payload.pinEvidence,
    provider: payload.provider,
    target: payload.target,
    model: payload.model,
    surface: "managed North routing preflight",
  });
  process.stdout.write(JSON.stringify(admitted.receipt));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "routing economics preflight failed");
  process.exitCode = 1;
});
