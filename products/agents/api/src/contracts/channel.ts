import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { HandoffFeedbackRequest } from "../execution/lifecycle/handoff-feedback-contract";

export const channelBindingSchema = z.strictObject({ customerConversationId: z.uuid(),
  ownershipGeneration: z.string().regex(/^[1-9][0-9]{0,18}$/), inputMessageId: z.uuid() });
export type ChannelBinding = z.infer<typeof channelBindingSchema>;
export const handoffBriefSchema = z.strictObject({reason:z.string().trim().min(1).max(200),brief:z.string().trim().min(1).max(2000)});
export type HandoffBrief = z.infer<typeof handoffBriefSchema>;
export interface VisitorLineage {
  organizationId: string; agentId: string; executionConversationId: string; customerConversationId: string;
  current: { deploymentId: string; sessionId: string }; origin: { deploymentId: string; sessionId: string }; originTaskId?: string;
}
export interface ChannelExecutionPorts {
  assertBinding(db: Pool | PoolClient, binding: ChannelBinding, task: { organization_id: string; version_id: string; root_task_id: string }): Promise<void>;
  requestHandoff(db: PoolClient, binding: ChannelBinding, taskId: string, brief?: HandoffBrief, cause?: { bookingOperationId: string }): Promise<{ state: "handoff_pending" }>;
  requestHandoffV2?(db: PoolClient, binding: ChannelBinding, taskId: string, brief: HandoffBrief, feedback?: HandoffFeedbackRequest): Promise<{ state: "handoff_pending" }>;
  publishAutomated(db: PoolClient, input: { taskId: string; binding: ChannelBinding; output: string }): Promise<void>;
  visitorLineage?(db: Pool | PoolClient, input: VisitorLineage): Promise<boolean>;
  publishEnquiryReview?(db:PoolClient,input:{taskId:string;binding:ChannelBinding;reviewId:string;requestDigest:string;fields:Record<string,string|undefined>}):Promise<void>;
  publishToolReview?(db:PoolClient,input:{taskId:string;binding:ChannelBinding;reviewId:string;requestDigest:string;arguments:unknown}):Promise<void>;
  context(db: Pool | PoolClient, binding: ChannelBinding, beforeMessageId: string): Promise<{
    id: string; role: "user" | "assistant"; authorKind: "visitor" | "human" | "assistant"; content: string; taskId: string | null;
  }[]>;
}
