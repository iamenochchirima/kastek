import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import { createPairingToken, hashPairingToken } from "../../channels/pairing";

export interface ChannelConnectionRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  channel_type: string;
  channel_key: string;
  credential_reference: string | null;
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
    metadata?: Record<string, unknown>;
    actorId: string;
  }): Promise<ChannelConnectionRecord> {
    const result = await query<ChannelConnectionRecord>(
      this.pool,
      `INSERT INTO channel_connections
        (organization_id, installation_id, channel_type, channel_key, credential_reference, metadata, created_by)
       SELECT $1, id, $3, $4, $5, $6::jsonb, $7 FROM agent_installations
       WHERE id = $2 AND organization_id = $1 AND status = 'active'
       ON CONFLICT (organization_id, channel_type, channel_key) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         credential_reference = EXCLUDED.credential_reference,
         metadata = EXCLUDED.metadata,
         status = 'active', updated_at = now()
       RETURNING *`,
      [input.organizationId, input.installationId, input.channelType, input.channelKey, input.credentialReference ?? null, JSON.stringify(input.metadata ?? {}), input.actorId],
    );
    if (!result.rows[0]) throw new Error("Active installation not found");
    return result.rows[0];
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
        `SELECT * FROM channel_connections
         WHERE id = $1 AND organization_id = $2 AND installation_id = $3 AND status = 'active'`,
        [input.connectionId, input.organizationId, input.installationId],
      );
      const target = connection.rows[0];
      if (!target) throw new Error("Channel connection not found");
      const result = await client.query<ChannelBindingRecord>(
        `INSERT INTO channel_bindings
          (organization_id, installation_id, channel_connection_id, channel_type, external_identity, routing_key,
           owner_actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, channel_type, external_identity) DO UPDATE SET
           installation_id = EXCLUDED.installation_id,
           channel_connection_id = EXCLUDED.channel_connection_id,
           routing_key = EXCLUDED.routing_key,
           owner_actor_id = EXCLUDED.owner_actor_id,
           status = 'active', updated_at = now()
         RETURNING *`,
        [input.organizationId, input.installationId, input.connectionId, target.channel_type, input.externalIdentity, input.routingKey ?? "default", input.ownerActorId],
      );
      return result.rows[0]!;
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
         SELECT $1, $2, $3, $4, 'queued', COALESCE(MAX(attempt_number), 0) + 1
         FROM delivery_attempts WHERE message_id = $3
         RETURNING *`,
        [input.organizationId, input.conversationId, input.messageId, input.channelType],
      );
      await client.query(
        `UPDATE messages SET delivery_status = 'queued'
         WHERE id = $1 AND conversation_id = $2 AND organization_id = $3`,
        [input.messageId, input.conversationId, input.organizationId],
      );
      return result.rows[0]!;
    });
  }

  public async getRunReplyDelivery(runId: string): Promise<RunReplyDeliveryRecord | null> {
    const result = await query<RunReplyDeliveryRecord>(
      this.pool,
      `SELECT da.id AS attempt_id, m.id AS message_id, m.organization_id, m.conversation_id,
              da.channel_type, m.external_conversation_id, m.content, ar.id AS run_id,
              ar.created_by AS actor_id, ar.correlation_id, ar.installation_id
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

  public async claimDelivery(organizationId: string, attemptId: string): Promise<DeliveryAttemptRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<DeliveryAttemptRecord>(
        `UPDATE delivery_attempts SET status = 'sending'
         WHERE id = $1 AND organization_id = $2 AND status = 'queued'
         RETURNING *`,
        [attemptId, organizationId],
      );
      if (!result.rows[0]) throw new Error("Delivery attempt is not claimable");
      await client.query("UPDATE messages SET delivery_status = 'sending' WHERE id = $1", [result.rows[0].message_id]);
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
      await client.query(
        `UPDATE messages SET delivery_status = 'sent',
           provider_message_id = COALESCE($2, provider_message_id)
         WHERE id = $1`,
        [result.rows[0].message_id, input.providerMessageId ?? null],
      );
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
      await client.query("UPDATE messages SET delivery_status = 'failed' WHERE id = $1", [result.rows[0].message_id]);
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
       WHERE cc.id = $3 AND cc.organization_id = $1 AND cc.installation_id = $2 AND cc.status = 'active'
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
        `SELECT * FROM channel_connections WHERE id = $1 AND organization_id = $2 AND installation_id = $3 AND status = 'active'`,
        [pairing.connection_id, input.organizationId, pairing.installation_id],
      );
      if (!connection.rows[0]) throw new Error("Channel connection not found");
      const binding = await client.query<ChannelBindingRecord>(
        `INSERT INTO channel_bindings
          (organization_id, installation_id, channel_connection_id, channel_type, external_identity,
           routing_key, owner_actor_id)
         VALUES ($1, $2, $3, $4, $5, 'default', $6)
         ON CONFLICT (organization_id, channel_type, external_identity) DO UPDATE SET
           installation_id = EXCLUDED.installation_id, channel_connection_id = EXCLUDED.channel_connection_id,
           routing_key = EXCLUDED.routing_key, owner_actor_id = EXCLUDED.owner_actor_id,
           status = 'active', updated_at = now()
         RETURNING *`,
        [input.organizationId, pairing.installation_id, pairing.connection_id, connection.rows[0].channel_type, pairing.external_identity, pairing.owner_actor_id],
      );
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, action, resource_type, resource_id, metadata)
         VALUES ($1, 'channel', 'channel.pairing_consumed', 'channel_binding', $2, $3::jsonb)`,
        [input.organizationId, binding.rows[0]!.id, JSON.stringify({ pairingTokenId: pairing.id })],
      );
      return binding.rows[0]!;
    });
  }
}
