import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import { createPairingToken, hashPairingToken } from "../../channels/pairing";
import {
  enqueueAgentConversationMessage,
  loadAgentConversationAnalyticsContext,
  type ConversationMessageAnalyticsRecord,
} from "../../analytics";

export interface ChannelConnectionRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  channel_type: string;
  channel_key: string;
  credential_reference: string | null;
  webhook_secret_hash: string | null;
  webhook_url: string | null;
  metadata: Record<string, unknown>;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelBindingRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  channel_connection_id: string;
  channel_type: string;
  external_identity: string;
  routing_key: string;
  owner_actor_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DeliveryAttemptRecord {
  id: string;
  organization_id: string;
  conversation_id: string;
  message_id: string;
  channel_type: string;
  provider_message_id: string | null;
  status: string;
  attempt_number: number;
  error: Record<string, unknown> | null;
  created_at: string;
  sent_at: string | null;
}

export interface MessageDeliveryStatusRecord {
  id: string;
  organization_id: string;
  conversation_id: string;
  provider_message_id: string | null;
  delivery_status: string | null;
}

export interface RunReplyDeliveryRecord {
  attempt_id: string;
  message_id: string;
  organization_id: string;
  conversation_id: string;
  channel_type: string;
  external_conversation_id: string;
  content: Record<string, unknown>;
  run_id: string;
  installation_id: string;
  actor_id: string;
  correlation_id: string;
  credential_reference: string | null;
}

export interface ApprovalPromptTargetRecord {
  organization_id: string;
  run_id: string;
  installation_id: string;
  binding_id: string;
  channel_connection_id: string;
  channel_type: string;
  external_identity: string;
  external_conversation_id: string;
  credential_reference: string | null;
  owner_actor_id: string;
}

export interface ChannelPairingResult {
  id: string;
  organization_id: string;
  installation_id: string;
  connection_id: string;
  external_identity: string | null;
  owner_actor_id: string | null;
  expires_at: string;
  token?: string;
}

export class ChannelRepository {
  public constructor(private readonly pool: Pool) {}

  public async createConnection(input: {
    organizationId: string;
    installationId: string;
    channelType: string;
    channelKey: string;
    credentialReference?: string;
    webhookSecretHash?: string;
    webhookUrl?: string;
    metadata?: Record<string, unknown>;
    actorId: string;
  }): Promise<ChannelConnectionRecord> {
    const result = await query<ChannelConnectionRecord>(
      this.pool,
      `INSERT INTO channel_connections
        (organization_id, installation_id, channel_type, channel_key, credential_reference, webhook_secret_hash, webhook_url, metadata, created_by)
       SELECT $1, id, $3, $4, $5, $6, $7, $8::jsonb, $9 FROM agent_installations
       WHERE id = $2 AND organization_id = $1 AND status = 'active'
         AND execution_mode IN ('system_hosted', 'kasitek_hosted')
       ON CONFLICT (organization_id, channel_type, channel_key) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         credential_reference = EXCLUDED.credential_reference,
         webhook_secret_hash = EXCLUDED.webhook_secret_hash,
         webhook_url = EXCLUDED.webhook_url,
         metadata = EXCLUDED.metadata,
         status = 'active', updated_at = now()
       WHERE channel_connections.installation_id = EXCLUDED.installation_id
          OR channel_connections.status = 'revoked'
       RETURNING *`,
      [input.organizationId, input.installationId, input.channelType, input.channelKey, input.credentialReference ?? null, input.webhookSecretHash ?? null, input.webhookUrl ?? null, JSON.stringify(input.metadata ?? {}), input.actorId],
    );
    if (!result.rows[0]) {
      const existing = await query<{ installation_id: string }>(
        this.pool,
        `SELECT installation_id FROM channel_connections
         WHERE organization_id = $1 AND channel_type = $2 AND channel_key = $3
         LIMIT 1`,
        [input.organizationId, input.channelType, input.channelKey],
      );
      if (existing.rows[0]) {
        throw Object.assign(new Error("Channel is already assigned to another agent"), {
          statusCode: 409,
          code: "channel_already_assigned",
        });
      }
      throw new Error("Active installation not found");
    }
    return result.rows[0];
  }

  public async getConnection(organizationId: string, connectionId: string): Promise<ChannelConnectionRecord | null> {
    const result = await query<ChannelConnectionRecord>(
      this.pool,
      `SELECT * FROM channel_connections WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, connectionId],
    );
    return result.rows[0] ?? null;
  }

  public async getConnectionForWebhook(connectionId: string): Promise<(ChannelConnectionRecord & { installation_status: string; execution_mode: string }) | null> {
    const result = await query<ChannelConnectionRecord & { installation_status: string; execution_mode: string }>(
      this.pool,
      `SELECT cc.*, ai.status AS installation_status, ai.execution_mode
       FROM channel_connections cc
       JOIN agent_installations ai ON ai.id = cc.installation_id
       WHERE cc.id = $1 LIMIT 1`,
      [connectionId],
    );
    return result.rows[0] ?? null;
  }

  public async getConnectionForInbound(input: { organizationId: string; channelType: string; channelKey: string }): Promise<(ChannelConnectionRecord & { execution_mode: string }) | null> {
    const result = await query<ChannelConnectionRecord & { execution_mode: string }>(
      this.pool,
      `SELECT cc.*, ai.execution_mode
       FROM channel_connections cc
       JOIN agent_installations ai ON ai.id = cc.installation_id
       WHERE cc.organization_id = $1 AND cc.channel_type = $2 AND cc.channel_key = $3
         AND cc.status = 'active' AND ai.status = 'active'
       LIMIT 1`,
      [input.organizationId, input.channelType, input.channelKey],
    );
    return result.rows[0] ?? null;
  }

  public async updateConnection(input: {
    organizationId: string;
    connectionId: string;
    status?: "active" | "paused" | "revoked" | "failed";
    metadata?: Record<string, unknown>;
    webhookUrl?: string | null;
  }): Promise<ChannelConnectionRecord> {
    const result = await query<ChannelConnectionRecord>(
      this.pool,
      `UPDATE channel_connections
       SET status = COALESCE($3, status),
           metadata = COALESCE($4::jsonb, metadata),
           webhook_url = COALESCE($5, webhook_url),
           updated_at = now()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [input.organizationId, input.connectionId, input.status ?? null, input.metadata ? JSON.stringify(input.metadata) : null, input.webhookUrl ?? null],
    );
    if (!result.rows[0]) throw Object.assign(new Error("Channel connection not found"), { statusCode: 404 });
    return result.rows[0];
  }

  public async revokeConnection(input: {
    organizationId: string;
    installationId: string;
    connectionId: string;
  }): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE channel_connections
         SET status = 'revoked', updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND installation_id = $3 AND status <> 'revoked'`,
        [input.connectionId, input.organizationId, input.installationId],
      );
      if (!result.rowCount) {
        throw Object.assign(new Error("Channel connection not found"), { statusCode: 404 });
      }
      await client.query(
        `UPDATE channel_bindings SET status = 'revoked', updated_at = now()
         WHERE organization_id = $1 AND channel_connection_id = $2 AND status <> 'revoked'`,
        [input.organizationId, input.connectionId],
      );
    });
  }

  public async bind(input: {
    organizationId: string;
    installationId: string;
    connectionId: string;
    externalIdentity: string;
    routingKey?: string;
    ownerActorId: string;
  }): Promise<ChannelBindingRecord> {
    return withTransaction(this.pool, async (client) => {
      const connection = await client.query<ChannelConnectionRecord>(
        `SELECT cc.* FROM channel_connections cc
         JOIN agent_installations ai ON ai.id = cc.installation_id
         WHERE cc.id = $1 AND cc.organization_id = $2 AND cc.installation_id = $3 AND cc.status = 'active'
           AND ai.execution_mode IN ('system_hosted', 'kasitek_hosted')`,
        [input.connectionId, input.organizationId, input.installationId],
      );
      const target = connection.rows[0];
      if (!target) throw new Error("Channel connection not found");
      // Keep this write valid while the legacy identity constraint is being
      // replaced by the per-connection constraint in migration 107.
      const result = await client.query<ChannelBindingRecord>(
        `INSERT INTO channel_bindings
          (organization_id, installation_id, channel_connection_id, channel_type, external_identity, routing_key,
           owner_actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [input.organizationId, input.installationId, input.connectionId, target.channel_type, input.externalIdentity, input.routingKey ?? "default", input.ownerActorId],
      );
      if (result.rows[0]) return result.rows[0];
      const updated = await client.query<ChannelBindingRecord>(
        `UPDATE channel_bindings cb
         SET installation_id = $2, channel_connection_id = $3, routing_key = $6,
             owner_actor_id = $7, status = 'active', updated_at = now()
         WHERE cb.id = (
           SELECT candidate.id
           FROM channel_bindings candidate
           WHERE candidate.organization_id = $1 AND candidate.channel_type = $4
             AND candidate.external_identity = $5
             AND (
               candidate.channel_connection_id = $3
               OR NOT EXISTS (
                 SELECT 1 FROM channel_bindings exact
                 WHERE exact.organization_id = $1 AND exact.channel_type = $4
                   AND exact.channel_connection_id = $3 AND exact.external_identity = $5
               )
             )
           ORDER BY (candidate.channel_connection_id = $3) DESC, candidate.updated_at DESC
           LIMIT 1
         )
         RETURNING cb.*`,
        [input.organizationId, input.installationId, input.connectionId, target.channel_type, input.externalIdentity, input.routingKey ?? "default", input.ownerActorId],
      );
      if (!updated.rows[0]) throw new Error("Channel binding could not be persisted");
      return updated.rows[0];
    });
  }

  public async listConnections(organizationId: string, installationId?: string): Promise<ChannelConnectionRecord[]> {
    const result = await query<ChannelConnectionRecord>(
      this.pool,
      `SELECT * FROM channel_connections
       WHERE organization_id = $1 AND ($2::uuid IS NULL OR installation_id = $2)
       ORDER BY created_at DESC`,
      [organizationId, installationId ?? null],
    );
    return result.rows;
  }

  public async listActiveDiscordConnections(): Promise<(ChannelConnectionRecord & { installation_status: string })[]> {
    const result = await query<ChannelConnectionRecord & { installation_status: string }>(
      this.pool,
      `SELECT cc.*, ai.status AS installation_status
       FROM channel_connections cc
       JOIN agent_installations ai ON ai.id = cc.installation_id
       WHERE cc.channel_type = 'discord' AND cc.status = 'active' AND ai.status = 'active'
       ORDER BY cc.created_at ASC`,
    );
    return result.rows;
  }

  public async listBindings(organizationId: string, installationId?: string): Promise<ChannelBindingRecord[]> {
    const result = await query<ChannelBindingRecord>(
      this.pool,
      `SELECT * FROM channel_bindings
       WHERE organization_id = $1 AND ($2::uuid IS NULL OR installation_id = $2)
       ORDER BY created_at DESC`,
      [organizationId, installationId ?? null],
    );
    return result.rows;
  }

  public async listOwnerBindings(organizationId: string, installationId: string, ownerActorId: string): Promise<ChannelBindingRecord[]> {
    const result = await query<ChannelBindingRecord>(
      this.pool,
      `SELECT * FROM channel_bindings
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3
       ORDER BY created_at DESC`,
      [organizationId, installationId, ownerActorId],
    );
    return result.rows;
  }

  public async revokeOwnerBinding(organizationId: string, bindingId: string, ownerActorId: string): Promise<void> {
    const result = await query(
      this.pool,
      `UPDATE channel_bindings SET status = 'revoked', updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3 AND status <> 'revoked'`,
      [organizationId, bindingId, ownerActorId],
    );
    if (!result.rowCount) throw new Error("Channel binding not found");
  }

  public async queueDelivery(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    channelType: string;
  }): Promise<DeliveryAttemptRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<DeliveryAttemptRecord>(
        `INSERT INTO delivery_attempts
          (organization_id, conversation_id, message_id, channel_type, status, attempt_number)
         SELECT $1, $2, $3, $4, 'queued',
                COALESCE((SELECT MAX(attempt_number) FROM delivery_attempts WHERE message_id = $3), 0) + 1
         FROM messages
         WHERE id = $3 AND conversation_id = $2 AND organization_id = $1
         RETURNING *`,
        [input.organizationId, input.conversationId, input.messageId, input.channelType],
      );
      if (!result.rows[0]) throw new Error("Message not found");
      const message = await client.query<ConversationMessageAnalyticsRecord>(
        `UPDATE messages SET delivery_status = 'queued'
         WHERE id = $1 AND conversation_id = $2 AND organization_id = $3
           AND delivery_status IS DISTINCT FROM 'queued'
         RETURNING *`,
        [input.messageId, input.conversationId, input.organizationId],
      );
      if (message.rows[0]) {
        const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, input.conversationId);
        await enqueueAgentConversationMessage(client, context, message.rows[0], "delivery_updated");
      }
      return result.rows[0]!;
    });
  }

  /**
   * Queue a new attempt for a terminal delivery only after taking a lock on
   * the message and verifying that the requested attempt is still the latest
   * one. This makes an operator replay safe under concurrent workers and
   * prevents replaying a delivery that has already been sent or superseded.
   */
  public async replayDelivery(input: {
    organizationId: string;
    attemptId: string;
    confirmUnknown?: boolean;
    expectedStatus?: "failed" | "unknown";
  }): Promise<{ previous: DeliveryAttemptRecord; replay: DeliveryAttemptRecord }> {
    return withTransaction(this.pool, async (client) => {
      const target = (await client.query<DeliveryAttemptRecord>(
        `SELECT * FROM delivery_attempts
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [input.attemptId, input.organizationId],
      )).rows[0];
      if (!target) throw Object.assign(new Error("Delivery attempt not found"), { statusCode: 404 });
      if (input.expectedStatus && target.status !== input.expectedStatus) {
        throw Object.assign(new Error(`Delivery attempt state changed from expected ${input.expectedStatus}`), { statusCode: 409 });
      }
      if (target.status !== "failed" && target.status !== "unknown") {
        throw Object.assign(new Error("Only failed or explicitly unknown delivery attempts can be replayed"), { statusCode: 409 });
      }
      if (target.status === "unknown" && input.confirmUnknown !== true) {
        throw Object.assign(new Error("Replaying an unknown delivery requires confirmUnknown"), { statusCode: 400 });
      }

      const messageTarget = (await client.query<{ id: string; conversation_id: string; organization_id: string }>(
        `SELECT id, conversation_id, organization_id
         FROM messages
         WHERE id = $1 AND conversation_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [target.message_id, target.conversation_id, input.organizationId],
      )).rows[0];
      if (!messageTarget) throw Object.assign(new Error("Delivery message not found"), { statusCode: 404 });

      const latest = (await client.query<{ id: string }>(
        `SELECT id FROM delivery_attempts
         WHERE message_id = $1
         ORDER BY attempt_number DESC
         LIMIT 1`,
        [target.message_id],
      )).rows[0];
      if (!latest || latest.id !== target.id) {
        throw Object.assign(new Error("Delivery attempt has already been superseded"), { statusCode: 409 });
      }

      const replay = (await client.query<DeliveryAttemptRecord>(
        `INSERT INTO delivery_attempts
          (organization_id, conversation_id, message_id, channel_type, status, attempt_number)
         SELECT $1, $2, $3, $4, 'queued',
                COALESCE((SELECT MAX(attempt_number) FROM delivery_attempts WHERE message_id = $3), 0) + 1
         RETURNING *`,
        [input.organizationId, messageTarget.conversation_id, messageTarget.id, target.channel_type],
      )).rows[0];
      if (!replay) throw new Error("Delivery replay could not be queued");
      const updatedMessage = await client.query<ConversationMessageAnalyticsRecord>(
        `UPDATE messages SET delivery_status = 'queued'
         WHERE id = $1 AND conversation_id = $2 AND organization_id = $3
           AND delivery_status IS DISTINCT FROM 'queued'
         RETURNING *`,
        [messageTarget.id, messageTarget.conversation_id, input.organizationId],
      );
      if (updatedMessage.rows[0]) {
        const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, updatedMessage.rows[0].conversation_id);
        await enqueueAgentConversationMessage(client, context, updatedMessage.rows[0], "delivery_updated");
      }
      return { previous: target, replay };
    });
  }

  public async getRunReplyDelivery(runId: string): Promise<RunReplyDeliveryRecord | null> {
    const result = await query<RunReplyDeliveryRecord>(
      this.pool,
      `SELECT da.id AS attempt_id, m.id AS message_id, m.organization_id, m.conversation_id,
              da.channel_type, m.external_conversation_id, m.content, ar.id AS run_id,
              ar.created_by AS actor_id, ar.correlation_id, ar.installation_id,
              cc.credential_reference
       FROM agent_runs ar
       JOIN messages m ON m.run_id = ar.id AND m.direction = 'outbound'
       JOIN delivery_attempts da ON da.message_id = m.id
       JOIN channel_bindings cb ON cb.id = ar.reply_binding_id
       JOIN channel_connections cc ON cc.id = cb.channel_connection_id
       WHERE ar.id = $1 AND da.status = 'queued'
         AND cb.status = 'active' AND cc.status = 'active'
         AND m.external_conversation_id IS NOT NULL
       ORDER BY da.attempt_number DESC
       LIMIT 1`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  public async getApprovalPromptTarget(runId: string): Promise<ApprovalPromptTargetRecord | null> {
    const result = await query<ApprovalPromptTargetRecord>(
      this.pool,
      `SELECT ar.organization_id, ar.id AS run_id, ar.installation_id,
              cb.id AS binding_id, cb.channel_connection_id, cb.channel_type, cb.external_identity,
              inbound.external_conversation_id, cc.credential_reference,
              cb.owner_actor_id
       FROM agent_runs ar
       JOIN channel_bindings cb ON cb.id = ar.reply_binding_id
       JOIN channel_connections cc ON cc.id = cb.channel_connection_id
       JOIN LATERAL (
         SELECT m.external_conversation_id
         FROM messages m
         WHERE m.run_id = ar.id AND m.direction = 'inbound'
           AND m.external_conversation_id IS NOT NULL
         ORDER BY m.sequence_number ASC
         LIMIT 1
       ) inbound ON true
       WHERE ar.id = $1
         AND ar.reply_channel_type IN ('telegram', 'whatsapp', 'facebook', 'instagram', 'discord')
         AND cb.status = 'active' AND cc.status = 'active'
         AND cb.owner_actor_id IS NOT NULL
       LIMIT 1`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  public async getActiveBindingForIdentity(input: { organizationId: string; channelType: string; externalIdentity: string }): Promise<ChannelBindingRecord | null> {
    const result = await query<ChannelBindingRecord>(
      this.pool,
      `SELECT cb.*
       FROM channel_bindings cb
       JOIN channel_connections cc ON cc.id = cb.channel_connection_id
       JOIN agent_installations ai ON ai.id = cb.installation_id
       WHERE cb.organization_id = $1 AND cb.channel_type = $2
         AND cb.external_identity = $3 AND cb.status = 'active'
         AND cc.status = 'active' AND ai.status = 'active'
       LIMIT 1`,
      [input.organizationId, input.channelType, input.externalIdentity],
    );
    return result.rows[0] ?? null;
  }

  public async claimDelivery(organizationId: string, attemptId: string): Promise<DeliveryAttemptRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<DeliveryAttemptRecord>(
        `UPDATE delivery_attempts SET status = 'sending'
         WHERE id = $1 AND organization_id = $2 AND status = 'queued'
         RETURNING *`,
        [attemptId, organizationId],
      );
      if (!result.rows[0]) throw new Error("Delivery attempt is not claimable");
      const message = await client.query<ConversationMessageAnalyticsRecord>(
        "UPDATE messages SET delivery_status = 'sending' WHERE id = $1 AND delivery_status IS DISTINCT FROM 'sending' RETURNING *",
        [result.rows[0].message_id],
      );
      if (message.rows[0]) {
        const context = await loadAgentConversationAnalyticsContext(client, organizationId, message.rows[0].conversation_id);
        await enqueueAgentConversationMessage(client, context, message.rows[0], "delivery_updated");
      }
      return result.rows[0];
    });
  }

  public async markDelivered(input: { organizationId: string; attemptId: string; providerMessageId?: string }): Promise<DeliveryAttemptRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<DeliveryAttemptRecord>(
        `UPDATE delivery_attempts SET status = 'sent', provider_message_id = COALESCE($3, provider_message_id), sent_at = now()
         WHERE id = $1 AND organization_id = $2 AND status = 'sending'
         RETURNING *`,
        [input.attemptId, input.organizationId, input.providerMessageId ?? null],
      );
      if (!result.rows[0]) throw new Error("Delivery attempt is not sending");
      const message = await client.query<ConversationMessageAnalyticsRecord>(
        `UPDATE messages SET delivery_status = 'sent',
           provider_message_id = COALESCE($2, provider_message_id)
         WHERE id = $1 AND delivery_status IS DISTINCT FROM 'sent'
         RETURNING *`,
        [result.rows[0].message_id, input.providerMessageId ?? null],
      );
      if (message.rows[0]) {
        const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, message.rows[0].conversation_id);
        await enqueueAgentConversationMessage(client, context, message.rows[0], "delivery_updated");
      }
      return result.rows[0];
    });
  }

  public async markDeliveryFailed(input: { organizationId: string; attemptId: string; error: Record<string, unknown> }): Promise<DeliveryAttemptRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<DeliveryAttemptRecord>(
        `UPDATE delivery_attempts SET status = 'failed', error = $3::jsonb
         WHERE id = $1 AND organization_id = $2 AND status IN ('queued', 'sending')
         RETURNING *`,
        [input.attemptId, input.organizationId, JSON.stringify(input.error)],
      );
      if (!result.rows[0]) throw new Error("Delivery attempt is terminal or missing");
      const message = await client.query<ConversationMessageAnalyticsRecord>(
        "UPDATE messages SET delivery_status = 'failed' WHERE id = $1 AND delivery_status IS DISTINCT FROM 'failed' RETURNING *",
        [result.rows[0].message_id],
      );
      if (message.rows[0]) {
        const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, message.rows[0].conversation_id);
        await enqueueAgentConversationMessage(client, context, message.rows[0], "delivery_updated");
      }
      return result.rows[0];
    });
  }

  public async updateProviderDeliveryStatus(input: {
    organizationId: string;
    providerMessageId: string;
    status: "sent" | "delivered" | "read" | "failed" | "unknown";
    error?: Record<string, unknown>;
  }): Promise<MessageDeliveryStatusRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<{ id: string; delivery_status: string | null }>(
        `SELECT id, delivery_status
         FROM messages
         WHERE organization_id = $1 AND provider_message_id = $2
         FOR UPDATE`,
        [input.organizationId, input.providerMessageId],
      );
      if (!current.rows[0]) throw new Error("Provider message not found");
      const message = await client.query<MessageDeliveryStatusRecord>(
        `UPDATE messages SET delivery_status = CASE
           WHEN delivery_status = 'failed' THEN delivery_status
           WHEN $3 = 'failed' THEN 'failed'
           WHEN COALESCE(array_position(ARRAY['unknown', 'queued', 'sending', 'sent', 'delivered', 'read'], delivery_status), 0)
              >= COALESCE(array_position(ARRAY['unknown', 'queued', 'sending', 'sent', 'delivered', 'read'], $3), 0)
             THEN delivery_status
           ELSE $3
         END
         WHERE organization_id = $1 AND provider_message_id = $2
         RETURNING id, organization_id, conversation_id, provider_message_id, delivery_status`,
        [input.organizationId, input.providerMessageId, input.status],
      );
      if (!message.rows[0]) throw new Error("Provider message not found");
      await client.query(
        `UPDATE delivery_attempts SET status = CASE
             WHEN status = 'failed' OR $3 = 'failed' THEN 'failed'
             ELSE 'sent'
           END,
           error = CASE WHEN $3 = 'failed' THEN $4::jsonb ELSE error END,
           sent_at = CASE WHEN $3 IN ('sent', 'delivered', 'read') THEN COALESCE(sent_at, now()) ELSE sent_at END
         WHERE organization_id = $1 AND message_id = $2`,
        [input.organizationId, message.rows[0].id, input.status, input.error ? JSON.stringify(input.error) : null],
      );
      if (current.rows[0].delivery_status !== message.rows[0].delivery_status) {
        const fullMessage = await client.query<ConversationMessageAnalyticsRecord>("SELECT * FROM messages WHERE id = $1", [message.rows[0].id]);
        const context = await loadAgentConversationAnalyticsContext(client, input.organizationId, message.rows[0].conversation_id);
        await enqueueAgentConversationMessage(client, context, fullMessage.rows[0]!, "delivery_updated");
      }
      return message.rows[0];
    });
  }

  public async issuePairingToken(input: {
    organizationId: string;
    installationId: string;
    connectionId: string;
    actorId: string;
    ttlSeconds?: number;
  }): Promise<ChannelPairingResult> {
    const generated = createPairingToken(input.ttlSeconds);
    const result = await query<ChannelPairingResult>(
      this.pool,
      `INSERT INTO channel_pairing_tokens
        (organization_id, installation_id, connection_id, token_hash, external_identity, expires_at,
         created_by, owner_actor_id)
       SELECT $1, cc.installation_id, cc.id, $4, NULL, $5, $6, $6
       FROM channel_connections cc
       JOIN agent_installations ai ON ai.id = cc.installation_id
       WHERE cc.id = $3 AND cc.organization_id = $1 AND cc.installation_id = $2 AND cc.status = 'active'
         AND ai.execution_mode IN ('system_hosted', 'kasitek_hosted')
       RETURNING id, organization_id, installation_id, connection_id, external_identity, expires_at,
         owner_actor_id`,
      [input.organizationId, input.installationId, input.connectionId, generated.tokenHash, generated.expiresAt, input.actorId],
    );
    if (!result.rows[0]) throw new Error("Channel connection not found");
    return { ...result.rows[0], token: generated.token };
  }

  public async consumePairingToken(input: {
    organizationId: string;
    token: string;
    externalIdentity: string;
  }): Promise<ChannelBindingRecord> {
    return withTransaction(this.pool, async (client) => {
      const token = await client.query<ChannelPairingResult>(
        `UPDATE channel_pairing_tokens
         SET consumed_at = now(), external_identity = $3
         WHERE organization_id = $1 AND token_hash = $2 AND consumed_at IS NULL AND expires_at > now()
           AND (external_identity IS NULL OR external_identity = $3)
         RETURNING id, organization_id, installation_id, connection_id, external_identity, expires_at,
           owner_actor_id`,
        [input.organizationId, hashPairingToken(input.token), input.externalIdentity],
      );
      const pairing = token.rows[0];
      if (!pairing) throw new Error("Pairing token is invalid, expired, or already consumed");
      const connection = await client.query<ChannelConnectionRecord>(
        `SELECT cc.* FROM channel_connections cc
         JOIN agent_installations ai ON ai.id = cc.installation_id
         WHERE cc.id = $1 AND cc.organization_id = $2 AND cc.installation_id = $3 AND cc.status = 'active'
           AND ai.execution_mode IN ('system_hosted', 'kasitek_hosted')`,
        [pairing.connection_id, input.organizationId, pairing.installation_id],
      );
      if (!connection.rows[0]) throw new Error("Channel connection not found");
      // Pairing can run during the same constraint transition as allowlist
      // binding, so use the same schema-compatible insert/update sequence.
      const binding = await client.query<ChannelBindingRecord>(
        `INSERT INTO channel_bindings
          (organization_id, installation_id, channel_connection_id, channel_type, external_identity,
           routing_key, owner_actor_id)
         VALUES ($1, $2, $3, $4, $5, 'default', $6)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [input.organizationId, pairing.installation_id, pairing.connection_id, connection.rows[0].channel_type, pairing.external_identity, pairing.owner_actor_id],
      );
      if (!binding.rows[0]) {
        const updated = await client.query<ChannelBindingRecord>(
          `UPDATE channel_bindings cb
           SET installation_id = $2, channel_connection_id = $3, routing_key = 'default',
               owner_actor_id = $6, status = 'active', updated_at = now()
           WHERE cb.id = (
             SELECT candidate.id
             FROM channel_bindings candidate
             WHERE candidate.organization_id = $1 AND candidate.channel_type = $4
               AND candidate.external_identity = $5
               AND (
                 candidate.channel_connection_id = $3
                 OR NOT EXISTS (
                   SELECT 1 FROM channel_bindings exact
                   WHERE exact.organization_id = $1 AND exact.channel_type = $4
                     AND exact.channel_connection_id = $3 AND exact.external_identity = $5
                 )
               )
             ORDER BY (candidate.channel_connection_id = $3) DESC, candidate.updated_at DESC
             LIMIT 1
           )
           RETURNING cb.*`,
          [input.organizationId, pairing.installation_id, pairing.connection_id, connection.rows[0].channel_type, pairing.external_identity, pairing.owner_actor_id],
        );
        if (updated.rows[0]) binding.rows.push(updated.rows[0]);
      }
      if (!binding.rows[0]) throw new Error("Channel binding could not be persisted");
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, action, resource_type, resource_id, metadata)
         VALUES ($1, 'channel', 'channel.pairing_consumed', 'channel_binding', $2, $3::jsonb)`,
        [input.organizationId, binding.rows[0]!.id, JSON.stringify({ pairingTokenId: pairing.id })],
      );
      return binding.rows[0]!;
    });
  }
}
