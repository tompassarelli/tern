/**
 * Direct coordination authority boundary.
 *
 * Tool filtering is presentation, not authorization: callers can import the
 * SDK functions or invoke a raw adapter directly.  A managed worker therefore
 * has to be rejected again at the first executable boundary.  An absent value
 * is intentionally allowed for top-level interactive sessions; once a caller
 * declares a topology, only `orchestrator` carries coordination authority.
 */
export class TopologyAuthorityError extends Error {
  readonly code = "NORTH_TOPOLOGY_AUTHORITY_DENIED";
  readonly preSideEffect = true;

  constructor(
    readonly operation: string,
    readonly topology: string,
  ) {
    super(
      `coordination authority denied: ${operation} requires orchestrator topology; ` +
      `current topology is ${topology}`,
    );
    this.name = "TopologyAuthorityError";
  }
}

export function assertCoordinationAuthority(
  operation: string,
  topology = process.env.AGENT_TOPOLOGY,
): void {
  const declared = topology?.trim();
  if (!declared || declared === "orchestrator") return;
  throw new TopologyAuthorityError(operation, declared);
}
