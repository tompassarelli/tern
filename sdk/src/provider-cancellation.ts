/**
 * Run-local cancellation before provider side effects. This is control flow,
 * not provider evidence: callers must propagate it and must never persist it
 * into shared usage/model observation TTLs.
 */
export class ProviderRefreshCancelledError extends Error {
  readonly code = "NORTH_PROVIDER_REFRESH_CANCELLED";
  readonly preSideEffect = true;

  constructor() {
    super("provider_refresh_cancelled");
    this.name = "ProviderRefreshCancelledError";
  }
}

export function throwIfProviderRefreshCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderRefreshCancelledError();
}
