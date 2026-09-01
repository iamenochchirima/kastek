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
const retrievalDecisionCounter = meter.createCounter("kasitek.memory.retrieval.decision.count", {
  description: "Bounded retrieval decisions by reason and outcome",
});
const retrievalEvidenceCounter = meter.createCounter("kasitek.memory.retrieval.evidence.count", {
  description: "Structured memory and knowledge evidence returned to an agent run",
});
const memorySafetySignalCounter = meter.createCounter("kasitek.memory.safety.signal.count", {
  description: "Memory safety classifications recorded before persistence",
});
const memoryReviewCounter = meter.createCounter("kasitek.memory.review.outcome.count", {
  description: "Memory review decisions applied by users or operators",
});
const memoryConsolidationCounter = meter.createCounter("kasitek.memory.consolidation.count", {
  description: "Conversation memory consolidation outcomes and proposed records",
});
const memoryDeletionCounter = meter.createCounter("kasitek.memory.deletion.count", {
  description: "Memory and derived-data deletion outcomes",
});
const memoryLifecycleCounter = meter.createCounter("kasitek.memory.lifecycle.decision.count", {
  description: "Memory acceptance, review, quarantine, rejection, and scope outcomes",
});
const retrievalScopeRejectionCounter = meter.createCounter("kasitek.memory.retrieval.scope_rejection.count", {
  description: "Retrieval attempts that lacked a required memory scope value",
});
const retrievalDuration = meter.createHistogram("kasitek.memory.retrieval.duration", {
  description: "Memory and knowledge retrieval duration in milliseconds",
  unit: "ms",
});
const agentVersionDeploymentCounter = meter.createCounter("kasitek.agent.version.deployment.count", {
  description: "Published-versus-deployed installation rollout outcomes",
});
const conversationAdmissionCounter = meter.createCounter("kasitek.conversation.admission.count", {
  description: "Conversation run admission outcomes, including backpressure and idempotent replay",
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

export function recordRetrievalResult(input: {
  requested: boolean;
  reason: string;
  memoryCount: number;
  knowledgeCount: number;
  evidenceCount: number;
}): void {
  retrievalDecisionCounter.add(1, {
    requested: String(input.requested),
    reason: boundedAttribute(input.reason),
    outcome: input.requested ? input.evidenceCount > 0 ? "hit" : "empty" : "skipped",
  });
  if (Number.isSafeInteger(input.memoryCount) && input.memoryCount > 0) retrievalEvidenceCounter.add(input.memoryCount, { source: "memory" });
  if (Number.isSafeInteger(input.knowledgeCount) && input.knowledgeCount > 0) retrievalEvidenceCounter.add(input.knowledgeCount, { source: "knowledge" });
  if (Number.isSafeInteger(input.evidenceCount) && input.evidenceCount > 0) retrievalEvidenceCounter.add(input.evidenceCount, { source: "ranked" });
}

export function recordMemorySafetyAssessment(input: {
  status: string;
  sourceTrust: string;
  poisoningCount: number;
  sensitiveCount: number;
}): void {
  const attributes = {
    status: boundedAttribute(input.status),
    sourceTrust: boundedAttribute(input.sourceTrust),
  };
  if (Number.isSafeInteger(input.poisoningCount) && input.poisoningCount > 0) memorySafetySignalCounter.add(input.poisoningCount, { ...attributes, signal: "poisoning" });
  if (Number.isSafeInteger(input.sensitiveCount) && input.sensitiveCount > 0) memorySafetySignalCounter.add(input.sensitiveCount, { ...attributes, signal: "sensitive" });
  if (input.poisoningCount === 0 && input.sensitiveCount === 0) memorySafetySignalCounter.add(1, { ...attributes, signal: "clean" });
}

export function recordMemoryReviewOutcome(decision: "approve" | "reject"): void {
  memoryReviewCounter.add(1, { decision });
}

export function recordMemoryConsolidation(outcome: string, candidateCount = 0): void {
  memoryConsolidationCounter.add(1, { outcome: boundedAttribute(outcome) });
  if (Number.isSafeInteger(candidateCount) && candidateCount > 0) {
    memoryConsolidationCounter.add(candidateCount, { outcome: "candidate" });
  }
}

export function recordMemoryDeletion(input: {
  outcome: "completed" | "scope_rejected" | "failed";
  target: "memory" | "knowledge_source" | "conversation" | "organization";
  count?: number;
}): void {
  memoryDeletionCounter.add(1, {
    outcome: input.outcome,
    target: boundedAttribute(input.target),
  });
  if (input.outcome === "completed" && Number.isSafeInteger(input.count) && input.count! > 0) {
    memoryDeletionCounter.add(input.count!, {
      outcome: "derived_rows_removed",
      target: boundedAttribute(input.target),
    });
  }
}

export function recordMemoryLifecycleDecision(input: {
  outcome: "accepted" | "review_pending" | "quarantined" | "rejected" | "scope_rejected";
  sourceType: "explicit" | "imported" | "inferred";
}): void {
  memoryLifecycleCounter.add(1, {
    outcome: input.outcome,
    source_type: input.sourceType,
  });
}

export function recordRetrievalScopeRejection(reason: "missing_installation" | "missing_conversation" | "missing_actor"): void {
  retrievalScopeRejectionCounter.add(1, { reason });
}

export function recordRetrievalDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  retrievalDuration.record(durationMs);
}

export function recordAgentVersionDeployment(input: {
  outcome: "matched" | "mismatch" | "blocked" | "deployed";
  releaseMode: "follow_published";
  count?: number;
}): void {
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count <= 0) return;
  agentVersionDeploymentCounter.add(count, {
    outcome: input.outcome,
    release_mode: input.releaseMode,
  });
}

export function recordConversationAdmission(input: {
  outcome: "accepted" | "busy" | "idempotent" | "redelivery" | "retry";
  channel: string;
}): void {
  conversationAdmissionCounter.add(1, {
    outcome: input.outcome,
    channel: boundedAttribute(input.channel),
  });
}
