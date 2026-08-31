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
const operationErrorCounter = meter.createCounter("kasitek.operation.error.count", {
  description: "Instrumented application operations that failed",
});
const operationDuration = meter.createHistogram("kasitek.operation.duration", {
  description: "Instrumented application operation duration in seconds",
  unit: "s",
});
const operationInFlight: UpDownCounter = meter.createUpDownCounter("kasitek.operation.in_flight", {
  description: "Instrumented application operations currently in progress",
});
const operationRetryCounter = meter.createCounter("kasitek.operation.retry.count", {
  description: "Retries observed for instrumented application operations",
});
const dependencyFailureCounter = meter.createCounter("kasitek.dependency.failure.count", {
  description: "Instrumented dependency operations that failed",
});
const queueAge = meter.createHistogram("kasitek.queue.age", {
  description: "Age of work when it is claimed from a queue in seconds",
  unit: "s",
});
const budgetExhaustionCounter = meter.createCounter("kasitek.run_budget.exhaustion.count", {
  description: "Run model or tool budget checks that rejected additional work",
});
const budgetReconciliationCounter = meter.createCounter("kasitek.run_budget.reconciliation_required.count", {
  description: "Run-budget reservations moved to explicit provider-outcome reconciliation",
});
const temporalActivityAttemptCounter = meter.createCounter("kasitek.temporal.activity.attempt.count", {
  description: "Temporal activity attempts, including retries",
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
      operationErrorCounter.add(1, { operation: operationName });
      operationDuration.record((performance.now() - started) / 1000, { operation: operationName, outcome: "error" });
      throw error;
    } finally {
      operationInFlight.add(-1, { operation: operationName });
      span.end();
    }
  });
}

export function withProviderSpan<T>(provider: string, operation: string, action: () => Promise<T>): Promise<T> {
  const dependency = boundedAttribute(provider);
  const dependencyOperation = boundedAttribute(operation);
  return withSpan(`provider.${dependency}.${dependencyOperation}`, {
    "peer.service": boundedAttribute(provider),
    "kasitek.provider.operation": boundedAttribute(operation),
  }, action).catch((error: unknown) => {
    dependencyFailureCounter.add(1, { dependency, operation: dependencyOperation });
    throw error;
  });
}

/** Records retries and queue age without creating high-cardinality metric attributes. */
export function recordRetry(operation: string, count = 1): void {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  operationRetryCounter.add(count, { operation: boundedAttribute(operation) });
}

export function recordQueueAge(queue: string, ageSeconds: number): void {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return;
  queueAge.record(ageSeconds, { "queue.name": boundedAttribute(queue) });
}

export function recordBudgetExhaustion(code: string): void {
  budgetExhaustionCounter.add(1, { code: boundedAttribute(code) });
}

export function recordBudgetReconciliationRequired(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  budgetReconciliationCounter.add(count);
}

export function recordTemporalActivityAttempt(activity: string, attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return;
  temporalActivityAttemptCounter.add(1, {
    activity: boundedAttribute(activity),
    attempt: String(attempt),
  });
}
