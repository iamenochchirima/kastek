import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { withTransaction } from "../pool";
import {
  enqueueAgentConversationLifecycle,
  enqueueAgentConversationMessage,
  loadAgentConversationAnalyticsContext,
} from "../../analytics";
import type { ConversationRecord, MessageRecord, ParticipantRecord } from "./conversation-repository";
import type { RunRecord } from "./run-repository";
import { ConversationHandoffService } from "../../handoff/service";
import { recordConversationAdmission } from "../../telemetry/spans";
import { purgeMemoryRecords } from "./memory-repository";

export interface PlatformConversation {
  conversation: ConversationRecord;
  userParticipant: ParticipantRecord;
  agentParticipant: ParticipantRecord;
}

export interface AcceptedPlatformMessage extends PlatformConversation {
  message: MessageRecord;
  run: RunRecord | null;
  created: boolean;
  handoffRequestId?: string;
}

export interface AcceptedExternalMessage extends AcceptedPlatformMessage {
  sourceParticipant: ParticipantRecord;
}

interface ActiveInstallation {
  agent_definition_id: string;
  agent_version_id: string;
  agent_name: string;
  execution_mode: "system_hosted" | "kasitek_hosted" | "external_connected";
}

function fallbackConversationTitle(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  if (/^(?:hi|hello|hey|yo|howzit|good\s+(?:morning|afternoon|evening))(?:[!,.?\s]+)?$/i.test(normalized)) return "New chat";
  const words = normalized.split(" ").slice(0, 7).join(" ");
  return words.length > 72 ? `${words.slice(0, 69).trimEnd()}…` : words;
}

function normalizeMediaKind(value: unknown): string {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "file";
  return ["image", "video", "audio", "document", "file"].includes(kind) ? kind : "file";
}

function normalizeAgentMediaContent(content: Record<string, unknown>): Record<string, unknown> {
  const source = Array.isArray(content.media)
    ? content.media
    : typeof content.assetId === "string" && content.assetId.trim()
      ? [content]
      : [];
  const media = source.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const assetId = typeof value.assetId === "string" ? value.assetId.trim() : "";
    if (!assetId) return [];
    return [{
      assetId,
      kind: normalizeMediaKind(value.kind ?? value.mediaKind),
      ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType.slice(0, 160) } : {}),
      ...(typeof value.fileName === "string" ? { fileName: value.fileName.slice(0, 240) } : {}),
      ...(typeof value.altText === "string" ? { altText: value.altText.slice(0, 1_000) } : {}),
      ...(typeof value.caption === "string" ? { caption: value.caption.slice(0, 2_000) } : {}),
      disposition: value.disposition === "attachment" ? "attachment" : "inline",
    }];
  });
  if (!media.length) return content;
  const seen = new Set<string>();
  const uniqueMedia = media.filter((item) => !seen.has(item.assetId) && seen.add(item.assetId));
  return { ...content, media: uniqueMedia };
}

export class PlatformChatRepository {
  private readonly handoffService = new ConversationHandoffService();

  public constructor(
    private readonly pool: Pool,
    private readonly options: { isHandoffEnabled?: (organizationId: string, installationId: string) => Promise<boolean> } = {},
  ) {}

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

  /**
   * Clears the private testing transcript for one installation and immediately
   * creates a fresh conversation. Customer/channel conversations are never
   * included in this operation.
   */
  public async clearPrivateConversations(input: {
    organizationId: string;
    installationId: string;
    actorId: string;
  }): Promise<PlatformConversation> {
    return withTransaction(this.pool, async (client) => {
      const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
      const conversationKind = installation.execution_mode === "system_hosted" ? "personal" : "test";
      const privateConversations = await client.query<{ id: string }>(
        `SELECT id FROM conversations
         WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
           AND conversation_kind = $4 AND status <> 'deleted'
         FOR UPDATE`,
        [input.organizationId, input.installationId, input.actorId, conversationKind],
      );
      const conversationIds = privateConversations.rows.map((row) => row.id);
      if (conversationIds.length) {
        const activeRun = await client.query<{ id: string }>(
          `SELECT id FROM agent_runs
           WHERE organization_id = $1
             AND installation_id = $2
             AND conversation_id = ANY($3::uuid[])
             AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
           LIMIT 1`,
          [input.organizationId, input.installationId, conversationIds],
        );
        if (activeRun.rows[0]) {
          throw Object.assign(new Error("A private test chat is still running"), {
            statusCode: 409,
            code: "conversation_busy",
          });
        }
        await client.query(
          `UPDATE conversations
           SET status = 'deleted', is_primary = false, updated_at = now()
           WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
             AND conversation_kind = $4 AND status <> 'deleted'`,
          [input.organizationId, input.installationId, input.actorId, conversationKind],
        );
        await purgeMemoryRecords(client, { organizationId: input.organizationId, conversationIds });
        for (const conversationId of conversationIds) {
          const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, conversationId);
          await enqueueAgentConversationLifecycle(client, context, {
            action: "deleted",
            actorType: "human",
            occurredAt: new Date().toISOString(),
          });
        }
        await client.query(
          `DELETE FROM conversation_summaries
           WHERE organization_id = $1 AND conversation_id = ANY($2::uuid[])`,
          [input.organizationId, conversationIds],
        );
      }
      return this.createNewConversationInTransaction(client, {
        organizationId: input.organizationId,
        installationId: input.installationId,
        actorId: input.actorId,
        title: "New chat",
      });
    });
  }

  public async acceptMessage(input: {
    organizationId: string;
    installationId: string;
    actorId: string;
    correlationId?: string;
    idempotencyKey: string;
    message: string;
    messageType?: "text" | "attachment";
    content?: Record<string, unknown>;
    context?: Record<string, unknown>;
    conversationId?: string;
    createNew?: boolean;
    modelProvider?: string;
    model?: string;
  }): Promise<AcceptedPlatformMessage> {
    return withTransaction(this.pool, async (client) => {
      const content = normalizeAgentMediaContent(input.content ?? { text: input.message });
      const existing = await client.query<RunRecord>(
        `SELECT * FROM agent_runs
         WHERE organization_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [input.organizationId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const run = existing.rows[0];
        if (
          run.installation_id !== input.installationId
          || run.created_by !== input.actorId
          || !run.conversation_id
          || (input.conversationId && run.conversation_id !== input.conversationId)
        ) {
          throw new Error("Idempotency key already belongs to another request");
        }
        const resolved = await this.resolveOwnedConversationInTransaction(client, {
          organizationId: input.organizationId,
          installationId: input.installationId,
          actorId: input.actorId,
          conversationId: run.conversation_id,
        });
        const message = await client.query<MessageRecord>(
          `SELECT * FROM messages WHERE run_id = $1 AND direction = 'inbound' LIMIT 1`,
          [run.id],
        );
        if (!message.rows[0]) throw new Error("Idempotent platform message is incomplete");
        recordConversationAdmission({ outcome: "idempotent", channel: "platform" });
        return { ...resolved, message: message.rows[0], run, created: false };
      }

      if (Boolean(input.conversationId) === Boolean(input.createNew)) {
        throw Object.assign(new Error("Choose either a conversationId or createNew=true"), {
          statusCode: 400,
          code: "conversation_target_required",
        });
      }
      const resolved = input.conversationId
        ? await this.resolveOwnedConversationInTransaction(client, input)
        : await this.createNewConversationInTransaction(client, {
          organizationId: input.organizationId,
          installationId: input.installationId,
          actorId: input.actorId,
          title: fallbackConversationTitle(input.message),
          modelProvider: input.modelProvider,
          model: input.model,
        });

      const openRun = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
         WHERE conversation_id = $1
           AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
         ORDER BY created_at LIMIT 1`,
        [resolved.conversation.id],
      );
      if (openRun.rows[0]) {
        recordConversationAdmission({ outcome: "busy", channel: "platform" });
        throw Object.assign(new Error("This agent is still finishing the previous message"), {
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
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.organizationId,
          installation.agent_definition_id,
          installation.agent_version_id,
          input.installationId,
          resolved.conversation.id,
          JSON.stringify({ message: content.media ? content : input.message, context: input.context ?? {} }),
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
        if (run && (run.installation_id !== input.installationId || run.conversation_id !== resolved.conversation.id)) {
          throw new Error("Idempotency key already belongs to another request");
        }
        if (!run) {
          const active = await client.query<{ id: string }>(
            `SELECT id FROM agent_runs
             WHERE conversation_id = $1
               AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
             ORDER BY created_at LIMIT 1`,
            [resolved.conversation.id],
          );
          if (active.rows[0]) {
            recordConversationAdmission({ outcome: "busy", channel: "platform" });
            throw Object.assign(new Error("This agent is still finishing the previous message"), {
              statusCode: 409,
              code: "conversation_busy",
            });
          }
          throw new Error("Idempotency key already belongs to another request");
        }
        const message = await client.query<MessageRecord>(
          `SELECT * FROM messages WHERE run_id = $1 AND direction = 'inbound' LIMIT 1`,
          [run.id],
        );
        if (!message.rows[0]) throw new Error("Idempotent platform message is incomplete");
        recordConversationAdmission({ outcome: "idempotent", channel: "platform" });
        return { ...resolved, message: message.rows[0], run, created: false };
      }
      const run = createdRun.rows[0];
      const nextSequence = await this.nextSequence(client, resolved.conversation.id);
      const createdMessage = await client.query<MessageRecord>(
        `INSERT INTO messages
          (conversation_id, organization_id, participant_id, direction, message_type, content,
           provider, provider_message_id, sequence_number, run_id, source_channel, occurred_at,
           delivery_status)
         VALUES ($1, $2, $3, 'inbound', $4, $5::jsonb, 'platform', $6, $7, $8,
                 'platform', now(), 'local')
         RETURNING *`,
        [
          resolved.conversation.id,
          input.organizationId,
          resolved.userParticipant.id,
          input.messageType ?? "text",
          JSON.stringify(content),
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
      await client.query(
        `UPDATE conversations
         SET updated_at = now(), last_message_at = now(), last_message_direction = 'inbound',
             last_message_preview = LEFT($2, 500), message_count = message_count + 1
         WHERE id = $1`,
        [resolved.conversation.id, typeof content.text === "string" ? content.text : input.message],
      );
      const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, resolved.conversation.id);
      await enqueueAgentConversationMessage(client, context, createdMessage.rows[0]!, "created");
      recordConversationAdmission({ outcome: "accepted", channel: "platform" });
      return { ...resolved, message: createdMessage.rows[0]!, run, created: true };
    });
  }

  /**
   * Start a new attempt for a failed platform chat run without inserting a
   * second inbound message. The original message remains the durable user
   * request and keeps its relationship to the failed source run for audit and
   * retry history; the new run reuses the source input and produces only a new
   * assistant response.
   */
  public async retryMessage(input: {
    organizationId: string;
    runId: string;
    actorId: string;
    correlationId?: string;
  }): Promise<AcceptedPlatformMessage & { run: RunRecord }> {
    return withTransaction(this.pool, async (client) => {
      const sourceResult = await client.query<RunRecord>(
        "SELECT * FROM agent_runs WHERE id = $1 AND organization_id = $2 LIMIT 1",
        [input.runId, input.organizationId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
      if (source.trigger_type !== "message" || !source.conversation_id) {
        throw Object.assign(new Error("Only platform chat runs can be retried here"), { statusCode: 409 });
      }
      if (!["failed", "cancelled", "expired"].includes(source.status)) {
        throw Object.assign(new Error("Only failed, cancelled, or expired runs can be retried"), { statusCode: 409 });
      }

      const resolved = await this.resolveOwnedConversationInTransaction(client, {
        organizationId: input.organizationId,
        installationId: source.installation_id,
        actorId: input.actorId,
        conversationId: source.conversation_id,
      });
      const lockedSourceResult = await client.query<RunRecord>(
        "SELECT * FROM agent_runs WHERE id = $1 AND organization_id = $2 FOR UPDATE",
        [input.runId, input.organizationId],
      );
      const lockedSource = lockedSourceResult.rows[0];
      if (!lockedSource) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
      if (!["failed", "cancelled", "expired"].includes(lockedSource.status)) {
        throw Object.assign(new Error("Only failed, cancelled, or expired runs can be retried"), { statusCode: 409 });
      }

      const sourceMessage = await client.query<MessageRecord>(
        `SELECT * FROM messages
         WHERE organization_id = $1 AND run_id = $2 AND direction = 'inbound'
         ORDER BY sequence_number ASC LIMIT 1`,
        [input.organizationId, lockedSource.id],
      );
      if (!sourceMessage.rows[0] || sourceMessage.rows[0].source_channel !== "platform") {
        throw Object.assign(new Error("The run does not have a platform message to retry"), { statusCode: 409 });
      }

      const openRun = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
         WHERE conversation_id = $1
           AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
         ORDER BY created_at LIMIT 1`,
        [resolved.conversation.id],
      );
      if (openRun.rows[0]) {
        recordConversationAdmission({ outcome: "busy", channel: "platform" });
        throw Object.assign(new Error("This agent is still finishing the previous message"), {
          statusCode: 409,
          code: "conversation_busy",
        });
      }

      const installation = await this.getActiveInstallation(client, input.organizationId, source.installation_id);
      const retryKey = `platform-retry:${lockedSource.id}:${randomUUID()}`;
      const createdRun = await client.query<RunRecord>(
        `INSERT INTO agent_runs
          (organization_id, agent_definition_id, agent_version_id, installation_id,
           conversation_id, trigger_type, status, input, correlation_id, causation_id, created_by, idempotency_key,
           reply_channel_type, reply_binding_id, resolved_model_provider, resolved_model)
         VALUES ($1, $2, $3, $4, $5, 'message', 'received', $6::jsonb,
                 COALESCE($7::uuid, gen_random_uuid()), $8, $9, $10, 'platform', NULL, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.organizationId,
          installation.agent_definition_id,
          installation.agent_version_id,
          source.installation_id,
          resolved.conversation.id,
          JSON.stringify(lockedSource.input ?? {}),
          input.correlationId ?? null,
          lockedSource.id,
          input.actorId,
          retryKey,
          resolved.conversation.model_provider,
          resolved.conversation.model,
        ],
      );
      const run = createdRun.rows[0];
      if (!run) {
        const active = await client.query<{ id: string }>(
          `SELECT id FROM agent_runs
           WHERE conversation_id = $1
             AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
           ORDER BY created_at LIMIT 1`,
          [resolved.conversation.id],
        );
        if (active.rows[0]) {
          recordConversationAdmission({ outcome: "busy", channel: "platform" });
          throw Object.assign(new Error("This agent is still finishing the previous message"), {
            statusCode: 409,
            code: "conversation_busy",
          });
        }
        throw new Error("Retry run could not be created");
      }
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
          source.installation_id,
          JSON.stringify({ triggerType: "message", retryOfRunId: lockedSource.id }),
          input.actorId,
          run.correlation_id,
        ],
      );
      await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [resolved.conversation.id]);
      recordConversationAdmission({ outcome: "retry", channel: "platform" });
      return { ...resolved, message: sourceMessage.rows[0]!, run, created: true };
    });
  }

  public async acceptExternalMessage(input: {
    organizationId: string;
    installationId?: string;
    channelType: string;
    channelKey?: string;
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
      const content = normalizeAgentMediaContent(input.content);
      type ChannelRoute = {
        id: string;
        owner_actor_id: string | null;
        channel_connection_id: string;
        installation_id: string;
      };
      const binding = await client.query<ChannelRoute>(
        `SELECT cb.id, cb.owner_actor_id, cb.channel_connection_id, cb.installation_id
         FROM channel_bindings cb
         JOIN channel_connections cc ON cc.id = cb.channel_connection_id
         WHERE cb.organization_id = $1
           AND ($2::uuid IS NULL OR cb.installation_id = $2)
           AND cb.channel_type = $3 AND cb.external_identity = $4
           AND ($5::text IS NULL OR cc.channel_key = $5)
           AND cb.status = 'active' AND cc.status = 'active'
         LIMIT 1`,
        [input.organizationId, input.installationId ?? null, input.channelType, input.externalIdentity, input.channelKey ?? null],
      );
      let route = binding.rows[0];

      if (!route && input.channelKey) {
        const publicConnection = await client.query<{
          id: string;
          installation_id: string;
        }>(
          `SELECT cc.id, cc.installation_id
           FROM channel_connections cc
           JOIN agent_installations ai ON ai.id = cc.installation_id
           WHERE cc.organization_id = $1
             AND ($2::uuid IS NULL OR cc.installation_id = $2)
             AND cc.channel_type = $3 AND cc.channel_key = $4
             AND cc.status = 'active' AND ai.status = 'active'
             AND ai.execution_mode = 'kasitek_hosted'
           LIMIT 1`,
          [input.organizationId, input.installationId ?? null, input.channelType, input.channelKey],
        );
        const target = publicConnection.rows[0];
        if (target) {
          const createdBinding = await client.query<ChannelRoute>(
            `INSERT INTO channel_bindings
              (organization_id, installation_id, channel_connection_id, channel_type, external_identity, routing_key, owner_actor_id)
             VALUES ($1, $2, $3, $4, $5, 'default', NULL)
             ON CONFLICT DO NOTHING
             RETURNING id, owner_actor_id, channel_connection_id, installation_id`,
            [input.organizationId, target.installation_id, target.id, input.channelType, input.externalIdentity],
          );
          route = createdBinding.rows[0];
          if (!route) {
            const existingBinding = await client.query<ChannelRoute>(
              `SELECT cb.id, cb.owner_actor_id, cb.channel_connection_id, cb.installation_id
               FROM channel_bindings cb
               JOIN channel_connections cc ON cc.id = cb.channel_connection_id
               WHERE cb.organization_id = $1
                 AND ($2::uuid IS NULL OR cb.installation_id = $2)
                 AND cb.channel_type = $3 AND cb.external_identity = $4
                 AND ($5::text IS NULL OR cc.channel_key = $5)
                 AND cb.status = 'active' AND cc.status = 'active'
               LIMIT 1`,
              [input.organizationId, input.installationId ?? null, input.channelType, input.externalIdentity, input.channelKey ?? null],
            );
            route = existingBinding.rows[0];
          }
        }
      }

      if (!route) {
        throw Object.assign(new Error("External channel identity is not paired to a KasiTek user"), {
          statusCode: 403,
          code: "channel_identity_not_paired",
        });
      }

      const installation = await this.getActiveInstallation(client, input.organizationId, route.installation_id);
      if (installation.execution_mode !== "kasitek_hosted" && !route.owner_actor_id) {
        throw Object.assign(new Error("External channel identity is not paired to a KasiTek user"), {
          statusCode: 403,
          code: "channel_identity_not_paired",
        });
      }
      const runActorId = route.owner_actor_id ?? `installation:${route.installation_id}`;
      const resolved = installation.execution_mode === "kasitek_hosted"
        ? await this.resolveCustomerConversationInTransaction(client, {
          organizationId: input.organizationId,
          installationId: route.installation_id,
          channelType: input.channelType,
          channelKey: route.channel_connection_id,
          externalIdentity: input.externalIdentity,
          externalConversationId: input.externalConversationId,
          displayName: input.displayName,
        })
        : await this.resolveConversationInTransaction(client, {
          organizationId: input.organizationId,
          installationId: route.installation_id,
          actorId: route.owner_actor_id ?? runActorId,
        });
      const sourceParticipant = installation.execution_mode === "kasitek_hosted"
        ? resolved.userParticipant
        : await this.upsertParticipant(client, {
          conversationId: resolved.conversation.id,
          organizationId: input.organizationId,
          participantType: "user",
          externalId: `${input.channelType}:${input.externalIdentity}`,
          displayName: input.displayName,
        });

      const duplicate = await client.query<MessageRecord>(
        `SELECT * FROM messages
         WHERE organization_id = $1 AND provider = $2 AND provider_message_id = $3
           AND source_connection_id = $4
         LIMIT 1`,
        [input.organizationId, input.provider, input.providerMessageId, route.channel_connection_id],
      );
      if (duplicate.rows[0]) {
        const existingRun = duplicate.rows[0].run_id
          ? await client.query<RunRecord>("SELECT * FROM agent_runs WHERE id = $1", [duplicate.rows[0].run_id])
          : null;
        if (duplicate.rows[0].run_id && !existingRun?.rows[0]) throw new Error("Idempotent external message is incomplete");
        const existingHandoff = await client.query<{ id: string }>(
          `SELECT id FROM agent_handoff_requests
           WHERE organization_id = $1 AND source_message_id = $2
           LIMIT 1`,
          [input.organizationId, duplicate.rows[0].id],
        );
        recordConversationAdmission({ outcome: "redelivery", channel: input.channelType });
        return {
          ...resolved,
          sourceParticipant,
          message: duplicate.rows[0],
          run: existingRun?.rows[0] ?? null,
          handoffRequestId: existingHandoff.rows[0]?.id,
          created: false,
        };
      }

      if (resolved.conversation.conversation_kind === "customer" && resolved.conversation.handoff_state !== "agent_active") {
        throw Object.assign(new Error("Agent execution is paused while this conversation is owned by a human"), {
          statusCode: 409,
          code: "conversation_handoff_active",
        });
      }

      const idempotencyKey = `channel:${input.provider}:${input.providerEventId}`;
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
          JSON.stringify(content),
          input.provider,
          input.providerMessageId,
          nextSequence,
          null,
          input.channelType,
          route.channel_connection_id,
          route.id,
          input.externalConversationId,
          input.occurredAt ?? null,
        ],
      );
      const message = messageResult.rows[0]!;
      await client.query(
        `UPDATE conversations
         SET updated_at = now(),
             last_message_at = COALESCE($2::timestamptz, now()),
             last_message_direction = 'inbound',
             last_message_preview = LEFT(COALESCE($3, $4), 500),
             message_count = message_count + 1
         WHERE id = $1`,
        [
          resolved.conversation.id,
          input.occurredAt ?? null,
          typeof content.text === "string" ? content.text : null,
          input.messageType,
        ],
      );
      const customerMessage = typeof input.content.text === "string" ? input.content.text : "";
      const handoffDecision = this.options.isHandoffEnabled && !await this.options.isHandoffEnabled(input.organizationId, route.installation_id)
        ? { kind: "none" as const, intent: { kind: "other" as const, classifierVersion: "v1-en" as const, matchedRule: "handoff_feature_disabled" } }
        : await this.handoffService.decideInbound(client, {
          organizationId: input.organizationId,
          installationId: route.installation_id,
          agentId: installation.agent_definition_id,
          agentVersionId: installation.agent_version_id,
          conversationId: resolved.conversation.id,
          messageId: message.id,
          channelType: input.channelType,
          content,
          customerMessage,
        });
      if (handoffDecision.kind === "requested") {
        const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, resolved.conversation.id);
        await enqueueAgentConversationMessage(client, context, message, "created");
        return {
          ...resolved,
          conversation: handoffDecision.conversation,
          sourceParticipant,
          message,
          run: null,
          handoffRequestId: handoffDecision.handoff.id,
          created: true,
        };
      }

      const openRun = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
         WHERE conversation_id = $1
           AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
         ORDER BY created_at LIMIT 1`,
        [resolved.conversation.id],
      );
      if (openRun.rows[0]) {
        recordConversationAdmission({ outcome: "busy", channel: input.channelType });
        throw Object.assign(new Error("This agent is still finishing the previous message"), {
          statusCode: 409,
          code: "conversation_busy",
        });
      }

      const runResult = await client.query<RunRecord>(
        `INSERT INTO agent_runs
          (organization_id, agent_definition_id, agent_version_id, installation_id,
           conversation_id, trigger_type, status, input, correlation_id, created_by,
           idempotency_key, reply_channel_type, reply_binding_id, resolved_model_provider, resolved_model)
         VALUES ($1, $2, $3, $4, $5, 'message', 'received', $6::jsonb,
                 COALESCE($7::uuid, gen_random_uuid()), $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.organizationId,
          installation.agent_definition_id,
          installation.agent_version_id,
          route.installation_id,
          resolved.conversation.id,
          JSON.stringify({
            message: content.media ? content : (content.text ?? content),
            context: { sourceChannel: input.channelType },
          }),
          input.correlationId ?? null,
          runActorId,
          idempotencyKey,
          input.channelType,
          route.id,
          resolved.conversation.model_provider,
          resolved.conversation.model,
        ],
      );
      const run = runResult.rows[0];
      if (!run) {
        const active = await client.query<{ id: string }>(
          `SELECT id FROM agent_runs
           WHERE conversation_id = $1
             AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
           ORDER BY created_at LIMIT 1`,
          [resolved.conversation.id],
        );
        if (active.rows[0]) {
          recordConversationAdmission({ outcome: "busy", channel: input.channelType });
          throw Object.assign(new Error("This agent is still finishing the previous message"), {
            statusCode: 409,
            code: "conversation_busy",
          });
        }
        throw new Error("External message run could not be created");
      }
      const linkedMessage = await client.query<MessageRecord>(
        `UPDATE messages SET run_id = $2 WHERE id = $1 RETURNING *`,
        [message.id, run.id],
      );
      if (!linkedMessage.rows[0]) throw new Error("External message run link could not be created");
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
          runActorId,
          run.correlation_id,
        ],
      );
      const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, resolved.conversation.id);
      await enqueueAgentConversationMessage(client, context, linkedMessage.rows[0], "created");
      recordConversationAdmission({ outcome: "accepted", channel: input.channelType });
      return { ...resolved, sourceParticipant, message: linkedMessage.rows[0], run, created: true };
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
        conversation = await this.insertConversation(client, {
          organizationId: input.organizationId,
          installationId: input.installationId,
          actorId: input.actorId,
          channelKey: installation.execution_mode === "system_hosted" ? "kasiai" : "agent",
          externalConversationId: input.conversationKey
            ? `platform:user:${input.actorId}:${input.conversationKey}`
            : `platform:user:${input.actorId}:${randomUUID()}`,
          title: installation.agent_name,
          isPrimary: true,
          conversationKind: installation.execution_mode === "system_hosted" ? "personal" : "test",
        });
      }
    }
    if (conversation.status !== "active") throw new Error("Platform conversation is not active");
    return this.ensureParticipants(client, conversation, installation, input.organizationId, input.actorId);
  }

  private async resolveCustomerConversationInTransaction(
    client: PoolClient,
    input: {
      organizationId: string;
      installationId: string;
      channelType: string;
      channelKey: string;
      externalIdentity: string;
      externalConversationId: string;
      displayName?: string;
    },
  ): Promise<PlatformConversation> {
    const installation = await this.getActiveInstallation(client, input.organizationId, input.installationId);
    const title = input.displayName?.trim() || `${input.channelType} conversation`;
    const created = await client.query<ConversationRecord>(
      `INSERT INTO conversations
        (installation_id, organization_id, channel_type, channel_key, external_conversation_id,
         title, conversation_kind, owner_actor_id, is_primary, title_source)
       VALUES ($1, $2, $3, $4, $5, $6, 'customer', NULL, false, 'fallback')
       ON CONFLICT (installation_id, channel_type, channel_key, external_conversation_id)
       WHERE external_conversation_id IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [input.installationId, input.organizationId, input.channelType, input.channelKey, input.externalConversationId, title],
    );
    const conversation = created.rows[0] ?? (await client.query<ConversationRecord>(
      `UPDATE conversations
       SET title = CASE
             WHEN title_source = 'fallback' AND $6::text <> '' THEN $6
             ELSE title
           END
       WHERE organization_id = $1 AND installation_id = $2 AND channel_type = $3
         AND channel_key = $4 AND external_conversation_id = $5
       RETURNING *`,
      [input.organizationId, input.installationId, input.channelType, input.channelKey, input.externalConversationId, title],
    )).rows[0];
    if (!conversation) throw new Error("Customer conversation could not be resolved");
    const lockedConversation = await client.query<ConversationRecord>(
      "SELECT * FROM conversations WHERE id = $1 AND organization_id = $2 FOR UPDATE",
      [conversation.id, input.organizationId],
    );
    if (!lockedConversation.rows[0]) throw new Error("Customer conversation could not be resolved");
    const currentConversation = lockedConversation.rows[0];
    if (currentConversation.status !== "active") throw new Error("Customer conversation is not active");
    if (created.rows[0]) {
      const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, currentConversation.id);
      await enqueueAgentConversationLifecycle(client, context, {
        action: "created",
        actorType: "system",
        occurredAt: currentConversation.created_at,
      });
    }
    const customerParticipant = await this.upsertParticipant(client, {
      conversationId: conversation.id,
      organizationId: input.organizationId,
      participantType: "customer",
      externalId: `${input.channelType}:${input.externalIdentity}`,
      displayName: input.displayName,
    });
    const agentParticipant = await this.upsertParticipant(client, {
      conversationId: conversation.id,
      organizationId: input.organizationId,
      participantType: "agent",
      externalId: installation.agent_definition_id,
      displayName: installation.agent_name,
    });
    return { conversation: currentConversation, userParticipant: customerParticipant, agentParticipant };
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
    const channelDefault = await client.query<{ id: string }>(
      `SELECT id FROM conversations
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
         AND is_primary = true AND status = 'active'
       LIMIT 1`,
      [input.organizationId, input.installationId, input.actorId],
    );
    const conversation = await this.insertConversation(client, {
      organizationId: input.organizationId,
      installationId: input.installationId,
      actorId: input.actorId,
      channelKey: installation.execution_mode === "system_hosted" ? "kasiai" : "agent",
      externalConversationId: `platform:user:${input.actorId}:${randomUUID()}`,
      title: input.title ?? "New chat",
      modelProvider: input.modelProvider,
      model: input.model,
      isPrimary: !channelDefault.rows[0],
      conversationKind: installation.execution_mode === "system_hosted" ? "personal" : "test",
    });
    return this.ensureParticipants(client, conversation, installation, input.organizationId, input.actorId);
  }

  private async insertConversation(
    client: PoolClient,
    input: {
      organizationId: string;
      installationId: string;
      actorId: string;
      channelKey: string;
      externalConversationId: string;
      title: string;
      modelProvider?: string;
      model?: string;
      isPrimary: boolean;
      conversationKind: "personal" | "customer" | "test" | "external";
    },
  ): Promise<ConversationRecord> {
    const created = await client.query<ConversationRecord>(
      `INSERT INTO conversations
        (installation_id, organization_id, channel_type, channel_key, external_conversation_id,
        title, conversation_kind, owner_actor_id, is_primary, model_provider, model, title_source, last_opened_at)
       VALUES ($1, $2, 'unified', $3, $4, $5, $6, $7, $10, $8, $9, 'fallback', now())
       RETURNING *`,
      [input.installationId, input.organizationId, input.channelKey, input.externalConversationId, input.title, input.conversationKind, input.actorId, input.modelProvider ?? null, input.model ?? null, input.isPrimary],
    );
    const conversation = created.rows[0]!;
    const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, conversation.id);
    await enqueueAgentConversationLifecycle(client, context, {
      action: "created",
      actorType: "human",
      occurredAt: conversation.created_at,
    });
    return conversation;
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
      `SELECT ai.agent_definition_id, ai.agent_version_id, ai.execution_mode, ad.name AS agent_name
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
