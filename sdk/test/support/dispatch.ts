import {
  createDispatchAgentId,
  dispatch as productionDispatch,
  dispatchParallel as productionDispatchParallel,
  selectDispatchAgentId,
  type DispatchDependencies,
} from "../../src/dispatch";
import { bindDispatchTestRuntime } from "../../src/internal/test-runtime";

const RUNTIME_FIELDS = new Set([
  "claimDriver", "driverOptions", "queryFn", "loadThreadFacts", "loadChildren",
  "deliveryRuntime", "childSettlementReader", "feedSubscriber",
]);

function split(value: DispatchDependencies & Record<string, unknown>): {
  request: DispatchDependencies;
  hasRuntime: boolean;
} {
  const request: Record<string, unknown> = {};
  const runtime: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value))
    (RUNTIME_FIELDS.has(field) ? runtime : request)[field] = fieldValue;
  bindDispatchTestRuntime(request, runtime);
  return {
    request: request as unknown as DispatchDependencies,
    hasRuntime: Object.keys(runtime).length > 0,
  };
}

export function dispatch(
  threadId: string,
  value: DispatchDependencies & Record<string, unknown>,
) {
  return productionDispatch(threadId, split(value).request);
}

export function dispatchParallel(
  threadIds: string[],
  value?: DispatchDependencies & Record<string, unknown>,
) {
  if (value === undefined)
    return productionDispatchParallel(threadIds, value as any);
  const first = split(value);
  if (!first.hasRuntime)
    return productionDispatchParallel(threadIds, first.request);
  if (value.agentId && threadIds.length > 1)
    throw new Error("dispatchParallel cannot reuse one explicit agentId across multiple children");
  return Promise.all(threadIds.map((threadId, index) =>
    productionDispatch(threadId, index === 0 ? first.request : split(value).request)));
}

export { createDispatchAgentId, selectDispatchAgentId };
