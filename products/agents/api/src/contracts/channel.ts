import type {ProcedureDomainSnapshot} from "./procedure-domain";
import type {ProcedureScope,ProcedureEvidence} from "./procedures";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { dependencyManifestSchema } from "./source-contracts";

const message = z.strictObject({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable(),
  tool_calls: z.array(z.strictObject({ id: z.string().min(1), type: z.literal("function"),
    function: z.strictObject({ name: z.string().min(1), arguments: z.string() }) })).optional(),
  tool_call_id: z.string().min(1).optional(),
});

// Controller-owned snapshot. There are deliberately no model-callable tools.
export const handoffFeedbackRequestSchema = z.strictObject({
  modelRequest: z.strictObject({ model: z.string().min(1), messages: z.array(message).min(1),
    maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
    maxDurationSeconds: z.number().positive() }),
  evidenceManifest: dependencyManifestSchema,
});
export type HandoffFeedbackRequest = z.infer<typeof handoffFeedbackRequestSchema>;
export const HANDOFF_RECEIPT_DEADLINE_MS = 5000;

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
  procedureSnapshot?(db:PoolClient,scope:ProcedureScope,binding:ChannelBinding,taskId:string):Promise<ProcedureDomainSnapshot>;
  verifyProcedureEvidence?(db:PoolClient,scope:ProcedureScope,evidence:ProcedureEvidence):Promise<boolean>;
  requestHumanAssistance?(db:PoolClient,binding:ChannelBinding,taskId:string,input:unknown):Promise<{requestId:string;status:"requested"|"human_owned"|"completed"|"withdrawn";state:string;noticeMessageId:string|null;supportFacts:unknown}>;
  updateHumanAssistance?(db:PoolClient,binding:ChannelBinding,taskId:string,input:unknown):Promise<{requestId:string;status:"requested"|"human_owned"|"completed"|"withdrawn";state:string;noticeMessageId:string|null;supportFacts:unknown}>;

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
