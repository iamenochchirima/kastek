import type { AgentLoopEvent } from "./loop";

export type ExecutionLifecycle =
  | "run.admitted"
  | "stage.queued"
  | "stage.started"
  | "stage.completed"
  | "stage.failed"
  | "stage.waiting"
  | "stage.skipped"
  | "route.selected"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.expired";

export type ExecutionStageMetadata = {
  stageId: string;
  lifecycle: ExecutionLifecycle;
  operationId?: string;
  attemptId?: string;
  parentOperationId?: string;
  occurrence?: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: { code?: string; message?: string };
  sourceStageId?: string;
  targetStageId?: string;
  descriptor?: {
    stageId: string;
    label: string;
    kind: string;
    configured: boolean;
    availability: "declared" | "ready" | "blocked" | "unavailable" | "observed";
    parentStageId?: string;
  };
};

export type ExecutionRunMetadata = {
  lifecycle: ExecutionLifecycle;
  stageId?: string;
  operationId?: string;
  occurrence?: number;
  error?: { code?: string; message?: string };
};

function capabilityMetadata(
  lifecycle: ExecutionLifecycle,
  event: AgentLoopEvent,
  payload: Record<string, unknown>,
): ExecutionStageMetadata | undefined {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) return undefined;
  const operationId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
  const stageId = `capability:${name}`;
  const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : undefined;
  const finishedAt = typeof payload.completedAt === "string"
    ? payload.completedAt
    : typeof payload.failedAt === "string"
      ? payload.failedAt
      : undefined;
  const durationMs = typeof payload.latencyMs === "number" ? payload.latencyMs : undefined;
  const error = isErrorRecord(payload.error) ? payload.error : undefined;
  return {
    stageId,
    lifecycle,
    ...(operationId ? { operationId } : {}),
    occurrence: event.iteration,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(error ? { error } : {}),
    descriptor: {
      stageId,
      label: name,
      kind: "capability",
      configured: true,
      availability: "observed",
    },
  };
}

function isErrorRecord(value: unknown): value is { code?: string; message?: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function modelMetadata(lifecycle: ExecutionLifecycle, payload: Record<string, unknown>): ExecutionStageMetadata {
  const operationId = typeof payload.operationKey === "string" ? payload.operationKey : undefined;
  const attemptId = operationId;
  const attemptIndex = operationId ? Number(operationId.split(":").at(-1)) : Number.NaN;
  const occurrence = Number.isSafeInteger(attemptIndex) && attemptIndex >= 0 ? attemptIndex + 1 : undefined;
  const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : undefined;
  const finishedAt = typeof payload.completedAt === "string"
    ? payload.completedAt
    : typeof payload.failedAt === "string"
      ? payload.failedAt
      : undefined;
  const durationMs = typeof payload.latencyMs === "number" ? payload.latencyMs : undefined;
  return {
    stageId: "model",
    lifecycle,
    ...(operationId ? { operationId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(occurrence !== undefined ? { occurrence } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function memoryMetadata(lifecycle: ExecutionLifecycle, payload: Record<string, unknown>): ExecutionStageMetadata {
  const operationId = typeof payload.attemptId === "string" ? payload.attemptId : undefined;
  return {
    stageId: "memory-read",
    lifecycle,
    ...(operationId ? { operationId, attemptId: operationId } : {}),
    occurrence: typeof payload.evidenceCount === "number" ? payload.evidenceCount : undefined,
    ...(isErrorRecord(payload.error) ? { error: payload.error } : {}),
  };
}

/**
 * Translate one typed harness boundary into the execution metadata consumed by
 * the Studio. Unknown harness events intentionally produce no graph event.
 * The graph must never infer a stage from an event name or free-form payload.
 */
export function executionMetadataForLoopEvent(event: AgentLoopEvent): ExecutionStageMetadata | ExecutionRunMetadata | undefined {
  switch (event.type) {
    case "loop.started":
      return {
        stageId: "session",
        lifecycle: "stage.started",
        operationId: `session:${event.iteration}`,
        occurrence: event.iteration || 1,
      };
    case "context.planned":
      return {
        stageId: "context",
        lifecycle: "stage.completed",
        operationId: `context:${event.iteration}`,
        occurrence: event.iteration,
      };
    case "model.started":
      return modelMetadata("stage.started", event.payload);
    case "model.completed":
      return modelMetadata("stage.completed", event.payload);
    case "model.failed":
      return modelMetadata("stage.failed", event.payload);
    case "route.selected": {
      const sourceStageId = typeof event.payload.sourceStageId === "string" ? event.payload.sourceStageId : undefined;
      const targetStageId = typeof event.payload.targetStageId === "string" ? event.payload.targetStageId : undefined;
      if (!sourceStageId || !targetStageId) return undefined;
      return {
        stageId: targetStageId,
        lifecycle: "route.selected",
        ...(typeof event.payload.operationId === "string" ? { operationId: event.payload.operationId } : {}),
        sourceStageId,
        targetStageId,
      };
    }
    case "tool.proposed":
      return capabilityMetadata("stage.queued", event, event.payload);
    case "tool.started":
      return capabilityMetadata("stage.started", event, event.payload);
    case "tool.completed":
      return capabilityMetadata("stage.completed", event, event.payload);
    case "tool.failed":
      return capabilityMetadata("stage.failed", event, event.payload);
    case "memory_retrieval_requested":
      return memoryMetadata("stage.started", event.payload);
    case "memory_retrieval_completed":
      return memoryMetadata("stage.completed", event.payload);
    case "memory_retrieval_blocked":
      return memoryMetadata("stage.failed", event.payload);
    case "loop.paused": {
      const reason = event.payload.reason;
      const stageId = reason === "handoff" ? "handoff" : reason === "approval" ? "approval" : "session";
      return {
        stageId,
        lifecycle: "stage.waiting",
        operationId: `${stageId}:${event.iteration}`,
        occurrence: event.iteration || 1,
      };
    }
    case "loop.completed":
      return {
        stageId: "response",
        lifecycle: "stage.completed",
        operationId: `response:${event.iteration}`,
        occurrence: event.iteration || 1,
      };
    case "loop.failed":
      return {
        lifecycle: "run.failed",
        error: isErrorRecord(event.payload) ? event.payload : undefined,
      };
    default:
      return undefined;
  }
}

export function executionMetadataForRunAdmission(runId: string): ExecutionRunMetadata {
  return {
    lifecycle: "run.admitted",
    stageId: "input",
    operationId: `run:${runId}`,
    occurrence: 1,
  };
}

export function executionMetadataForTerminalRun(
  status: "completed" | "failed" | "cancelled" | "expired",
  error?: Record<string, unknown>,
): ExecutionRunMetadata {
  return {
    lifecycle: `run.${status}`,
    ...(isErrorRecord(error) ? { error } : {}),
  };
}
