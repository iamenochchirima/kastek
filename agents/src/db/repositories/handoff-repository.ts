import type { Pool } from "pg";
import { withTransaction } from "../pool";
import type { ConversationRecord } from "./conversation-repository";

export type HandoffReason = "customer_requested" | "agent_uncertain" | "policy_required" | "high_value" | "configured_workflow" | "other";
export type HandoffPriority = "normal" | "high" | "urgent";
export type HandoffStatus = "pending" | "claimed" | "resolved" | "expired" | "cancelled";

export interface HandoffRequestRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  conversation_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  run_id: string | null;
  channel_type: string;
  reason: HandoffReason;
  priority: HandoffPriority;
  summary: string;
  customer_message: string | null;
  status: HandoffStatus;
  requested_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  metadata: Record<string, unknown>;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface RequestHumanInput {
  organizationId: string;
  installationId: string;
  agentId: string;
  agentVersionId: string;
  runId?: string;
  conversationId: string;
  actorId?: string;
  reason: HandoffReason;
  priority: HandoffPriority;
  summary: string;
  customerMessage?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface RequestedHandoff {
  handoff: HandoffRequestRecord;
  conversation: ConversationRecord;
  created: boolean;
}

function handoffError(message: string, code: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export class HandoffRepository {
  public constructor(private readonly pool: Pool) {}

  public async requestHuman(input: RequestHumanInput): Promise<RequestedHandoff> {
    const summary = input.summary.trim();
    const customerMessage = input.customerMessage?.trim() || null;
    const metadata = input.metadata ?? {};
    const idempotencyKey = input.idempotencyKey?.trim() || `handoff:${input.runId ?? "manual"}:${input.conversationId}`;
    if (!summary) throw handoffError("A handoff summary is required", "handoff_summary_required", 400);
    if (summary.length > 2_000) throw handoffError("The handoff summary is too long", "handoff_summary_too_long", 400);
    if (customerMessage && customerMessage.length > 4_000) throw handoffError("The handoff customer message is too long", "handoff_customer_message_too_long", 400);

    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<HandoffRequestRecord>(
        `SELECT * FROM agent_handoff_requests
         WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
         LIMIT 1`,
        [input.organizationId, input.installationId, idempotencyKey],
      );
      if (existing.rows[0]) {
        const conversation = await client.query<ConversationRecord>(
          `SELECT * FROM conversations WHERE organization_id = $1 AND id = $2`,
          [input.organizationId, existing.rows[0].conversation_id],
        );
        if (!conversation.rows[0]) throw new Error("Handoff conversation is missing");
        return { handoff: existing.rows[0], conversation: conversation.rows[0], created: false };
      }

      const installation = await client.query<{
        id: string;
        status: string;
        execution_mode: "system_hosted" | "kasitek_hosted" | "external_connected";
        agent_audience: "personal" | "customer_service";
        agent_definition_id: string;
        agent_version_id: string;
      }>(
        `SELECT ai.id, ai.status, ai.execution_mode, ad.agent_audience,
                ai.agent_definition_id, ai.agent_version_id
         FROM agent_installations ai
         JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
         WHERE ai.id = $2 AND ai.organization_id = $1
         LIMIT 1`,
        [input.organizationId, input.installationId],
      );
      const installationRow = installation.rows[0];
      if (!installationRow) throw handoffError("Installation not found", "installation_not_found", 404);
      if (installationRow.status !== "active") throw handoffError("Installation is not active", "installation_not_active", 409);
      if (installationRow.agent_audience !== "customer_service") {
        throw handoffError("Personal agents cannot request customer handoff", "personal_agent_handoff_not_allowed");
      }
      if (installationRow.agent_definition_id !== input.agentId || installationRow.agent_version_id !== input.agentVersionId) {
        throw handoffError("The handoff context does not match the installation", "handoff_context_mismatch", 409);
      }

      const conversationResult = await client.query<ConversationRecord>(
        `SELECT * FROM conversations
         WHERE organization_id = $1 AND installation_id = $2 AND id = $3 AND status <> 'deleted'
         FOR UPDATE`,
        [input.organizationId, input.installationId, input.conversationId],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) throw handoffError("Conversation not found", "conversation_not_found", 404);
      if (conversation.conversation_kind !== "customer") {
        throw handoffError("Only customer conversations support handoff", "conversation_not_customer", 409);
      }
      if (conversation.handoff_state !== "agent_active") {
        throw handoffError("Conversation already has an active handoff state", "conversation_handoff_active", 409);
      }

      const requestResult = await client.query<HandoffRequestRecord>(
        `INSERT INTO agent_handoff_requests
          (organization_id, installation_id, conversation_id, agent_definition_id,
           agent_version_id, run_id, channel_type, reason, priority, summary,
           customer_message, requested_by, metadata, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
         RETURNING *`,
        [
          input.organizationId,
          input.installationId,
          input.conversationId,
          input.agentId,
          input.agentVersionId,
          input.runId ?? null,
          conversation.channel_type,
          input.reason,
          input.priority,
          summary,
          customerMessage,
          input.actorId ?? `agent:${input.agentId}`,
          JSON.stringify(metadata),
          idempotencyKey,
        ],
      );
      const updatedConversation = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET handoff_state = 'handoff_requested',
             handoff_revision = handoff_revision + 1,
             handoff_requested_at = now(),
             handoff_resolved_at = NULL,
             updated_at = now()
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [input.organizationId, input.conversationId],
      );
      if (!updatedConversation.rows[0]) throw new Error("Conversation handoff update failed");
      return { handoff: requestResult.rows[0]!, conversation: updatedConversation.rows[0], created: true };
    });
  }
}
