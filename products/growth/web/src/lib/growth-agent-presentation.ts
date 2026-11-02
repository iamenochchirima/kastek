import type { AgentExecution } from "@kasitek-labs/ui/agent";
import type { GrowthAgentTask } from "@kasitek-labs/contracts";

const duration = (value: number | null | undefined) => value == null ? "Unavailable" : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
const count = (value: number | null | undefined) => value == null ? "Unavailable" : Math.round(value).toLocaleString();

/** Product projection only. Shared components own presentation and interaction. */
export function growthExecution(task: GrowthAgentTask): AgentExecution {
  const runtime = task.runtime;
  return {
    id: task.id, state: task.state, elapsedMs: runtime?.elapsedMs, observedAt: task.observedAt ?? task.updatedAt,
    updates: task.updates,
    approach: task.orchestration?.record ?? undefined,
    operations: runtime?.operations.filter(operation => operation.taskId === task.id && operation.kind !== "model").map(operation => ({
      id: operation.id, label: operation.label, state: operation.state, kind: operation.kind, startedAt: operation.startedAt,
      details: `Duration: ${duration(operation.durationMs)}${operation.errorCode ? ` · ${operation.errorCode}` : ""}`,
      detailAvailability: "available" as const,
    })),
    children: task.children?.map(child => ({ id: child.id, name: child.name, state: child.state,
      assignment: child.assignment, createdAt: child.createdAt,
    })),
    context: runtime?.context,
    diagnostics: runtime ? [
      { label: "Model", value: runtime.model.id || "Unavailable" },
      { label: "Elapsed", value: duration(runtime.elapsedMs) },
      { label: "Model latency", value: duration(runtime.model.latencyMs) },
      { label: "First visible token", value: duration(runtime.model.firstTokenMs) },
      { label: "Model calls", value: count(runtime.usage.modelCalls) },
      { label: "Tool calls", value: count(runtime.usage.toolCalls) },
      { label: "Accounted tokens", value: count(runtime.usage.accountedTokens) },
      { label: "Observed input / output", value: `${count(runtime.usage.inputTokens)} / ${count(runtime.usage.outputTokens)}` },
      { label: "Calls with observed usage", value: `${count(runtime.usage.observedModelCalls)} / ${count(runtime.usage.modelCalls)}` },
      { label: "Compactions", value: count(runtime.context.compactionCount) },
      { label: "Input limit", value: count(runtime.context.inputLimitTokens) },
      { label: "Output reserve", value: count(runtime.context.reservedOutputTokens) },
      { label: "Context pressure", value: runtime.context.pressure === "compaction_due" ? "Compaction due" : runtime.context.pressure === "normal" ? "Normal" : "Unavailable" },
    ] : undefined,
  };
}
