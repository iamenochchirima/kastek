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
  pauseRun(input: ActivityScope & { runId: string; status: "awaiting_approval" | "awaiting_human" | "awaiting_external_event"; output: Record<string, unknown> }): Promise<void>;
  deliverApprovalPrompt(input: ActivityScope & { runId: string }): Promise<void>;
  cancelPendingApproval(input: ActivityScope & { runId: string; providerToolCallId: string; reason?: string; outcome?: "cancelled" | "expired" }): Promise<void>;
  cancelHandoff(input: ActivityScope & { runId: string; reason?: string }): Promise<void>;
  completeRun(input: ActivityScope & { runId: string; output: Record<string, unknown> }): Promise<void>;
  generateConversationTitle(input: ActivityScope & { runId: string }): Promise<void>;
  deliverRunReply(input: ActivityScope & { runId: string }): Promise<void>;
  failRun(input: ActivityScope & { runId: string; error: Record<string, unknown> }): Promise<void>;
}
