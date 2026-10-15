import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]+$/;
const correlationStorage = new AsyncLocalStorage<string>();

/** Keeps correlation IDs bounded and prevents arbitrary header material entering logs. */
export function normalizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CORRELATION_ID_LENGTH || !SAFE_CORRELATION_ID.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function correlationIdFromHeader(value: unknown): string {
  return normalizeCorrelationId(Array.isArray(value) ? value[0] : value) ?? randomUUID();
}

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

/** Returns the bounded correlation header for trusted internal HTTP calls. */
export function currentCorrelationHeaders(): Record<string, string> {
  const correlationId = currentCorrelationId();
  return correlationId ? { "x-correlation-id": correlationId } : {};
}

export function runWithCorrelationId<T>(correlationId: string, operation: () => T): T {
  return correlationStorage.run(correlationId, operation);
}
