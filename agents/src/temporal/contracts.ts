import type { RunStatus } from "../domain/types";
import type { AgentLoopResult } from "../runtime/loop";
import type { ToolApproval } from "../tools/types";

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
}

export interface CancellationSignal {
  reason?: string;
}

export interface DurableRunInput {
  runId: string;
  resumeApprovedToolCall?: ResumeApprovedToolCall;
}

export interface TransitionRunActivityInput {
  runId: string;
  expectedStatus: RunStatus;
  nextStatus: RunStatus;
}

export interface AgentRunActivities {
  transitionRun(input: TransitionRunActivityInput): Promise<void>;
  executeLoop(input: DurableRunInput): Promise<AgentLoopResult>;
  pauseRun(input: { runId: string; status: "awaiting_approval" | "awaiting_human" | "awaiting_external_event"; output: Record<string, unknown> }): Promise<void>;
  completeRun(input: { runId: string; output: Record<string, unknown> }): Promise<void>;
  generateConversationTitle(input: { runId: string }): Promise<void>;
  deliverRunReply(input: { runId: string }): Promise<void>;
  failRun(input: { runId: string; error: Record<string, unknown> }): Promise<void>;
}
