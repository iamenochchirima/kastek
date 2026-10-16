import type { PoolClient } from "pg";
import {
  buildConversationLifecycleEvent,
  buildConversationMessageEvent,
  type AgentConversationAnalyticsContext,
  type AgentConversationLifecycleAnalyticsInput,
  type AgentConversationMessageAnalyticsInput,
} from "./agent-runtime";
import { enqueueOutbox } from "./producer";

type ConversationMessageAnalyticsRecord = {
  id: string;
  conversation_id: string;
  participant_id?: string | null;
  direction: string;
  message_type: string;
  provider?: string | null;
  run_id?: string | null;
  source_channel?: string | null;
  occurred_at: string;
  delivery_status?: string | null;
};

type ConversationAnalyticsContextRow = {
  conversation_id: string;
  organization_id: string;
  installation_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  agent_audience: AgentConversationAnalyticsContext["agentAudience"];
  conversation_kind: AgentConversationAnalyticsContext["conversationKind"];
  channel_type: string;
  status: AgentConversationAnalyticsContext["status"];
  handoff_state: AgentConversationAnalyticsContext["handoffState"];
};

export async function loadAgentConversationAnalyticsContext(
  client: PoolClient,
  organizationId: string,
  conversationId: string,
): Promise<AgentConversationAnalyticsContext> {
  const result = await client.query<ConversationAnalyticsContextRow>(
    `SELECT c.id AS conversation_id,
            c.organization_id,
            c.installation_id,
            c.conversation_kind,
            c.channel_type,
            c.status,
            c.handoff_state,
            ai.agent_definition_id,
            ai.agent_version_id,
            ad.agent_audience
     FROM conversations c
     JOIN agent_installations ai ON ai.id = c.installation_id AND ai.organization_id = c.organization_id
     JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
     WHERE c.organization_id = $1 AND c.id = $2`,
    [organizationId, conversationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Conversation analytics context not found");
  return {
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    installationId: row.installation_id,
    agentDefinitionId: row.agent_definition_id,
    agentVersionId: row.agent_version_id,
    agentAudience: row.agent_audience,
    conversationKind: row.conversation_kind,
    channel: row.channel_type,
    status: row.status,
    handoffState: row.handoff_state,
  };
}

export async function enqueueAgentConversationLifecycle(
  client: PoolClient,
  context: AgentConversationAnalyticsContext,
  input: Pick<AgentConversationLifecycleAnalyticsInput, "action" | "actorType" | "occurredAt">,
): Promise<void> {
  await enqueueOutbox(client, buildConversationLifecycleEvent({ ...context, ...input }));
}

export async function enqueueAgentConversationMessage(
  client: PoolClient,
  context: AgentConversationAnalyticsContext,
  message: ConversationMessageAnalyticsRecord,
  action: AgentConversationMessageAnalyticsInput["action"],
  occurredAt: Date | string = message.occurred_at,
): Promise<void> {
  const participantType = message.participant_id
    ? (await client.query<{ participant_type: "user" | "customer" | "staff" | "agent" | "system" }>(
      `SELECT participant_type
       FROM participants
       WHERE id = $1 AND conversation_id = $2 AND organization_id = $3`,
      [message.participant_id, message.conversation_id, context.organizationId],
    )).rows[0]?.participant_type
    : undefined;
  const direction = messageDirection(message.direction);
  const responderType = responderTypeForMessage(context, { ...message, direction }, participantType);
  const responseTimeMs = action === "created"
    ? await precedingCustomerResponseTime(client, context, message, responderType)
    : null;
  await enqueueOutbox(client, buildConversationMessageEvent({
    ...context,
    messageId: message.id,
    action,
    direction,
    responderType,
    messageType: message.message_type,
    deliveryStatus: message.delivery_status ?? null,
    runId: message.run_id ?? null,
    responseTimeMs,
    occurredAt,
    channel: message.source_channel || context.channel,
  }));
}

function responderTypeForMessage(
  context: AgentConversationAnalyticsContext,
  message: ConversationMessageAnalyticsRecord & { direction: "inbound" | "outbound" | "system" },
  participantType: "user" | "customer" | "staff" | "agent" | "system" | undefined,
): AgentConversationMessageAnalyticsInput["responderType"] {
  if (message.direction === "system" || participantType === "system") return "system";
  if (participantType === "customer" || (message.direction === "inbound" && context.conversationKind === "customer")) return "customer";
  if (participantType === "agent" || message.run_id) return "agent";
  if (message.provider === "kasitek-human" || participantType === "staff" || participantType === "user") return "human";
  return message.direction === "inbound" ? "human" : "agent";
}

function messageDirection(value: string): "inbound" | "outbound" | "system" {
  if (value === "inbound" || value === "outbound" || value === "system") return value;
  throw new Error(`Unsupported conversation message direction: ${value}`);
}

async function precedingCustomerResponseTime(
  client: PoolClient,
  context: AgentConversationAnalyticsContext,
  message: ConversationMessageAnalyticsRecord,
  responderType: AgentConversationMessageAnalyticsInput["responderType"],
): Promise<number | null> {
  if (context.conversationKind !== "customer" || message.direction !== "outbound" || !["agent", "human"].includes(responderType)) return null;
  const result = await client.query<{ response_time_ms: string | null }>(
    `SELECT GREATEST(0, ROUND(EXTRACT(EPOCH FROM (($3::timestamptz - m.occurred_at) * 1000)))::bigint)::text AS response_time_ms
     FROM messages m
     LEFT JOIN participants p ON p.id = m.participant_id
       AND p.organization_id = m.organization_id
       AND p.conversation_id = m.conversation_id
     WHERE m.organization_id = $1
       AND m.conversation_id = $2
       AND m.direction = 'inbound'
       AND p.participant_type = 'customer'
       AND m.occurred_at <= $3::timestamptz
     ORDER BY m.occurred_at DESC, m.sequence_number DESC
     LIMIT 1`,
    [context.organizationId, context.conversationId, message.occurred_at],
  );
  const value = Number(result.rows[0]?.response_time_ms);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type { ConversationMessageAnalyticsRecord };
