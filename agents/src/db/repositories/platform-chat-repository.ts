import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { withTransaction } from "../pool";
import type { ConversationRecord, MessageRecord, ParticipantRecord } from "./conversation-repository";
import type { RunRecord } from "./run-repository";

export interface PlatformConversation {
  conversation: ConversationRecord;
  userParticipant: ParticipantRecord;
  agentParticipant: ParticipantRecord;
}

export interface AcceptedPlatformMessage extends PlatformConversation {
  message: MessageRecord;
  run: RunRecord;
  created: boolean;
}

export interface AcceptedExternalMessage extends AcceptedPlatformMessage {
  sourceParticipant: ParticipantRecord;
}

interface ActiveInstallation {
  agent_definition_id: string;
  agent_version_id: string;
  agent_name: string;
}

function fallbackConversationTitle(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  const words = normalized.split(" ").slice(0, 7).join(" ");
  return words.length > 72 ? `${words.slice(0, 69).trimEnd()}…` : words;
}

export class PlatformChatRepository {
  public constructor(private readonly pool: Pool) {}

  public async resolveConversation(input: {
    organizationId: string;
    installationId: string;
    actorId: string;
    conversationKey?: string;
  }): Promise<PlatformConversation> {
    return withTransaction(this.pool, (client) => this.resolveConversationInTransaction(client, input));
  }

  public async createNewConversation(input: {
    organizationId: string;
    installationId: string;
    actorId: string;
    title?: string;
    modelProvider?: string;
    model?: string;
  }): Promise<PlatformConversation> {
    return withTransaction(this.pool, (client) => this.createNewConversationInTransaction(client, input));
  }

  public async acceptMessage(input: {
    organizationId: string;
    installationId: string;
    actorId: string;
    correlationId?: string;
    idempotencyKey: string;
    message: string;
    context?: Record<string, unknown>;
    conversationId?: string;
    createNew?: boolean;
    modelProvider?: string;
    model?: string;
  }): Promise<AcceptedPlatformMessage> {
    return withTransaction(this.pool, async (client) => {
      const resolved = input.conversationId
        ? await this.resolveOwnedConversationInTransaction(client, input)
        : input.createNew
          ? await this.createNewConversationInTransaction(client, {
            organizationId: input.organizationId,
            installationId: input.installationId,
            actorId: input.actorId,
            title: fallbackConversationTitle(input.message),
            modelProvider: input.modelProvider,
            model: input.model,
          })
          : await this.resolveConversationInTransaction(client, input);
      const existing = await client.query<RunRecord>(
        `SELECT * FROM agent_runs
         WHERE organization_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [input.organizationId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const run = existing.rows[0];
        if (run.installation_id !== input.installationId || run.conversation_id !== resolved.conversation.id) {
          throw new Error("Idempotency key already belongs to another request");
        }
        const message = await client.query<MessageRecord>(
          `SELECT * FROM messages WHERE run_id = $1 AND direction = 'inbound' LIMIT 1`,
          [run.id],
        );
        if (!message.rows[0]) throw new Error("Idempotent platform message is incomplete");
        return { ...resolved, message: message.rows[0], run, created: false };
      }

      const openRun = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
         WHERE conversation_id = $1
           AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
         ORDER BY created_at LIMIT 1`,
        [resolved.conversation.id],
      );
      if (openRun.rows[0]) {
        throw Object.assign(new Error("KasiAi is still finishing the previous message"), {
          statusCode: 409,
          code: "conversation_busy",
        });
      }

      const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
      const createdRun = await client.query<RunRecord>(
        `INSERT INTO agent_runs
          (organization_id, agent_definition_id, agent_version_id, installation_id,
           conversation_id, trigger_type, status, input, correlation_id, created_by, idempotency_key,
           reply_channel_type, resolved_model_provider, resolved_model)
         VALUES ($1, $2, $3, $4, $5, 'message', 'received', $6::jsonb, COALESCE($7::uuid, gen_random_uuid()), $8, $9, 'platform', $10, $11)
         ON CONFLICT (organization_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [
          input.organizationId,
          installation.agent_definition_id,
          installation.agent_version_id,
          input.installationId,
          resolved.conversation.id,
          JSON.stringify({ message: input.message, context: input.context ?? {} }),
          input.correlationId ?? null,
          input.actorId,
          input.idempotencyKey,
          resolved.conversation.model_provider,
          resolved.conversation.model,
        ],
      );
      if (!createdRun.rows[0]) {
        const raced = await client.query<RunRecord>(
          `SELECT * FROM agent_runs WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [input.organizationId, input.idempotencyKey],
        );
        const run = raced.rows[0];
        if (!run || run.installation_id !== input.installationId || run.conversation_id !== resolved.conversation.id) {
          throw new Error("Idempotency key already belongs to another request");
        }
        const message = await client.query<MessageRecord>(
          `SELECT * FROM messages WHERE run_id = $1 AND direction = 'inbound' LIMIT 1`,
          [run.id],
        );
        if (!message.rows[0]) throw new Error("Idempotent platform message is incomplete");
        return { ...resolved, message: message.rows[0], run, created: false };
      }
      const run = createdRun.rows[0];
      const nextSequence = await this.nextSequence(client, resolved.conversation.id);
      const createdMessage = await client.query<MessageRecord>(
        `INSERT INTO messages
          (conversation_id, organization_id, participant_id, direction, message_type, content,
           provider, provider_message_id, sequence_number, run_id, source_channel, occurred_at,
           delivery_status)
         VALUES ($1, $2, $3, 'inbound', 'text', $4::jsonb, 'platform', $5, $6, $7,
                 'platform', now(), 'local')
         RETURNING *`,
        [
          resolved.conversation.id,
          input.organizationId,
          resolved.userParticipant.id,
          JSON.stringify({ text: input.message }),
          `${input.organizationId}:${input.idempotencyKey}`,
          nextSequence,
          run.id,
        ],
      );
      await client.query(
        `INSERT INTO run_attempts (run_id, organization_id, attempt_number, status, trigger)
         VALUES ($1, $2, 1, 'started', 'workflow')`,
        [run.id, input.organizationId],
      );
      await client.query(
        `INSERT INTO run_workflow_state (run_id, organization_id, state, revision)
         VALUES ($1, $2, '{}'::jsonb, 0)`,
        [run.id, input.organizationId],
      );
      await client.query(
        `INSERT INTO agent_events
          (organization_id, run_id, installation_id, event_type, payload, actor_id, correlation_id)
         VALUES ($1, $2, $3, 'run.received', $4::jsonb, $5, $6)`,
        [input.organizationId, run.id, input.installationId, JSON.stringify({ triggerType: "message" }), input.actorId, run.correlation_id],
      );
      await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [resolved.conversation.id]);
      return { ...resolved, message: createdMessage.rows[0]!, run, created: true };
    });
  }

  public async acceptExternalMessage(input: {
    organizationId: string;
    installationId?: string;
    channelType: string;
    provider: string;
    providerEventId: string;
    providerMessageId: string;
    externalIdentity: string;
    externalConversationId: string;
    messageType: string;
    content: Record<string, unknown>;
    occurredAt?: string;
    displayName?: string;
    correlationId?: string;
  }): Promise<AcceptedExternalMessage> {
    return withTransaction(this.pool, async (client) => {
      const binding = await client.query<{
        id: string;
        owner_actor_id: string | null;
        channel_connection_id: string;
        installation_id: string;
      }>(
        `SELECT cb.id, cb.owner_actor_id, cb.channel_connection_id, cb.installation_id
         FROM channel_bindings cb
         JOIN channel_connections cc ON cc.id = cb.channel_connection_id
         WHERE cb.organization_id = $1
           AND ($2::uuid IS NULL OR cb.installation_id = $2)
           AND cb.channel_type = $3 AND cb.external_identity = $4
           AND cb.status = 'active' AND cc.status = 'active'
         LIMIT 1`,
        [input.organizationId, input.installationId ?? null, input.channelType, input.externalIdentity],
      );
      const route = binding.rows[0];
      if (!route?.owner_actor_id) {
        throw Object.assign(new Error("External channel identity is not paired to a KasiTek user"), {
          statusCode: 403,
          code: "channel_identity_not_paired",
        });
      }

      const resolved = await this.resolveConversationInTransaction(client, {
        organizationId: input.organizationId,
        installationId: route.installation_id,
        actorId: route.owner_actor_id,
      });
      const sourceParticipant = await this.upsertParticipant(client, {
        conversationId: resolved.conversation.id,
        organizationId: input.organizationId,
        participantType: "user",
        externalId: `${input.channelType}:${input.externalIdentity}`,
        displayName: input.displayName,
      });

      const duplicate = await client.query<MessageRecord>(
        `SELECT * FROM messages
         WHERE organization_id = $1 AND provider = $2 AND provider_message_id = $3
         LIMIT 1`,
        [input.organizationId, input.provider, input.providerMessageId],
      );
      if (duplicate.rows[0]) {
        const existingRun = await client.query<RunRecord>("SELECT * FROM agent_runs WHERE id = $1", [duplicate.rows[0].run_id]);
        if (!existingRun.rows[0]) throw new Error("Idempotent external message is incomplete");
        return { ...resolved, sourceParticipant, message: duplicate.rows[0], run: existingRun.rows[0], created: false };
      }

      const openRun = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
         WHERE conversation_id = $1
           AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
         ORDER BY created_at LIMIT 1`,
        [resolved.conversation.id],
      );
      if (openRun.rows[0]) {
        throw Object.assign(new Error("KasiAi is still finishing the previous message"), {
          statusCode: 409,
          code: "conversation_busy",
        });
      }

      const installation = await this.getActiveInstallation(client, input.organizationId, route.installation_id);
      const idempotencyKey = `channel:${input.provider}:${input.providerEventId}`;
      const runResult = await client.query<RunRecord>(
        `INSERT INTO agent_runs
          (organization_id, agent_definition_id, agent_version_id, installation_id,
           conversation_id, trigger_type, status, input, correlation_id, created_by,
           idempotency_key, reply_channel_type, reply_binding_id, resolved_model_provider, resolved_model)
         VALUES ($1, $2, $3, $4, $5, 'message', 'received', $6::jsonb,
                 COALESCE($7::uuid, gen_random_uuid()), $8, $9, $10, $11, $12, $13)
         ON CONFLICT (organization_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [
          input.organizationId,
          installation.agent_definition_id,
          installation.agent_version_id,
          route.installation_id,
          resolved.conversation.id,
          JSON.stringify({ message: input.content.text ?? input.content, context: { sourceChannel: input.channelType } }),
          input.correlationId ?? null,
          route.owner_actor_id,
          idempotencyKey,
          input.channelType,
          route.id,
          resolved.conversation.model_provider,
          resolved.conversation.model,
        ],
      );
      const run = runResult.rows[0];
      if (!run) throw new Error("External message run could not be created");
      const nextSequence = await this.nextSequence(client, resolved.conversation.id);
      const messageResult = await client.query<MessageRecord>(
        `INSERT INTO messages
          (conversation_id, organization_id, participant_id, direction, message_type, content,
           provider, provider_message_id, sequence_number, run_id, source_channel,
           source_connection_id, source_binding_id, external_conversation_id, occurred_at,
           delivery_status)
         VALUES ($1, $2, $3, 'inbound', $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13,
                 COALESCE($14::timestamptz, now()), 'delivered')
         RETURNING *`,
        [
          resolved.conversation.id,
          input.organizationId,
          sourceParticipant.id,
          input.messageType,
          JSON.stringify(input.content),
          input.provider,
          input.providerMessageId,
          nextSequence,
          run.id,
          input.channelType,
          route.channel_connection_id,
          route.id,
          input.externalConversationId,
          input.occurredAt ?? null,
        ],
      );
      await client.query(
        `INSERT INTO run_attempts (run_id, organization_id, attempt_number, status, trigger)
         VALUES ($1, $2, 1, 'started', 'workflow')`,
        [run.id, input.organizationId],
      );
      await client.query(
        `INSERT INTO run_workflow_state (run_id, organization_id, state, revision)
         VALUES ($1, $2, '{}'::jsonb, 0)`,
        [run.id, input.organizationId],
      );
      await client.query(
        `INSERT INTO agent_events
          (organization_id, run_id, installation_id, event_type, payload, actor_id, correlation_id)
         VALUES ($1, $2, $3, 'run.received', $4::jsonb, $5, $6)`,
        [
          input.organizationId,
          run.id,
          route.installation_id,
          JSON.stringify({ triggerType: "message", sourceChannel: input.channelType }),
          route.owner_actor_id,
          run.correlation_id,
        ],
      );
      await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [resolved.conversation.id]);
      return { ...resolved, sourceParticipant, message: messageResult.rows[0]!, run, created: true };
    });
  }

  private async resolveConversationInTransaction(
    client: PoolClient,
    input: { organizationId: string; installationId: string; actorId: string; conversationKey?: string },
  ): Promise<PlatformConversation> {
    const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
    await client.query("SELECT id FROM agent_installations WHERE id = $1 FOR UPDATE", [input.installationId]);
    const existing = await client.query<ConversationRecord>(
      `SELECT * FROM conversations
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
         AND is_primary = true AND status = 'active'
       LIMIT 1`,
      [input.organizationId, input.installationId, input.actorId],
    );
    let conversation = existing.rows[0];
    if (!conversation) {
      // A restored/legacy conversation can be active without currently being
      // the channel default. Prefer it over creating a second durable thread.
      const reusable = await client.query<ConversationRecord>(
        `SELECT * FROM conversations
         WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
           AND status = 'active'
         ORDER BY pinned DESC, updated_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.organizationId, input.installationId, input.actorId],
      );
      if (reusable.rows[0]) {
        const promoted = await client.query<ConversationRecord>(
          `UPDATE conversations SET is_primary = true, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [reusable.rows[0].id],
        );
        conversation = promoted.rows[0]!;
      } else {
        conversation = await this.insertPrimaryConversation(client, {
          organizationId: input.organizationId,
          installationId: input.installationId,
          actorId: input.actorId,
          externalConversationId: input.conversationKey
            ? `kasiai:user:${input.actorId}:${input.conversationKey}`
            : `kasiai:user:${input.actorId}:${randomUUID()}`,
          title: installation.agent_name,
        });
      }
    }
    if (conversation.status !== "active") throw new Error("Platform conversation is not active");
    return this.ensureParticipants(client, conversation, installation, input.organizationId, input.actorId);
  }

  private async resolveOwnedConversationInTransaction(
    client: PoolClient,
    input: { organizationId: string; installationId: string; actorId: string; conversationId?: string },
  ): Promise<PlatformConversation> {
    const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
    const existing = await client.query<ConversationRecord>(
      `SELECT * FROM conversations
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
         AND id = $4 AND status = 'active'
       FOR UPDATE`,
      [input.organizationId, input.installationId, input.actorId, input.conversationId],
    );
    if (!existing.rows[0]) throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
    return this.ensureParticipants(client, existing.rows[0], installation, input.organizationId, input.actorId);
  }

  private async createNewConversationInTransaction(
    client: PoolClient,
    input: {
      organizationId: string;
      installationId: string;
      actorId: string;
      title?: string;
      modelProvider?: string;
      model?: string;
    },
  ): Promise<PlatformConversation> {
    const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
    await client.query("SELECT id FROM agent_installations WHERE id = $1 FOR UPDATE", [input.installationId]);
    await client.query(
      `UPDATE conversations SET is_primary = false, updated_at = now()
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
         AND is_primary = true AND status = 'active'`,
      [input.organizationId, input.installationId, input.actorId],
    );
    const conversation = await this.insertPrimaryConversation(client, {
      organizationId: input.organizationId,
      installationId: input.installationId,
      actorId: input.actorId,
      externalConversationId: `kasiai:user:${input.actorId}:${randomUUID()}`,
      title: input.title ?? "New chat",
      modelProvider: input.modelProvider,
      model: input.model,
    });
    return this.ensureParticipants(client, conversation, installation, input.organizationId, input.actorId);
  }

  private async insertPrimaryConversation(
    client: PoolClient,
    input: {
      organizationId: string;
      installationId: string;
      actorId: string;
      externalConversationId: string;
      title: string;
      modelProvider?: string;
      model?: string;
    },
  ): Promise<ConversationRecord> {
    const created = await client.query<ConversationRecord>(
      `INSERT INTO conversations
        (installation_id, organization_id, channel_type, channel_key, external_conversation_id,
         title, owner_actor_id, is_primary, model_provider, model, title_source, last_opened_at)
       VALUES ($1, $2, 'unified', 'kasiai', $3, $4, $5, true, $6, $7, 'fallback', now())
       ON CONFLICT (installation_id, owner_actor_id)
       WHERE is_primary = true AND status = 'active' AND owner_actor_id IS NOT NULL
       DO UPDATE SET updated_at = now()
       RETURNING *`,
      [input.installationId, input.organizationId, input.externalConversationId, input.title, input.actorId, input.modelProvider ?? null, input.model ?? null],
    );
    return created.rows[0]!;
  }

  private async ensureParticipants(
    client: PoolClient,
    conversation: ConversationRecord,
    installation: ActiveInstallation,
    organizationId: string,
    actorId: string,
  ): Promise<PlatformConversation> {
    const userParticipant = await this.upsertParticipant(client, {
      conversationId: conversation.id,
      organizationId,
      participantType: "user",
      externalId: actorId,
    });
    const agentParticipant = await this.upsertParticipant(client, {
      conversationId: conversation.id,
      organizationId,
      participantType: "agent",
      externalId: installation.agent_definition_id,
      displayName: installation.agent_name,
    });
    return { conversation, userParticipant, agentParticipant };
  }

  private async getActiveInstallation(
    client: PoolClient,
    organizationId: string,
    installationId: string,
  ): Promise<ActiveInstallation> {
    const installation = await client.query<ActiveInstallation>(
      `SELECT ai.agent_definition_id, ai.agent_version_id, ad.name AS agent_name
       FROM agent_installations ai
       JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
       WHERE ai.id = $1 AND ai.organization_id = $2 AND ai.status = 'active'`,
      [installationId, organizationId],
    );
    if (!installation.rows[0]) throw new Error("Active installation not found");
    return installation.rows[0];
  }

  private async upsertParticipant(
    client: PoolClient,
    input: {
      conversationId: string;
      organizationId: string;
      participantType: ParticipantRecord["participant_type"];
      externalId: string;
      displayName?: string;
    },
  ): Promise<ParticipantRecord> {
    const participant = await client.query<ParticipantRecord>(
      `INSERT INTO participants
        (conversation_id, organization_id, participant_type, external_id, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id, participant_type, external_id)
       DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, participants.display_name)
       RETURNING *`,
      [input.conversationId, input.organizationId, input.participantType, input.externalId, input.displayName ?? null],
    );
    return participant.rows[0]!;
  }

  private async nextSequence(client: PoolClient, conversationId: string): Promise<string> {
    await client.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
    const sequence = await client.query<{ sequence_number: string }>(
      "SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number FROM messages WHERE conversation_id = $1",
      [conversationId],
    );
    return sequence.rows[0]!.sequence_number;
  }
}
