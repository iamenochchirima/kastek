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

export interface ChannelPairingResult {
  id: string;
  organization_id: string;
  installation_id: string;
  connection_id: string;
  external_identity: string;
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
          (organization_id, installation_id, channel_connection_id, channel_type, external_identity, routing_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, channel_type, external_identity) DO UPDATE SET
           installation_id = EXCLUDED.installation_id,
           channel_connection_id = EXCLUDED.channel_connection_id,
           routing_key = EXCLUDED.routing_key,
           status = 'active', updated_at = now()
         RETURNING *`,
        [input.organizationId, input.installationId, input.connectionId, target.channel_type, input.externalIdentity, input.routingKey ?? "default"],
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

  public async queueDelivery(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    channelType: string;
  }): Promise<DeliveryAttemptRecord> {
    const result = await query<DeliveryAttemptRecord>(
      this.pool,
      `INSERT INTO delivery_attempts
        (organization_id, conversation_id, message_id, channel_type, status, attempt_number)
       SELECT $1, $2, $3, $4, 'queued', COALESCE(MAX(attempt_number), 0) + 1
       FROM delivery_attempts WHERE message_id = $3
       RETURNING *`,
      [input.organizationId, input.conversationId, input.messageId, input.channelType],
    );
    return result.rows[0]!;
  }

  public async claimDelivery(organizationId: string, attemptId: string): Promise<DeliveryAttemptRecord> {
    const result = await query<DeliveryAttemptRecord>(
      this.pool,
      `UPDATE delivery_attempts SET status = 'sending'
       WHERE id = $1 AND organization_id = $2 AND status = 'queued'
       RETURNING *`,
      [attemptId, organizationId],
    );
    if (!result.rows[0]) throw new Error("Delivery attempt is not claimable");
    return result.rows[0];
  }

  public async markDelivered(input: { organizationId: string; attemptId: string; providerMessageId?: string }): Promise<DeliveryAttemptRecord> {
    const result = await query<DeliveryAttemptRecord>(
      this.pool,
      `UPDATE delivery_attempts SET status = 'sent', provider_message_id = COALESCE($3, provider_message_id), sent_at = now()
       WHERE id = $1 AND organization_id = $2 AND status = 'sending'
       RETURNING *`,
      [input.attemptId, input.organizationId, input.providerMessageId ?? null],
    );
    if (!result.rows[0]) throw new Error("Delivery attempt is not sending");
    return result.rows[0];
  }

  public async markDeliveryFailed(input: { organizationId: string; attemptId: string; error: Record<string, unknown> }): Promise<DeliveryAttemptRecord> {
    const result = await query<DeliveryAttemptRecord>(
      this.pool,
      `UPDATE delivery_attempts SET status = 'failed', error = $3::jsonb
       WHERE id = $1 AND organization_id = $2 AND status IN ('queued', 'sending')
       RETURNING *`,
      [input.attemptId, input.organizationId, JSON.stringify(input.error)],
    );
    if (!result.rows[0]) throw new Error("Delivery attempt is terminal or missing");
    return result.rows[0];
  }

  public async issuePairingToken(input: {
    organizationId: string;
    installationId: string;
    connectionId: string;
    externalIdentity: string;
    actorId: string;
    ttlSeconds?: number;
  }): Promise<ChannelPairingResult> {
    const generated = createPairingToken(input.ttlSeconds);
    const result = await query<ChannelPairingResult>(
      this.pool,
      `INSERT INTO channel_pairing_tokens
        (organization_id, installation_id, connection_id, token_hash, external_identity, expires_at, created_by)
       SELECT $1, cc.installation_id, cc.id, $4, $5, $6, $7
       FROM channel_connections cc
       WHERE cc.id = $3 AND cc.organization_id = $1 AND cc.installation_id = $2 AND cc.status = 'active'
       RETURNING id, organization_id, installation_id, connection_id, external_identity, expires_at`,
      [input.organizationId, input.installationId, input.connectionId, generated.tokenHash, input.externalIdentity, generated.expiresAt, input.actorId],
    );
    if (!result.rows[0]) throw new Error("Channel connection not found");
    return { ...result.rows[0], token: generated.token };
  }

  public async consumePairingToken(input: {
    organizationId: string;
    token: string;
  }): Promise<ChannelBindingRecord> {
    return withTransaction(this.pool, async (client) => {
      const token = await client.query<ChannelPairingResult>(
        `UPDATE channel_pairing_tokens
         SET consumed_at = now()
         WHERE organization_id = $1 AND token_hash = $2 AND consumed_at IS NULL AND expires_at > now()
         RETURNING id, organization_id, installation_id, connection_id, external_identity, expires_at`,
        [input.organizationId, hashPairingToken(input.token)],
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
          (organization_id, installation_id, channel_connection_id, channel_type, external_identity, routing_key)
         VALUES ($1, $2, $3, $4, $5, 'default')
         ON CONFLICT (organization_id, channel_type, external_identity) DO UPDATE SET
           installation_id = EXCLUDED.installation_id, channel_connection_id = EXCLUDED.channel_connection_id,
           routing_key = EXCLUDED.routing_key, status = 'active', updated_at = now()
         RETURNING *`,
        [input.organizationId, pairing.installation_id, pairing.connection_id, connection.rows[0].channel_type, pairing.external_identity],
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
