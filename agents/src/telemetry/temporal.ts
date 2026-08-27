import { context, propagation, type Context, type TextMapGetter } from "@opentelemetry/api";
import { defaultPayloadConverter, type Headers, type WorkflowClientInterceptor } from "@temporalio/client";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";

import { currentCorrelationId, runWithCorrelationId } from "./context";

const PROPAGATED_KEYS = new Set(["traceparent", "tracestate", "x-correlation-id"]);

function payloadToString(payload: Headers[string] | undefined): string | undefined {
  if (!payload?.data) return undefined;
  try {
    const value = defaultPayloadConverter.fromPayload<unknown>(payload);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function temporalCarrier(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => PROPAGATED_KEYS.has(key.toLowerCase()))
      .map(([key, payload]) => [key.toLowerCase(), payloadToString(payload)])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length <= 512),
  );
}

function payloadHeaders(carrier: Record<string, string>): Headers {
  return Object.fromEntries(
    Object.entries(carrier).map(([key, value]) => [key, defaultPayloadConverter.toPayload(value)]),
  );
}

function withTelemetryHeaders(headers: Headers): Headers {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const correlationId = currentCorrelationId();
  if (correlationId) carrier["x-correlation-id"] = correlationId;
  return { ...headers, ...payloadHeaders(carrier) };
}

function injectWorkflowHeaders<T extends { headers: Headers }>(input: T): T {
  return { ...input, headers: withTelemetryHeaders(input.headers) };
}

/** Adds W3C trace context and the bounded application correlation ID to Temporal calls. */
export const temporalClientInterceptor: WorkflowClientInterceptor = {
  startWithDetails: (input, next) => next(injectWorkflowHeaders(input)),
  startUpdate: (input, next) => next(injectWorkflowHeaders(input)),
  signal: (input, next) => next(injectWorkflowHeaders(input)),
  signalWithStart: (input, next) => next(injectWorkflowHeaders(input)),
};

/**
 * Extracts Temporal headers before an Activity is run. The workflow interceptor copies the
 * original workflow headers into every scheduled activity, preserving the causal link even when
 * the activity executes on another worker process.
 */
export const temporalActivityInterceptors: ActivityInterceptorsFactory = () => ({
  inbound: {
    execute: (input, next) => {
      const carrier = temporalCarrier(input.headers);
      const parent: Context = propagation.extract(context.active(), carrier, {
        get(carrierValue, key) {
          const value = carrierValue[key.toLowerCase()];
          return value === undefined ? [] : [value];
        },
        keys(carrierValue) {
          return Object.keys(carrierValue);
        },
      } satisfies TextMapGetter<Record<string, string>>);
      const correlationId = carrier["x-correlation-id"];
      return context.with(parent, () => correlationId
        ? runWithCorrelationId(correlationId, () => next(input))
        : next(input));
    },
  },
});
