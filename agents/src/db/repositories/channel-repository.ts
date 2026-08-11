import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

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
}
