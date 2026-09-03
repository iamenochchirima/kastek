import type { RunStatus } from "../domain/types";
import type { AgentLoopResult } from "../runtime/loop";
import type { ToolApproval } from "../tools/types";

export type DurableAgentLoopResult = AgentLoopResult & {
  /** True when the activity persisted a continuation and the workflow should schedule another step. */
  checkpointed?: boolean;
};

export interface ResumeApprovedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  approval: ToolApproval;
}

/**
 * A batch effect is admitted asynchronously by Core. Keep its identity in the
 * workflow result so Temporal can observe the durable outcome before completing
 * the user-facing run.
 */
export interface PendingBatchPublish {
  toolName: "kasitek.core.content_post_publish_batch" | "kasitek.core.content_post_publish_batch_retry";
  batchId: string;
  title?: string;
}

export interface ContentPublishBatchStatusActivityResult {
  status: string;
  batch?: Record<string, unknown>;
}

export interface ApprovalSignal {
  decision: "approved" | "rejected";
  approvedBy: string;
  argumentsHash: string;
  providerToolCallId: string;
  expiresAt: string;
  resourceSnapshot?: Record<string, unknown>;
}

export interface CancellationSignal {
  reason?: string;
}

export interface ExpirationSignal {
  reason?: string;
}

export interface ExternalEventSignal {
  key: string;
  payload: Record<string, unknown>;
}

export interface ActivityScope {
  /** Tenant scope copied into the activity for transaction-local RLS context. */
  organizationId?: string;
  /** Originating actor used for audit context; it is not an authorization grant. */
  actorId?: string;
}

export interface DurableRunInput extends ActivityScope {
  runId: string;
  /** Deterministic bounded-loop slice number used to make activity retries idempotent. */
  loopStep?: number;
  /** Opt-in rollout for independently retryable context/model/tool/checkpoint activities. */
  decomposed?: boolean;
  resumeApprovedToolCall?: ResumeApprovedToolCall;
  resumeExternalEvent?: ExternalEventSignal;
}

export interface TransitionRunActivityInput extends ActivityScope {
  runId: string;
  expectedStatus: RunStatus;
  nextStatus: RunStatus;
}

export interface AgentRunActivities {
  transitionRun(input: TransitionRunActivityInput): Promise<void>;
  executeLoop(input: DurableRunInput): Promise<DurableAgentLoopResult>;
  /** Read the Core-owned batch state without creating another approval or effect. */
  getContentPublishBatchStatus(input: ActivityScope & { runId: string; batchId: string }): Promise<ContentPublishBatchStatusActivityResult>;
  pauseRun(input: ActivityScope & { runId: string; status: "awaiting_approval" | "awaiting_human" | "awaiting_external_event"; output: Record<string, unknown> }): Promise<void>;
  deliverApprovalPrompt(input: ActivityScope & { runId: string }): Promise<void>;
  cancelPendingApproval(input: ActivityScope & { runId: string; providerToolCallId: string; reason?: string; outcome?: "cancelled" | "expired" }): Promise<void>;
  cancelHandoff(input: ActivityScope & { runId: string; reason?: string }): Promise<void>;
  completeRun(input: ActivityScope & { runId: string; output: Record<string, unknown> }): Promise<void>;
  generateConversationTitle(input: ActivityScope & { runId: string }): Promise<void>;
  deliverRunReply(input: ActivityScope & { runId: string }): Promise<void>;
  failRun(input: ActivityScope & { runId: string; error: Record<string, unknown> }): Promise<void>;
}
