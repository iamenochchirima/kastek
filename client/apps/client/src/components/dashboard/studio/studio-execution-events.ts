import type { AgentStreamEvent } from "@/lib/agent-platform";
import type { ExecutionStageDescriptor, ExecutionStageEvent } from "./studio-execution-reducer";

const lifecycleTypes = new Set<ExecutionStageEvent["type"]>([
  "run.admitted",
  "stage.queued",
  "stage.started",
  "stage.completed",
  "stage.failed",
  "stage.waiting",
  "stage.skipped",
  "route.selected",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.expired",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function descriptor(value: unknown): ExecutionStageDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const stageId = stringValue(value.stageId);
  const label = stringValue(value.label);
  const kind = stringValue(value.kind);
  const availability = stringValue(value.availability);
  if (!stageId || !label || !kind || !availability || !["declared", "ready", "blocked", "unavailable", "observed"].includes(availability)) return undefined;
  return {
    stageId,
    label,
    kind,
    availability: availability as ExecutionStageDescriptor["availability"],
    configured: value.configured === true,
    ...(stringValue(value.parentStageId) ? { parentStageId: stringValue(value.parentStageId) } : {}),
  };
}

export function executionEventFromStream(event: AgentStreamEvent): ExecutionStageEvent | undefined {
  const payload = isRecord(event.data.payload) ? event.data.payload : event.data;
  const execution = isRecord(payload.execution) ? payload.execution : undefined;
  if (!execution) return undefined;
  const lifecycle = stringValue(execution.lifecycle);
  if (!lifecycle || !lifecycleTypes.has(lifecycle as ExecutionStageEvent["type"])) return undefined;
  const cursor = numberValue(event.data.sequence_number);
  const runId = stringValue(event.data.run_id) ?? stringValue(payload.runId);
  if (cursor === undefined || !runId) return undefined;
  const eventId = stringValue(event.data.event_id) ?? `${runId}:${cursor}:${event.event}`;
  const stageId = stringValue(execution.stageId);
  const rawError = isRecord(execution.error) ? execution.error : undefined;
  return {
    eventId,
    cursor,
    runId,
    type: lifecycle as ExecutionStageEvent["type"],
    ...(stageId ? { stageId } : {}),
    ...(stringValue(execution.operationId) ? { operationId: stringValue(execution.operationId) } : {}),
    ...(stringValue(execution.attemptId) ? { attemptId: stringValue(execution.attemptId) } : {}),
    ...(stringValue(execution.parentOperationId) ? { parentOperationId: stringValue(execution.parentOperationId) } : {}),
    ...(numberValue(execution.occurrence) !== undefined ? { occurrence: numberValue(execution.occurrence) } : {}),
    ...(stringValue(execution.startedAt) ? { startedAt: stringValue(execution.startedAt) } : {}),
    ...(stringValue(execution.finishedAt) ? { finishedAt: stringValue(execution.finishedAt) } : {}),
    ...(numberValue(execution.durationMs) !== undefined ? { durationMs: numberValue(execution.durationMs) } : {}),
    ...(stringValue(execution.sourceStageId) ? { sourceStageId: stringValue(execution.sourceStageId) } : {}),
    ...(stringValue(execution.targetStageId) ? { targetStageId: stringValue(execution.targetStageId) } : {}),
    ...(rawError ? { error: { ...(stringValue(rawError.code) ? { code: stringValue(rawError.code) } : {}), ...(stringValue(rawError.message) ? { message: stringValue(rawError.message) } : {}) } } : {}),
    ...(descriptor(execution.descriptor) ? { descriptor: descriptor(execution.descriptor) } : {}),
    data: payload,
  };
}
