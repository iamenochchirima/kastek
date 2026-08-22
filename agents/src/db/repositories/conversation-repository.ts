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
  title_source: "fallback" | "ai" | "manual";
  title_generated_at: string | null;
  title_locked: boolean;
  pinned: boolean;
  last_opened_at: string | null;
  last_read_at: string | null;
  model_provider: string | null;
  model: string | null;
  conversation_kind: "personal" | "customer" | "test" | "external";
  handoff_state: "agent_active" | "handoff_requested" | "human_owned" | "resolved" | "expired" | "cancelled";
  handoff_revision: string | number;
  handoff_requested_at: string | null;
  handoff_resolved_at: string | null;
  assigned_actor_id: string | null;
  last_message_at: string | null;
  last_message_direction: string | null;
  last_message_preview: string | null;
  message_count: number;
  status: string;
  owner_actor_id: string | null;
  is_primary: boolean;
  archived_at: string | null;
  rotated_from_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationProjection extends ConversationRecord {
  participant_type: ParticipantRecord["participant_type"] | null;
  participant_external_id: string | null;
  participant_display_name: string | null;
  unread_count: number;
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
    conversationKind?: ConversationRecord["conversation_kind"];
  }): Promise<ConversationRecord> {
    const result = await query<ConversationRecord>(
      this.pool,
      `INSERT INTO conversations
        (installation_id, organization_id, channel_type, channel_key, external_conversation_id, title, conversation_kind)
       SELECT $2, $1, $3, $4, $5, $6, $7
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
        input.conversationKind ?? "customer",
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
    limit = 100,
    search?: string,
  ): Promise<ConversationRecord[]> {
    const result = await query<ConversationRecord>(
      this.pool,
      `SELECT * FROM conversations
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
         AND status <> 'deleted'
         AND ($5::text IS NULL OR title ILIKE '%' || $5 || '%')
       ORDER BY pinned DESC, updated_at DESC
       LIMIT $4`,
      [organizationId, installationId, ownerActorId, Math.max(1, Math.min(limit, 200)), search?.trim() || null],
    );
    return result.rows;
  }

  /**
   * Lists the installation-owned conversation projection. Personal/test
   * conversations may be restricted to an actor; customer conversations are
   * installation-scoped and intentionally do not require an owner actor.
   */
  public async listInstallationConversationProjections(
    organizationId: string,
    installationId: string,
    input: {
      kind?: ConversationRecord["conversation_kind"];
      ownerActorId?: string;
      status?: "active" | "archived" | "deleted";
      channelType?: string;
      search?: string;
      limit?: number;
    } = {},
  ): Promise<ConversationProjection[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const result = await query<ConversationProjection>(
      this.pool,
      `SELECT c.*,
              participant.participant_type,
              participant.external_id AS participant_external_id,
              participant.display_name AS participant_display_name,
              COALESCE(unread.unread_count, 0)::integer AS unread_count
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT p.participant_type, p.external_id, p.display_name
         FROM participants p
         WHERE p.conversation_id = c.id
           AND p.organization_id = c.organization_id
           AND p.participant_type IN ('customer', 'user')
         ORDER BY CASE WHEN p.participant_type = 'customer' THEN 0 ELSE 1 END, p.created_at
         LIMIT 1
       ) participant ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS unread_count
         FROM messages m
         WHERE m.conversation_id = c.id
           AND m.organization_id = c.organization_id
           AND m.direction = 'inbound'
           AND m.occurred_at > COALESCE(c.last_read_at, 'epoch'::timestamptz)
       ) unread ON true
       WHERE c.organization_id = $1
         AND c.installation_id = $2
         AND ($3::text IS NULL OR c.conversation_kind = $3)
         AND ($4::text IS NULL OR c.owner_actor_id = $4)
         AND ($5::text IS NULL OR c.status = $5)
         AND ($6::text IS NULL OR c.channel_type = $6)
         AND ($7::text IS NULL OR c.title ILIKE '%' || $7 || '%'
              OR participant.display_name ILIKE '%' || $7 || '%'
              OR participant.external_id ILIKE '%' || $7 || '%'
              OR c.last_message_preview ILIKE '%' || $7 || '%')
       ORDER BY c.pinned DESC, COALESCE(c.last_message_at, c.updated_at) DESC, c.id DESC
       LIMIT $8`,
      [
        organizationId,
        installationId,
        input.kind ?? null,
        input.ownerActorId ?? null,
        input.status ?? "active",
        input.channelType ?? null,
        input.search?.trim() || null,
        limit,
      ],
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

  public async restoreOwnedConversation(organizationId: string, conversationId: string, ownerActorId: string): Promise<ConversationRecord> {
    const result = await query<ConversationRecord>(
      this.pool,
      `UPDATE conversations
       SET status = 'active', archived_at = NULL, is_primary = false, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3 AND status = 'archived'
       RETURNING *`,
      [organizationId, conversationId, ownerActorId],
    );
    if (!result.rows[0]) throw new Error("Archived conversation not found");
    return result.rows[0];
  }

  public async updateOwnedConversation(input: {
    organizationId: string;
    conversationId: string;
    ownerActorId: string;
    title?: string;
    pinned?: boolean;
    modelProvider?: string | null;
    model?: string | null;
    clearModel?: boolean;
  }): Promise<ConversationRecord> {
    const result = await query<ConversationRecord>(
      this.pool,
      `UPDATE conversations
       SET title = CASE WHEN $4::text IS NULL THEN title ELSE $4 END,
           title_source = CASE WHEN $4::text IS NULL THEN title_source ELSE 'manual' END,
           title_locked = CASE WHEN $4::text IS NULL THEN title_locked ELSE true END,
           pinned = COALESCE($5, pinned),
           model_provider = CASE WHEN $8 THEN NULL WHEN $6::text IS NULL THEN model_provider ELSE $6 END,
           model = CASE WHEN $8 THEN NULL WHEN $7::text IS NULL THEN model ELSE $7 END,
           updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3 AND status = 'active'
       RETURNING *`,
      [input.organizationId, input.conversationId, input.ownerActorId, input.title ?? null, input.pinned ?? null, input.modelProvider ?? null, input.model ?? null, input.clearModel ?? false],
    );
    if (!result.rows[0]) throw new Error("Conversation not found");
    return result.rows[0];
  }

  public async setChannelDefault(organizationId: string, installationId: string, ownerActorId: string, conversationId: string): Promise<ConversationRecord> {
    return withTransaction(this.pool, async (client) => {
      const target = await client.query<ConversationRecord>(
        `SELECT * FROM conversations
         WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
           AND id = $4 AND status = 'active'
         FOR UPDATE`,
        [organizationId, installationId, ownerActorId, conversationId],
      );
      if (!target.rows[0]) throw new Error("Conversation not found");
      await client.query(
        `UPDATE conversations SET is_primary = false, updated_at = now()
         WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
           AND is_primary = true AND id <> $4`,
        [organizationId, installationId, ownerActorId, conversationId],
      );
      const updated = await client.query<ConversationRecord>(
        `UPDATE conversations SET is_primary = true, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [conversationId],
      );
      return updated.rows[0]!;
    });
  }

  public async markOpened(organizationId: string, conversationId: string, ownerActorId: string): Promise<void> {
    await query(
      this.pool,
      `UPDATE conversations SET last_opened_at = now(), last_read_at = now()
       WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3`,
      [organizationId, conversationId, ownerActorId],
    );
  }

  /**
   * Marks an installation-owned transcript as read by the current operator.
   * Customer conversations are installation-scoped rather than owned by the
   * actor who happens to open them, so they use this separate projection
   * update instead of the personal-chat owner guard above.
   */
  public async markInstallationOpened(organizationId: string, conversationId: string): Promise<void> {
    await query(
      this.pool,
      `UPDATE conversations SET last_opened_at = now(), last_read_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'active'
         AND conversation_kind IN ('customer', 'test')`,
      [organizationId, conversationId],
    );
  }

  public async setGeneratedTitle(input: {
    organizationId: string;
    conversationId: string;
    title: string;
  }): Promise<ConversationRecord | null> {
    const result = await query<ConversationRecord>(
      this.pool,
      `UPDATE conversations
       SET title = $3, title_source = 'ai', title_generated_at = now(), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'active'
         AND title_locked = false AND title_source = 'fallback'
       RETURNING *`,
      [input.organizationId, input.conversationId, input.title],
    );
    return result.rows[0] ?? null;
  }

  public async getTitleCandidate(organizationId: string, conversationId: string): Promise<{ title: string; title_source: string; title_locked: boolean; first_message: string | null } | null> {
    const result = await query<{
      title: string;
      title_source: string;
      title_locked: boolean;
      first_message: string | null;
    }>(
      this.pool,
      `SELECT c.title, c.title_source, c.title_locked,
              (SELECT m.content->>'text' FROM messages m
               WHERE m.conversation_id = c.id AND m.direction = 'inbound'
               ORDER BY m.sequence_number ASC LIMIT 1) AS first_message
       FROM conversations c
       WHERE c.organization_id = $1 AND c.id = $2 AND c.status = 'active'`,
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
      await client.query(
        `UPDATE conversations
         SET updated_at = now(),
             last_message_at = COALESCE($2::timestamptz, now()),
             last_message_direction = $3,
             last_message_preview = LEFT(COALESCE($4, $5), 500),
             message_count = message_count + 1
         WHERE id = $1`,
        [input.conversationId, input.occurredAt ?? null, input.direction, typeof input.content.text === "string" ? input.content.text : null, input.messageType ?? "text"],
      );
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
