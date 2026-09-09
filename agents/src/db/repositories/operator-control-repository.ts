import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";

export type OperatorFlagScope = "global" | "organization" | "installation";
export type OperatorHoldScope = "organization" | "installation" | "run";
export type OperatorHoldType = "execution" | "effects" | "delivery";
export type OperatorFlagKey = "agent_execution_enabled" | "agent_version_deployment_enabled" | "effect_execution_enabled" | "mcp_enabled" | "rest_enabled" | "customer_handoff_enabled" | "audio_transcription_enabled" | "dynamic_ui_enabled" | "memory_v2_retrieval_enabled" | "memory_v2_writes_enabled" | "memory_consolidation_enabled" | "memory_projection_enabled" | "capability_awareness_enabled";

export interface OperatorFeatureFlagRecord {
  id: string;
  scope_type: OperatorFlagScope;
  scope_id: string;
  organization_id: string | null;
  flag_key: OperatorFlagKey;
  enabled: boolean;
  reason: string;
  expires_at: string;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface OperatorHoldRecord {
  id: string;
  organization_id: string;
  scope_type: OperatorHoldScope;
  scope_id: string;
  hold_type: OperatorHoldType;
  reason: string;
  status: "active" | "released";
  expires_at: string;
  created_by: string;
  created_at: string;
  released_by: string | null;
  released_at: string | null;
  revision: number;
}

export class OperatorControlRepository {
  public constructor(private readonly pool: Pool) {}

  public async setFeatureFlag(input: {
    scopeType: OperatorFlagScope;
    scopeId: string;
    organizationId?: string;
    flagKey: OperatorFlagKey;
    enabled: boolean;
    reason: string;
    expiresAt: string;
    actorId: string;
  }): Promise<OperatorFeatureFlagRecord> {
    return withTransaction(this.pool, async (client) => this.setFeatureFlagWithClient(client, input));
  }

  private async setFeatureFlagWithClient(client: PoolClient, input: {
    scopeType: OperatorFlagScope;
    scopeId: string;
    organizationId?: string;
    flagKey: OperatorFlagKey;
    enabled: boolean;
    reason: string;
    expiresAt: string;
    actorId: string;
  }): Promise<OperatorFeatureFlagRecord> {
    const result = await client.query<OperatorFeatureFlagRecord>(
      `INSERT INTO agent_operator_feature_flags
        (scope_type, scope_id, organization_id, flag_key, enabled, reason, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (scope_type, scope_id, flag_key) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         enabled = EXCLUDED.enabled,
         reason = EXCLUDED.reason,
         expires_at = EXCLUDED.expires_at,
         revision = agent_operator_feature_flags.revision + 1,
         created_by = EXCLUDED.created_by,
         updated_at = now()
       RETURNING *`,
      [input.scopeType, input.scopeId, input.organizationId ?? null, input.flagKey, input.enabled, input.reason, input.expiresAt, input.actorId],
    );
    const record = result.rows[0]!;
    await client.query(
      `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'platform_admin', $2, 'operator_feature_flag.updated', 'operator_feature_flag', $3, $4::jsonb)`,
      [record.organization_id, input.actorId, record.id, JSON.stringify({ scopeType: record.scope_type, scopeId: record.scope_id, flagKey: record.flag_key, enabled: record.enabled, revision: record.revision, expiresAt: record.expires_at })],
    );
    return record;
  }

  public async clearFeatureFlag(input: {
    scopeType: OperatorFlagScope;
    scopeId: string;
    organizationId?: string;
    flagKey: OperatorFlagKey;
    reason: string;
    expiresAt: string;
    actorId: string;
  }): Promise<OperatorFeatureFlagRecord> {
    return this.setFeatureFlag({ ...input, enabled: false });
  }

  public async listFeatureFlags(limit = 100): Promise<OperatorFeatureFlagRecord[]> {
    const result = await query<OperatorFeatureFlagRecord>(this.pool, `SELECT * FROM agent_operator_feature_flags ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return result.rows;
  }

  public async isFeatureEnabled(organizationId: string, flagKey: OperatorFlagKey, installationId?: string): Promise<boolean> {
    const result = await query<{ enabled: boolean }>(
      this.pool,
      `SELECT enabled
       FROM agent_operator_feature_flags
       WHERE flag_key = $1 AND expires_at > now()
         AND ((scope_type = 'global')
           OR (scope_type = 'organization' AND scope_id = $2)
           OR (scope_type = 'installation' AND scope_id = $3 AND organization_id = $2))
       ORDER BY CASE scope_type WHEN 'installation' THEN 3 WHEN 'organization' THEN 2 ELSE 1 END DESC
       LIMIT 1`,
      [flagKey, organizationId, installationId ?? ""],
    );
    return result.rows[0]?.enabled ?? true;
  }

  public async createHold(input: {
    organizationId: string;
    scopeType: OperatorHoldScope;
    scopeId: string;
    holdType: OperatorHoldType;
    reason: string;
    expiresAt: string;
    actorId: string;
  }): Promise<OperatorHoldRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<OperatorHoldRecord>(
        `INSERT INTO agent_operator_holds
          (organization_id, scope_type, scope_id, hold_type, reason, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [input.organizationId, input.scopeType, input.scopeId, input.holdType, input.reason, input.expiresAt, input.actorId],
      );
      const record = result.rows[0]!;
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'platform_admin', $2, 'operator_hold.created', 'operator_hold', $3, $4::jsonb)`,
        [record.organization_id, input.actorId, record.id, JSON.stringify({ scopeType: record.scope_type, scopeId: record.scope_id, holdType: record.hold_type, expiresAt: record.expires_at })],
      );
      return record;
    });
  }

  public async getHold(id: string): Promise<OperatorHoldRecord | null> {
    const result = await query<OperatorHoldRecord>(this.pool, "SELECT * FROM agent_operator_holds WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  public async releaseHold(id: string, actorId: string): Promise<OperatorHoldRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<OperatorHoldRecord>(
        `UPDATE agent_operator_holds
         SET status = 'released', released_by = $2, released_at = now(), revision = revision + 1
         WHERE id = $1 AND status = 'active'
         RETURNING *`,
        [id, actorId],
      );
      const record = result.rows[0];
      if (!record) throw Object.assign(new Error("Active operator hold not found"), { statusCode: 404 });
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'platform_admin', $2, 'operator_hold.released', 'operator_hold', $3, $4::jsonb)`,
        [record.organization_id, actorId, record.id, JSON.stringify({ scopeType: record.scope_type, scopeId: record.scope_id, holdType: record.hold_type, revision: record.revision })],
      );
      return record;
    });
  }

  public async listHolds(limit = 100): Promise<OperatorHoldRecord[]> {
    const result = await query<OperatorHoldRecord>(this.pool, `SELECT * FROM agent_operator_holds ORDER BY created_at DESC LIMIT $1`, [limit]);
    return result.rows;
  }

  public async isHeld(input: { organizationId: string; installationId?: string; runId?: string; holdType: OperatorHoldType }): Promise<boolean> {
    const result = await query<{ held: boolean }>(
      this.pool,
      `SELECT EXISTS (
         SELECT 1 FROM agent_operator_holds
         WHERE organization_id = $1 AND hold_type = $2 AND status = 'active' AND expires_at > now()
           AND ((scope_type = 'organization' AND scope_id = $1)
             OR (scope_type = 'installation' AND scope_id = $3)
             OR (scope_type = 'run' AND scope_id = $4))
       ) AS held`,
      [input.organizationId, input.holdType, input.installationId ?? "", input.runId ?? ""],
    );
    return result.rows[0]?.held ?? false;
  }
}
