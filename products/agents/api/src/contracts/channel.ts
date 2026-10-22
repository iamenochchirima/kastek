import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export const channelBindingSchema = z.strictObject({ customerConversationId: z.uuid(),
  ownershipGeneration: z.string().regex(/^[1-9][0-9]{0,18}$/), inputMessageId: z.uuid() });
export type ChannelBinding = z.infer<typeof channelBindingSchema>;
export interface ChannelExecutionPorts {
  assertBinding(db: Pool | PoolClient, binding: ChannelBinding, task: { organization_id: string; version_id: string; root_task_id: string }): Promise<void>;
  requestHandoff(db: PoolClient, binding: ChannelBinding, taskId: string): Promise<{ state: "handoff_pending" }>;
  publishAutomated(db: PoolClient, input: { taskId: string; binding: ChannelBinding; output: string }): Promise<void>;
  publishToolReview?(db:PoolClient,input:{taskId:string;binding:ChannelBinding;reviewId:string;requestDigest:string;arguments:unknown}):Promise<void>;
  context(db: Pool | PoolClient, binding: ChannelBinding, beforeMessageId: string): Promise<{
    id: string; role: "user" | "assistant"; authorKind: "visitor" | "human" | "assistant"; content: string; taskId: string | null;
  }[]>;
}
