export type ExecutionRunStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "expired";
export type ExecutionStageStatus = "idle" | "queued" | "running" | "waiting" | "complete" | "error" | "skipped";
export type ExecutionAvailability = "declared" | "ready" | "blocked" | "unavailable" | "observed";

export type ExecutionStageDescriptor = {
  stageId: string;
  label: string;
  kind: string;
  availability: ExecutionAvailability;
  configured: boolean;
  parentStageId?: string;
};

export type ExecutionStageEvent = {
  eventId: string;
  cursor: number;
  runId: string;
  type:
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
  stageId?: string;
  operationId?: string;
  attemptId?: string;
  parentOperationId?: string;
  occurrence?: number;
  occurredAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  sourceStageId?: string;
  targetStageId?: string;
  error?: { code?: string; message?: string };
  descriptor?: ExecutionStageDescriptor;
  data?: Record<string, unknown>;
};

export type ExecutionOperation = {
  operationId: string;
  stageId: string;
  attemptId?: string;
  parentOperationId?: string;
  occurrence: number;
  status: Exclude<ExecutionStageStatus, "idle" | "queued" | "skipped">;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: { code?: string; message?: string };
  cursor: number;
};

export type ExecutionStageState = ExecutionStageDescriptor & {
  status: ExecutionStageStatus;
  activeOperationIds: string[];
  operationCount: number;
  completedCount: number;
  errorCount: number;
  latestOperationId?: string;
  latestError?: { code?: string; message?: string };
};

export type ExecutionObservatoryState = {
  runId?: string;
  runStatus: ExecutionRunStatus;
  cursor: number;
  topology: Record<string, ExecutionStageState>;
  operations: Record<string, ExecutionOperation>;
  activeRoute?: { sourceStageId: string; targetStageId: string; cursor: number };
  selectedStageId?: string;
  failedStageId?: string;
  seenEventIds: Record<string, true>;
};

function stageState(descriptor: ExecutionStageDescriptor): ExecutionStageState {
  return {
    ...descriptor,
    status: "idle",
    activeOperationIds: [],
    operationCount: 0,
    completedCount: 0,
    errorCount: 0,
  };
}

export function createExecutionObservatoryState(descriptors: readonly ExecutionStageDescriptor[] = []): ExecutionObservatoryState {
  return {
    runStatus: "idle",
    cursor: 0,
    topology: Object.fromEntries(descriptors.map((descriptor) => [descriptor.stageId, stageState(descriptor)])),
    operations: {},
    seenEventIds: {},
  };
}

function withStage(state: ExecutionObservatoryState, descriptor: ExecutionStageDescriptor): ExecutionObservatoryState {
  if (state.topology[descriptor.stageId]) return state;
  return {
    ...state,
    topology: { ...state.topology, [descriptor.stageId]: stageState(descriptor) },
  };
}

function operationStatusForEvent(event: ExecutionStageEvent): ExecutionOperation["status"] {
  if (event.type === "stage.failed") return "error";
  if (event.type === "stage.waiting") return "waiting";
  return event.type === "stage.started" ? "running" : "complete";
}

function terminalRunStatus(type: ExecutionStageEvent["type"]): ExecutionRunStatus | undefined {
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  if (type === "run.expired") return "expired";
  return undefined;
}

/**
 * Apply one authoritative runtime event. Events are cursor-ordered and
 * idempotent; a stale or replayed event cannot mutate the current view.
 */
export function applyExecutionStageEvent(input: ExecutionObservatoryState, event: ExecutionStageEvent): ExecutionObservatoryState {
  if (event.runId !== input.runId && input.runId !== undefined) return input;
  if (input.seenEventIds[event.eventId] || event.cursor <= input.cursor) return input;

  let state: ExecutionObservatoryState = {
    ...input,
    runId: event.runId,
    cursor: event.cursor,
    seenEventIds: { ...input.seenEventIds, [event.eventId]: true },
  };
  if (event.descriptor) state = withStage(state, event.descriptor);

  const terminalStatus = terminalRunStatus(event.type);
  if (terminalStatus) {
    const terminalTopology = { ...state.topology };
    for (const stageId of ["input", "session"]) {
      const stage = terminalTopology[stageId];
      if (!stage) continue;
      terminalTopology[stageId] = { ...stage, status: terminalStatus === "completed" ? "complete" : terminalStatus === "failed" ? "error" : "skipped" };
    }
    return {
      ...state,
      runStatus: terminalStatus,
      topology: terminalTopology,
      ...(event.stageId && terminalStatus === "failed" ? { failedStageId: event.stageId, selectedStageId: event.stageId } : {}),
    };
  }
  if (event.type === "run.admitted") {
    if (!event.stageId || !state.topology[event.stageId]) return { ...state, runStatus: "running" };
    return {
      ...state,
      runStatus: "running",
      topology: {
        ...state.topology,
        [event.stageId]: { ...state.topology[event.stageId]!, status: "running" },
      },
    };
  }
  if (event.type === "route.selected" && event.sourceStageId && event.targetStageId) {
    return { ...state, activeRoute: { sourceStageId: event.sourceStageId, targetStageId: event.targetStageId, cursor: event.cursor } };
  }
  if (!event.stageId) return state;

  const currentStage = state.topology[event.stageId];
  if (!currentStage) return state;
  const stage = { ...currentStage };
  const operationId = event.operationId ?? `${event.stageId}:${event.cursor}`;
  const existingOperation = state.operations[operationId];
  const occurrence = event.occurrence ?? existingOperation?.occurrence ?? stage.operationCount + 1;
  const operations = { ...state.operations };

  if (event.type === "stage.queued") {
    stage.status = "queued";
  } else if (event.type === "stage.started") {
    stage.status = "running";
    if (!existingOperation) stage.operationCount = Math.max(stage.operationCount, occurrence);
    if (!stage.activeOperationIds.includes(operationId)) stage.activeOperationIds = [...stage.activeOperationIds, operationId];
    operations[operationId] = {
      operationId,
      stageId: event.stageId,
      ...(event.attemptId ? { attemptId: event.attemptId } : {}),
      ...(event.parentOperationId ? { parentOperationId: event.parentOperationId } : {}),
      occurrence,
      status: "running",
      ...(event.startedAt ? { startedAt: event.startedAt } : {}),
      cursor: event.cursor,
    };
  } else if (["stage.completed", "stage.failed", "stage.waiting", "stage.skipped"].includes(event.type)) {
    const status = operationStatusForEvent(event);
    const operation: ExecutionOperation = {
      operationId,
      stageId: event.stageId,
      ...(event.attemptId ? { attemptId: event.attemptId } : existingOperation?.attemptId ? { attemptId: existingOperation.attemptId } : {}),
      ...(event.parentOperationId ? { parentOperationId: event.parentOperationId } : existingOperation?.parentOperationId ? { parentOperationId: existingOperation.parentOperationId } : {}),
      occurrence,
      status,
      ...(event.startedAt ?? existingOperation?.startedAt ? { startedAt: event.startedAt ?? existingOperation?.startedAt } : {}),
      ...(event.finishedAt ? { finishedAt: event.finishedAt } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.error ? { error: event.error } : existingOperation?.error ? { error: existingOperation.error } : {}),
      cursor: event.cursor,
    };
    operations[operationId] = operation;
    stage.operationCount = Math.max(stage.operationCount, occurrence);
    stage.latestOperationId = operationId;
    stage.activeOperationIds = stage.activeOperationIds.filter((id) => id !== operationId);
    stage.status = event.type === "stage.failed" ? "error" : event.type === "stage.waiting" ? "waiting" : event.type === "stage.skipped" ? "skipped" : stage.activeOperationIds.length ? "running" : "complete";
    if (event.type === "stage.completed") stage.completedCount += 1;
    if (event.type === "stage.failed") {
      stage.errorCount += 1;
      stage.latestError = event.error;
    }
    state = {
      ...state,
      ...(event.type === "stage.failed" ? { failedStageId: event.stageId, selectedStageId: event.stageId } : {}),
    };
  }

  return {
    ...state,
    runStatus: event.type === "stage.waiting" ? "waiting" : state.runStatus,
    topology: { ...state.topology, [event.stageId]: stage },
    operations,
  };
}
