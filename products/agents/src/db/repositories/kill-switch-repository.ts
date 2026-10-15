import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type KillSwitchScope = "global" | "organization" | "agent" | "installation" | "tool";
export interface KillSwitchRecord { id: string; organization_id: string | null; scope_type: KillSwitchScope; scope_id: string; reason: string; enabled: boolean; created_by: string; created_at: string; disabled_at: string | null }

export class KillSwitchRepository {
  public constructor(private readonly pool: Pool) {}

  public async set(input: { organizationId?: string; scopeType: KillSwitchScope; scopeId: string; reason: string; actorId: string }): Promise<KillSwitchRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<KillSwitchRecord>(`INSERT INTO agent_kill_switches (organization_id, scope_type, scope_id, reason, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT ((COALESCE(organization_id, '' )), scope_type, scope_id) WHERE enabled DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now() RETURNING *`, [input.organizationId ?? null, input.scopeType, input.scopeId, input.reason, input.actorId]);
      const record = result.rows[0]!;
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_kill_switch.enabled', 'agent_kill_switch', $3, $4::jsonb)`,
        [input.organizationId ?? null, input.actorId, record.id, JSON.stringify({ scopeType: input.scopeType, scopeId: input.scopeId, reason: input.reason })],
      );
      return record;
    });
  }

  public async disable(organizationId: string | undefined, id: string, actorId?: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<KillSwitchRecord>(
        `UPDATE agent_kill_switches SET enabled = FALSE, disabled_at = now()
         WHERE id = $1 AND enabled AND (organization_id = $2 OR (organization_id IS NULL AND $2::text IS NULL))
         RETURNING *`,
        [id, organizationId ?? null],
      );
      const record = result.rows[0];
      if (!record) throw new Error("Kill switch not found");
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_kill_switch.disabled', 'agent_kill_switch', $3, $4::jsonb)`,
        [record.organization_id, actorId ?? null, record.id, JSON.stringify({ scopeType: record.scope_type, scopeId: record.scope_id, reason: record.reason })],
      );
    });
  }

  public async list(organizationId: string): Promise<KillSwitchRecord[]> {
    const result = await query<KillSwitchRecord>(this.pool, `SELECT * FROM agent_kill_switches WHERE organization_id = $1 OR organization_id IS NULL ORDER BY created_at DESC`, [organizationId]);
    return result.rows;
  }

  public async isBlocked(input: { organizationId: string; agentId: string; installationId: string; toolNames?: string[] }): Promise<boolean> {
    const result = await query<{ blocked: boolean }>(this.pool, `SELECT EXISTS (
      SELECT 1 FROM agent_kill_switches WHERE enabled AND (organization_id IS NULL OR organization_id = $1)
        AND ((scope_type = 'global') OR (scope_type = 'organization' AND scope_id = $1)
          OR (scope_type = 'agent' AND scope_id = $2) OR (scope_type = 'installation' AND scope_id = $3)
          OR (scope_type = 'tool' AND scope_id = ANY($4::text[])))
    ) AS blocked`, [input.organizationId, input.agentId, input.installationId, input.toolNames ?? []]);
    return result.rows[0]?.blocked ?? false;
  }
}
