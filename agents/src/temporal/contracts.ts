import type { RunStatus } from "../domain/types";
import type { AgentLoopResult } from "../runtime/loop";
import type { ToolApproval } from "../tools/types";

export type DurableAgentLoopResult = AgentLoopResult & {
  /** True when the activity persisted a continuation and the workflow should schedule another step. */
  checkpointed?: boolean;
};

export interface ResumeApprovedToolCall {
  /** Runtime identity used by approvals, receipts, and replay. */
  id: string;
  /** Provider wire identity retained only for reconstructing the model transcript. */
  providerToolCallId?: string;
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
  runtimeOperationId?: string;
  expiresAt: string;
  resourceSnapshot?: Record<string, unknown>;
}

export interface ApprovalGroupSignal {
  groupId: string;
  planDigest: string;
  decision: "approved" | "partially_approved" | "rejected" | "invalidated";
  approvedBy: string;
  selectedOperationIds: string[];
  expiresAt: string;
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
  sessionLease?: SessionLeaseAdmission;
}

export interface DurableRunInput extends ActivityScope {
  runId: string;
  /** Deterministic bounded-loop slice number used to make activity retries idempotent. */
  loopStep?: number;
  /** Internal rollout/test limit; production runs use the workflow default when omitted. */
  continueAsNewHistoryThreshold?: number;
  resumeApprovedToolCall?: ResumeApprovedToolCall;
  resumeExternalEvent?: ExternalEventSignal;
  /** Lease epoch admitted by the session coordinator; stale epochs fail closed. */
  sessionLease?: SessionLeaseAdmission;
}

export interface DurableToolCall {
  id: string;
  providerToolCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  sequenceNumber: number;
  /** Assigned by batch preparation and retained on every durable operation row. */
  batchId?: string;
  segmentId?: string;
  /** The canonical operation that supplies this identical call's result. */
  deduplicatedFrom?: string;
  /** Approval group created during durable batch preparation, when required. */
  approvalGroupId?: string;
  /** Digest of the exact approval plan reviewed by the human. */
  approvalPlanDigest?: string;
}

export interface DurableToolCallResult {
  id: string;
  providerToolCallId: string;
  name: string;
  argumentsHash: string;
  /** Approval group identity retained through commit/replay for lifecycle evidence. */
  approvalGroupId?: string;
  status: "completed" | "failed" | "waiting" | "blocked" | "unknown";
  failureClass?: "retryable" | "terminal" | "waiting" | "blocked" | "interrupted" | "unknown";
  output?: unknown;
  error?: { code: string; message: string };
  latencyMs?: number;
  effectId?: string;
  control?: "final_response" | "awaiting_human";
  waitingFor?: string;
}

export interface ExecuteToolCallActivityInput extends ActivityScope {
  runId: string;
  batchId: string;
  call: DurableToolCall;
  approval?: ToolApproval;
  approvalGroupId?: string;
  sessionLease?: SessionLeaseAdmission;
}

export interface PrepareToolBatchActivityInput extends ActivityScope {
  runId: string;
  batchId: string;
  calls: DurableToolCall[];
  sessionLease?: SessionLeaseAdmission;
}

export interface DurableToolBatchSegment {
  kind: "parallel" | "sequential";
  segmentId: string;
  calls: DurableToolCall[];
}

export interface CommitToolBatchActivityInput extends ActivityScope {
  runId: string;
  batchId: string;
  results: DurableToolCallResult[];
  remainingCalls?: DurableToolCall[];
  sessionLease?: SessionLeaseAdmission;
}

export interface CommitToolBatchActivityResult {
  status: "committed" | "replayed";
  toolCalls: number;
  control?: "final_response" | "awaiting_human";
  waitingFor?: string;
}

export interface SessionLeaseAdmission {
  acquired: boolean;
  sessionKey?: string;
  ownerId?: string;
  fencingToken?: string;
}

export interface TransitionRunActivityInput extends ActivityScope {
  runId: string;
  expectedStatus: RunStatus;
  nextStatus: RunStatus;
}

export interface AgentRunActivities {
  transitionRun(input: TransitionRunActivityInput): Promise<void>;
  /** Durable session serializer; omitted by legacy test-only activity fakes. */
  waitForConversationTurn?(input: ActivityScope & { runId: string }): Promise<boolean | SessionLeaseAdmission>;
  executeLoop(input: DurableRunInput): Promise<DurableAgentLoopResult>;
  /** Workflow-visible model/context slice for autonomous runs. It must not execute provider tools. */
  executeModelStep?(input: DurableRunInput): Promise<DurableAgentLoopResult>;
  /** Optional on legacy test-only activity fakes; required by the production worker. */
  prepareToolBatch?(input: PrepareToolBatchActivityInput): Promise<DurableToolBatchSegment[]>;
  /** Optional on legacy test-only activity fakes; required by the production worker. */
  executeToolCall?(input: ExecuteToolCallActivityInput): Promise<DurableToolCallResult>;
  /** Optional on legacy test-only activity fakes; required by the production worker. */
  commitToolBatch?(input: CommitToolBatchActivityInput): Promise<CommitToolBatchActivityResult>;
  /** Read the Core-owned batch state without creating another approval or effect. */
  getContentPublishBatchStatus(input: ActivityScope & { runId: string; batchId: string }): Promise<ContentPublishBatchStatusActivityResult>;
  pauseRun(input: ActivityScope & { runId: string; status: "awaiting_approval" | "awaiting_human" | "awaiting_external_event"; output: Record<string, unknown> }): Promise<void>;
  deliverApprovalPrompt(input: ActivityScope & { runId: string }): Promise<void>;
  cancelPendingApproval(input: ActivityScope & { runId: string; providerToolCallId: string; runtimeOperationId?: string; reason?: string; outcome?: "cancelled" | "expired" }): Promise<void>;
  cancelApprovalGroup?(input: ActivityScope & { runId: string; groupId: string; reason?: string }): Promise<void>;
  cancelHandoff(input: ActivityScope & { runId: string; reason?: string }): Promise<void>;
  completeRun(input: ActivityScope & { runId: string; output: Record<string, unknown> }): Promise<void>;
  generateConversationTitle(input: ActivityScope & { runId: string }): Promise<void>;
  deliverRunReply(input: ActivityScope & { runId: string }): Promise<void>;
  failRun(input: ActivityScope & { runId: string; error: Record<string, unknown> }): Promise<void>;
}
