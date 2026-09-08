import { proxyActivities } from "@temporalio/workflow";

export type ContextCompactionPausePoint = "before_persist" | "after_persist";

export interface ContextCompactionWorkflowInput {
  readonly organizationId: string;
  readonly contextId: string;
  readonly operationId: string;
  readonly pausePoint: ContextCompactionPausePoint;
}

export interface ContextCompactionWorkflowResult {
  readonly generation: number;
  readonly replayed: boolean;
}

interface ContextCompactionActivities {
  executeContextCompaction(input: ContextCompactionWorkflowInput): Promise<ContextCompactionWorkflowResult>;
}

const { executeContextCompaction } = proxyActivities<ContextCompactionActivities>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "2 seconds" },
});

export async function contextCompactionReplayWorkflow(input: ContextCompactionWorkflowInput): Promise<ContextCompactionWorkflowResult> {
  return executeContextCompaction(input);
}
