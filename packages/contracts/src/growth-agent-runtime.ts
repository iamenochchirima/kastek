/** Safe execution observations. No prompts, tool arguments, results or private model reasoning. */
export interface GrowthAgentRuntimeOperation {
  id: string;
  taskId: string;
  agentName: string;
  kind: "model" | "compaction" | "tool" | "delegation" | "resource";
  label: string;
  category?: string;
  source?: "runtime" | "product" | "connection";
  activityKind?: "capability_discovery" | "capability_loading";
  technicalName?: string;
  state: "started" | "completed" | "failed" | "uncertain";
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  errorCode: string | null;
}
export interface GrowthAgentRuntime {
  version: 1;
  observedAt: string;
  elapsedMs: number | null;
  workId?: string | null;
  workElapsedMs?: number | null;
  model: {
    id: string | null;
    provider: string | null;
    latencyMs: number | null;
    firstTokenMs: number | null;
    outputTokensPerSecond: number | null;
  };
  context: {
    estimatedInputTokens: number | null;
    inputLimitTokens: number | null;
    windowTokens: number | null;
    reservedOutputTokens: number | null;
    safetyTokens: number | null;
    utilizationPercent: number | null;
    compactAtTokens?: number | null;
    pressure?: "normal" | "compaction_due" | null;
    decision?: "prepared" | "compacting" | "compacted" | null;
    compactionCount: number;
    lastCompactedAt: string | null;
    historyGroups: number | null;
    sourceCount: number | null;
  };
  usage: {
    accountedTokens: number;
    inputTokens: number | null;
    outputTokens: number | null;
    modelCalls: number;
    toolCalls: number;
    observedModelCalls: number;
    /** Managed model cost in micro-USD. Absent when the caller did not attribute cost. */
    managedCostMicros?: number;
  };
  operations: GrowthAgentRuntimeOperation[];
  operationsTruncated: boolean;
}
