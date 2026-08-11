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
  sequence_number: string;
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

  public async appendMessage(input: {
    organizationId: string;
    conversationId: string;
    participantId?: string;
    direction: "inbound" | "outbound" | "system";
    messageType?: string;
    content: Record<string, unknown>;
    provider?: string;
    providerMessageId?: string;
  }): Promise<MessageRecord> {
    return withTransaction(this.pool, async (client) => {
      const conversation = await client.query<ConversationRecord>(
        "SELECT * FROM conversations WHERE organization_id = $1 AND id = $2 FOR UPDATE",
        [input.organizationId, input.conversationId],
      );
      if (!conversation.rows[0] || conversation.rows[0].status !== "active") {
        throw new Error("Active conversation not found");
      }
      if (input.provider && input.providerMessageId) {
        const existing = await client.query<MessageRecord>(
          "SELECT * FROM messages WHERE provider = $1 AND provider_message_id = $2",
          [input.provider, input.providerMessageId],
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
           provider, provider_message_id, sequence_number)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
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
}
