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

interface ActiveInstallation {
  agent_definition_id: string;
  agent_version_id: string;
  agent_name: string;
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
  }): Promise<PlatformConversation> {
    return this.resolveConversation({ ...input, conversationKey: randomUUID() });
  }

  public async acceptMessage(input: {
    organizationId: string;
    installationId: string;
    actorId: string;
    idempotencyKey: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<AcceptedPlatformMessage> {
    return withTransaction(this.pool, async (client) => {
      const resolved = await this.resolveConversationInTransaction(client, input);
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

      const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
      const createdRun = await client.query<RunRecord>(
        `INSERT INTO agent_runs
          (organization_id, agent_definition_id, agent_version_id, installation_id,
           conversation_id, trigger_type, status, input, correlation_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'message', 'received', $6::jsonb, gen_random_uuid(), $7, $8)
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
          input.actorId,
          input.idempotencyKey,
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
           provider, provider_message_id, sequence_number, run_id)
         VALUES ($1, $2, $3, 'inbound', 'text', $4::jsonb, 'platform', $5, $6, $7)
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
          (organization_id, run_id, installation_id, event_type, payload, actor_id)
         VALUES ($1, $2, $3, 'run.received', $4::jsonb, $5)`,
        [input.organizationId, run.id, input.installationId, JSON.stringify({ triggerType: "message" }), input.actorId],
      );
      await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [resolved.conversation.id]);
      return { ...resolved, message: createdMessage.rows[0]!, run, created: true };
    });
  }

  private async resolveConversationInTransaction(
    client: PoolClient,
    input: { organizationId: string; installationId: string; actorId: string; conversationKey?: string },
  ): Promise<PlatformConversation> {
    const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
    const externalConversationId = input.conversationKey
      ? `platform:user:${input.actorId}:${input.conversationKey}`
      : `platform:user:${input.actorId}`;
    const created = await client.query<ConversationRecord>(
      `INSERT INTO conversations
        (installation_id, organization_id, channel_type, channel_key, external_conversation_id, title)
       VALUES ($1, $2, 'platform', 'sidebar', $3, $4)
       ON CONFLICT (installation_id, channel_type, channel_key, external_conversation_id)
       WHERE external_conversation_id IS NOT NULL
       DO UPDATE SET updated_at = now()
       RETURNING *`,
      [input.installationId, input.organizationId, externalConversationId, installation.agent_name],
    );
    const conversation = created.rows[0]!;
    if (conversation.status !== "active") throw new Error("Platform conversation is not active");
    const userParticipant = await this.upsertParticipant(client, {
      conversationId: conversation.id,
      organizationId: input.organizationId,
      participantType: "user",
      externalId: input.actorId,
    });
    const agentParticipant = await this.upsertParticipant(client, {
      conversationId: conversation.id,
      organizationId: input.organizationId,
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
