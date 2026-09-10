import assert from "node:assert/strict";
import { applyExecutionStageEvent, createExecutionObservatoryState, type ExecutionStageDescriptor } from "./studio-execution-reducer";

const stages: ExecutionStageDescriptor[] = [
  { stageId: "input", label: "Input", kind: "input", availability: "ready", configured: true },
  { stageId: "context", label: "Context", kind: "context", availability: "ready", configured: true },
  { stageId: "tool:calendar", label: "Google Calendar", kind: "tool", availability: "ready", configured: true },
];

let state = createExecutionObservatoryState(stages);
state = applyExecutionStageEvent(state, { eventId: "e1", cursor: 1, runId: "run-1", type: "run.admitted", stageId: "input" });
assert.equal(state.runStatus, "running");
state = applyExecutionStageEvent(state, { eventId: "e2", cursor: 2, runId: "run-1", type: "stage.started", stageId: "input", operationId: "input-1", occurrence: 1 });
assert.equal(state.topology.input.status, "running");
state = applyExecutionStageEvent(state, { eventId: "e3", cursor: 3, runId: "run-1", type: "stage.completed", stageId: "input", operationId: "input-1", durationMs: 4 });
assert.equal(state.topology.input.status, "complete");
state = applyExecutionStageEvent(state, { eventId: "e4", cursor: 4, runId: "run-1", type: "stage.started", stageId: "context", operationId: "context-1", occurrence: 1 });
state = applyExecutionStageEvent(state, { eventId: "e5", cursor: 5, runId: "run-1", type: "stage.completed", stageId: "context", operationId: "context-1", durationMs: 120 });
state = applyExecutionStageEvent(state, { eventId: "e6", cursor: 6, runId: "run-1", type: "stage.started", stageId: "context", operationId: "context-2", occurrence: 2 });
assert.equal(state.topology.context.operationCount, 2);
assert.equal(state.topology.context.status, "running");
state = applyExecutionStageEvent(state, { eventId: "e7", cursor: 7, runId: "run-1", type: "stage.failed", stageId: "tool:calendar", operationId: "tool-1", error: { code: "CALENDAR_AUTH_EXPIRED" } });
assert.equal(state.failedStageId, "tool:calendar");
assert.equal(state.selectedStageId, "tool:calendar");
assert.equal(state.topology["tool:calendar"].status, "error");
assert.equal(state.topology["tool:calendar"].latestError?.code, "CALENDAR_AUTH_EXPIRED");

const replayed = applyExecutionStageEvent(state, { eventId: "e7", cursor: 7, runId: "run-1", type: "stage.failed", stageId: "tool:calendar", operationId: "tool-1" });
assert.equal(replayed, state);

console.log("studio execution reducer: ok");
