import type {ChannelKind} from "../../contracts/channel-adapters";
import type {PreferredSupportContact} from "../../contracts/human-assistance";

export type HumanRequestView={id:string;status:"requested"|"human_owned"|"completed"|"withdrawn";requestedAt:string;brief:{reason:string;brief:string};contact:PreferredSupportContact|null;humanOnly:boolean;workflow?:{name:string;status:"active"|"suspended"|"completed"|"cancelled";missing:string[]}};
export interface CustomerConversation {
  id: string; organization_id: string; deployment_id: string | null; agent_id: string; version_id: string; session_id: string | null;
  channel_kind: ChannelKind; channel_deployment_id: string | null; external_conversation_id: string | null; external_sender_id: string | null;
  execution_conversation_id: string | null; state: "automation_active" | "handoff_pending" | "human_owned" | "resolved";
  assignee_account_id: string | null; revision: string; ownership_generation: string; next_sequence: string;
  return_watermark: string; created_at: Date; updated_at: Date;
  customer_name?: string | null; customer_contact_id?: string | null; assignee_display_name?: string | null; channel_available?: boolean; last_message_body?: string | null; last_message_author_kind?: CustomerMessage["author_kind"] | null; last_message_created_at?: Date | null;
  humanRequest?: HumanRequestView | null;
  last_message_id?: string | null; last_message_task_id?: string | null;
  last_message_ownership_generation?: string | null;
}
export interface CustomerMessage { responseDurationMs?: number; id: string; conversation_id: string; sequence: string; author_kind: "visitor" | "human" | "assistant";
  author_account_id: string | null; body: string; task_id: string | null; ownership_generation: string; created_at: Date; request_key?: string;
  displayKind?: "system";
  channelFacts?: { occurredAt: Date | null; replyToProviderMessageId: string | null; attachments: {kind:string;fileName?:string;index:number}[] };
  deliveries?: {id:string;segment:number;state:string;reason:string|null}[] }
