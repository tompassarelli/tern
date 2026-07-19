/**
 * Hermetic dependency injection for source-tree tests.
 *
 * This module is deliberately absent from the package export map. A WeakMap
 * brand keeps production request objects structurally closed: no public field
 * can masquerade as a provider, graph, delivery, or coordination runtime.
 */
const spawnRuntimes = new WeakMap<object, unknown>();
const dispatchRuntimes = new WeakMap<object, unknown>();

function bind(
  store: WeakMap<object, unknown>,
  request: object,
  runtime: unknown,
): void {
  if (store.has(request)) throw new Error("test runtime is already bound");
  store.set(request, runtime);
}

function take<T>(store: WeakMap<object, unknown>, request: object): T | undefined {
  const runtime = store.get(request) as T | undefined;
  store.delete(request);
  return runtime;
}

export function bindSpawnTestRuntime(request: object, runtime: unknown): void {
  bind(spawnRuntimes, request, runtime);
}

export function takeSpawnTestRuntime<T>(request: object): T | undefined {
  return take<T>(spawnRuntimes, request);
}

export function bindDispatchTestRuntime(request: object, runtime: unknown): void {
  bind(dispatchRuntimes, request, runtime);
}

export function takeDispatchTestRuntime<T>(request: object): T | undefined {
  return take<T>(dispatchRuntimes, request);
}
