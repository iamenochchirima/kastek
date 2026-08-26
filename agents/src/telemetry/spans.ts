import {
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type Span,
  type UpDownCounter,
} from "@opentelemetry/api";
import { redactTelemetryText } from "./redaction";

const tracer = trace.getTracer("kasitek-agents");
const meter = metrics.getMeter("kasitek-agents");
const operationCounter = meter.createCounter("kasitek.operation.count", {
  description: "Completed instrumented application operations",
});
const operationDuration = meter.createHistogram("kasitek.operation.duration", {
  description: "Instrumented application operation duration in seconds",
  unit: "s",
});
const operationInFlight: UpDownCounter = meter.createUpDownCounter("kasitek.operation.in_flight", {
  description: "Instrumented application operations currently in progress",
});

export function boundedAttribute(value: unknown, maxLength = 128): string {
  return String(value ?? "unknown").slice(0, maxLength);
}

function recordFailure(span: Span, error: unknown): void {
  const type = boundedAttribute(error instanceof Error ? error.name : typeof error);
  const message = redactTelemetryText(error instanceof Error ? error.message : error, 512);
  const stack = error instanceof Error ? redactTelemetryText(error.stack ?? "", 4096) : "";
  span.recordException({ name: type, message, ...(stack ? { stack } : {}) });
  span.setAttribute("exception.type", type);
  span.setAttribute("exception.message", message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Runs an application boundary in the current trace context with bounded error metadata. */
export async function withSpan<T>(name: string, attributes: Attributes, operation: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    const started = performance.now();
    const operationName = boundedAttribute(name);
    operationInFlight.add(1, { operation: operationName });
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      operationCounter.add(1, { operation: operationName, outcome: "success" });
      operationDuration.record((performance.now() - started) / 1000, { operation: operationName, outcome: "success" });
      return result;
    } catch (error) {
      recordFailure(span, error);
      operationCounter.add(1, { operation: operationName, outcome: "error" });
      operationDuration.record((performance.now() - started) / 1000, { operation: operationName, outcome: "error" });
      throw error;
    } finally {
      operationInFlight.add(-1, { operation: operationName });
      span.end();
    }
  });
}

export function withProviderSpan<T>(provider: string, operation: string, action: () => Promise<T>): Promise<T> {
  return withSpan(`provider.${boundedAttribute(provider)}.${boundedAttribute(operation)}`, {
    "peer.service": boundedAttribute(provider),
    "kasitek.provider.operation": boundedAttribute(operation),
  }, action);
}
