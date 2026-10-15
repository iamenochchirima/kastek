/**
 * Build durable model-operation prefixes that are isolated to one agent run.
 *
 * The suffix containing iteration and fallback-attempt indexes is added by the
 * bounded loop. Keeping the run ID in the prefix preserves replay within a run
 * while preventing a different run from claiming the same operation.
 */
export function agentLoopOperationKeyPrefix(runId: string, checkpointIterations?: number): string {
  return checkpointIterations === undefined
    ? `activity:loop:${runId}`
    : `activity:loop:${runId}:${checkpointIterations}`;
}

export function workflowAgentLoopOperationKeyPrefix(runId: string, nodeId: string): string {
  return `workflow:agent-loop:${runId}:${nodeId}`;
}

export function workflowModelOperationKey(runId: string, nodeId: string): string {
  return `workflow:model:${runId}:${nodeId}`;
}
