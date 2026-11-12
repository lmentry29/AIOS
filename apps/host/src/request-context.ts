import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs one guarded host operation under its stable request id. Every authorization decision
 * made in the operation, including decisions made inside orchestration, carries that same id
 * so the audit trail can be joined to the HTTP request and its logs.
 */
export function withRequestId<T>(requestId: string, callback: () => T): T {
  return storage.run({ requestId }, callback);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
