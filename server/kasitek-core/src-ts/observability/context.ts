import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { context, propagation } from "@opentelemetry/api";
import {
  injectTraceContext,
  isSafeCorrelationId,
} from "@kasitek/server-support/telemetry";
const storage = new AsyncLocalStorage<string>();
export function correlationId(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return isSafeCorrelationId(candidate) ? candidate : randomUUID();
}
export const currentCorrelationId = () => storage.getStore();
export const withCorrelationId = <T>(id: string, run: () => T): T =>
  storage.run(id, run);
/** Authentication is deliberately supplied by the caller; only bounded context is injected here. */
export function outboundTraceHeaders(): Record<string, string> {
  const headers = new Headers();
  injectTraceContext(headers);
  const id = currentCorrelationId();
  if (id) headers.set("x-correlation-id", id);
  return Object.fromEntries(headers);
}
export function extractRequestTrace(
  headers: Record<string, string | string[] | undefined>,
) {
  return propagation.extract<Record<string, string | string[] | undefined>>(
    propagation.deleteBaggage(context.active()),
    {
      traceparent: headers.traceparent,
      tracestate: headers.tracestate,
    },
    {
      keys: (carrier) => Object.keys(carrier),
      get: (carrier, key) =>
        typeof carrier[key] === "string" ? (carrier[key] as string) : undefined,
    },
  );
}
