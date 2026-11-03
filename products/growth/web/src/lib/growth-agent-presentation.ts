import { agentRuntimePresentation, type AgentExecution } from "@kasitek-labs/ui/agent";
import type { GrowthAgentTask } from "@kasitek-labs/contracts";

const duration = (value: number | null | undefined) => value == null ? "Unavailable" : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;

/** Product projection only. Shared components own presentation and interaction. */
export function growthExecution(task: GrowthAgentTask): AgentExecution {
  const runtime = task.runtime;
  return {
    ...agentRuntimePresentation(runtime),
    id: task.id, state: task.state, errorCode: task.boundary?.reason ?? task.errorCode, elapsedMs: runtime?.elapsedMs, observedAt: task.observedAt ?? task.updatedAt,
    updates: task.updates,
    approach: task.orchestration?.record ?? undefined,
    operations: runtime?.operations.filter(operation => operation.taskId === task.id).map(operation => ({
      id: operation.id, taskId: operation.taskId, category: operation.category, source: operation.source, activityKind: operation.activityKind, technicalName: operation.technicalName, label: operation.label, state: operation.state, kind: operation.kind, startedAt: operation.startedAt, durationMs: operation.durationMs, errorCode: operation.errorCode,
      details: `Duration: ${duration(operation.durationMs)}${operation.errorCode ? ` · ${operation.errorCode}` : ""}`,
      detailAvailability: "available" as const,
    })),
    children: task.children?.map(child => ({ id: child.id, name: child.name, state: child.state,
      assignment: child.assignment, createdAt: child.createdAt,
    })),
    context: runtime?.context,
  };
}
