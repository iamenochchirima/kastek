import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export interface ConversationRecord {
  id: string;
  installation_id: string;
  organization_id: string;
  channel_type: string;
  channel_key: string;
  external_conversation_id: string | null;
  title: string | null;
  status: string;
  owner_actor_id: string | null;
  is_primary: boolean;
  archived_at: string | null;
  rotated_from_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  organization_id: string;
  participant_id: string | null;
  direction: string;
  message_type: string;
  content: Record<string, unknown>;
  provider: string | null;
  provider_message_id: string | null;
  run_id: string | null;
  source_channel: string;
  source_connection_id: string | null;
  source_binding_id: string | null;
  external_conversation_id: string | null;
  occurred_at: string;
  delivery_status: string | null;
  sequence_number: string;
  created_at: string;
}

export interface ParticipantRecord {
  id: string;
  conversation_id: string;
  organization_id: string;
  participant_type: "user" | "customer" | "staff" | "agent" | "system";
  external_id: string | null;
  display_name: string | null;
  created_at: string;
}

export class ConversationRepository {
  public constructor(private readonly pool: Pool) {}

  public async createConversation(input: {
    organizationId: string;
    installationId: string;
    channelType?: string;
    channelKey?: string;
    externalConversationId?: string;
    title?: string;
  }): Promise<ConversationRecord> {
    const result = await query<ConversationRecord>(
      this.pool,
      `INSERT INTO conversations
        (installation_id, organization_id, channel_type, channel_key, external_conversation_id, title)
       SELECT $2, $1, $3, $4, $5, $6
       WHERE EXISTS (
         SELECT 1 FROM agent_installations WHERE id = $2 AND organization_id = $1 AND status = 'active'
       )
       ON CONFLICT (installation_id, channel_type, channel_key, external_conversation_id)
       WHERE external_conversation_id IS NOT NULL
       DO UPDATE SET updated_at = conversations.updated_at
       RETURNING *`,
      [
        input.organizationId,
        input.installationId,
        input.channelType ?? "platform",
        input.channelKey ?? "platform",
        input.externalConversationId ?? null,
        input.title ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error("Active installation not found");
    return result.rows[0];
  }

  public async getConversation(organizationId: string, conversationId: string): Promise<ConversationRecord | null> {
    const result = await query<ConversationRecord>(
      this.pool,
      "SELECT * FROM conversations WHERE organization_id = $1 AND id = $2",
      [organizationId, conversationId],
    );
    return result.rows[0] ?? null;
  }

  public async getOwnedConversation(organizationId: string, conversationId: string, ownerActorId: string): Promise<ConversationRecord | null> {
    const result = await query<ConversationRecord>(
      this.pool,
      `SELECT * FROM conversations
       WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3`,
      [organizationId, conversationId, ownerActorId],
    );
    return result.rows[0] ?? null;
  }

  public async listOwnerConversations(
    organizationId: string,
    installationId: string,
    ownerActorId: string,
    limit = 50,
  ): Promise<ConversationRecord[]> {
    const result = await query<ConversationRecord>(
      this.pool,
      `SELECT * FROM conversations
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
         AND status <> 'deleted'
       ORDER BY is_primary DESC, updated_at DESC
       LIMIT $4`,
      [organizationId, installationId, ownerActorId, Math.max(1, Math.min(limit, 100))],
    );
    return result.rows;
  }

  public async setOwnedStatus(
    organizationId: string,
    conversationId: string,
    ownerActorId: string,
    status: "archived" | "deleted",
  ): Promise<ConversationRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET status = $4, is_primary = false,
             archived_at = CASE WHEN $4 = 'archived' THEN COALESCE(archived_at, now()) ELSE archived_at END,
             updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3
           AND status <> 'deleted'
         RETURNING *`,
        [organizationId, conversationId, ownerActorId, status],
      );
      if (!result.rows[0]) throw new Error("Conversation not found");
      if (status === "deleted") {
        await client.query(
          `UPDATE memory_records
           SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()), updated_at = now()
           WHERE organization_id = $1 AND conversation_id = $2 AND status <> 'deleted'`,
          [organizationId, conversationId],
        );
        await client.query(
          "DELETE FROM conversation_summaries WHERE organization_id = $1 AND conversation_id = $2",
          [organizationId, conversationId],
        );
      }
      return result.rows[0];
    });
  }

  public async appendMessage(input: {
    organizationId: string;
    conversationId: string;
    participantId?: string;
    direction: "inbound" | "outbound" | "system";
    messageType?: string;
    content: Record<string, unknown>;
    provider?: string;
    providerMessageId?: string;
    sourceChannel?: string;
    sourceConnectionId?: string;
    sourceBindingId?: string;
    externalConversationId?: string;
    occurredAt?: string;
    deliveryStatus?: string;
  }): Promise<MessageRecord> {
    return withTransaction(this.pool, async (client) => {
      const conversation = await client.query<ConversationRecord>(
        "SELECT * FROM conversations WHERE organization_id = $1 AND id = $2 FOR UPDATE",
        [input.organizationId, input.conversationId],
      );
      if (!conversation.rows[0] || conversation.rows[0].status !== "active") {
        throw new Error("Active conversation not found");
      }
      if (input.participantId) {
        const participant = await client.query("SELECT id FROM participants WHERE id = $1 AND conversation_id = $2 AND organization_id = $3", [input.participantId, input.conversationId, input.organizationId]);
        if (!participant.rows[0]) throw new Error("Participant does not belong to conversation");
      }
      if (input.provider && input.providerMessageId) {
        const existing = await client.query<MessageRecord>(
          `SELECT * FROM messages
           WHERE organization_id = $1 AND provider = $2 AND provider_message_id = $3`,
          [input.organizationId, input.provider, input.providerMessageId],
        );
        if (existing.rows[0]) return existing.rows[0];
      }
      const nextSequence = await client.query<{ sequence_number: string }>(
        "SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number FROM messages WHERE conversation_id = $1",
        [input.conversationId],
      );
      const created = await client.query<MessageRecord>(
        `INSERT INTO messages
          (conversation_id, organization_id, participant_id, direction, message_type, content,
           provider, provider_message_id, sequence_number, source_channel, source_connection_id,
           source_binding_id, external_conversation_id, occurred_at, delivery_status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13,
                 COALESCE($14::timestamptz, now()), $15)
         RETURNING *`,
        [
          input.conversationId,
          input.organizationId,
          input.participantId ?? null,
          input.direction,
          input.messageType ?? "text",
          JSON.stringify(input.content),
          input.provider ?? null,
          input.providerMessageId ?? null,
          nextSequence.rows[0]!.sequence_number,
          input.sourceChannel ?? input.provider ?? "platform",
          input.sourceConnectionId ?? null,
          input.sourceBindingId ?? null,
          input.externalConversationId ?? null,
          input.occurredAt ?? null,
          input.deliveryStatus ?? (input.sourceChannel === "platform" || !input.sourceChannel ? "local" : null),
        ],
      );
      await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [input.conversationId]);
      return created.rows[0]!;
    });
  }

  public async listMessages(organizationId: string, conversationId: string): Promise<MessageRecord[]> {
    const result = await query<MessageRecord>(
      this.pool,
      "SELECT * FROM messages WHERE organization_id = $1 AND conversation_id = $2 ORDER BY sequence_number",
      [organizationId, conversationId],
    );
    return result.rows;
  }

  public async listMessagesPage(
    organizationId: string,
    conversationId: string,
    input: { limit?: number; beforeSequence?: string } = {},
  ): Promise<{ messages: MessageRecord[]; hasMore: boolean; nextBefore: string | null }> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const result = await query<MessageRecord>(
      this.pool,
      input.beforeSequence
        ? `SELECT * FROM messages
           WHERE organization_id = $1 AND conversation_id = $2 AND sequence_number < $3
           ORDER BY sequence_number DESC LIMIT $4`
        : `SELECT * FROM messages
           WHERE organization_id = $1 AND conversation_id = $2
           ORDER BY sequence_number DESC LIMIT $3`,
      input.beforeSequence
        ? [organizationId, conversationId, input.beforeSequence, limit + 1]
        : [organizationId, conversationId, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const messages = result.rows.slice(0, limit).reverse();
    return { messages, hasMore, nextBefore: hasMore ? messages[0]?.sequence_number ?? null : null };
  }

  public async createParticipant(input: {
    organizationId: string;
    conversationId: string;
    participantType: ParticipantRecord["participant_type"];
    externalId?: string;
    displayName?: string;
  }): Promise<ParticipantRecord> {
    const result = await query<ParticipantRecord>(
      this.pool,
      `INSERT INTO participants
        (conversation_id, organization_id, participant_type, external_id, display_name)
       SELECT $1, $2, $3, $4, $5
       WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND organization_id = $2)
       ON CONFLICT (conversation_id, participant_type, external_id) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, participants.display_name)
       RETURNING *`,
      [input.conversationId, input.organizationId, input.participantType, input.externalId ?? null, input.displayName ?? null],
    );
    if (!result.rows[0]) throw new Error("Conversation not found");
    return result.rows[0];
  }

  public async listParticipants(organizationId: string, conversationId: string): Promise<ParticipantRecord[]> {
    const result = await query<ParticipantRecord>(
      this.pool,
      `SELECT * FROM participants WHERE organization_id = $1 AND conversation_id = $2 ORDER BY created_at`,
      [organizationId, conversationId],
    );
    return result.rows;
  }
}
