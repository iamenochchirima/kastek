import type { Pool } from "pg";
import { query } from "../pool";

export type KillSwitchScope = "global" | "organization" | "agent" | "installation" | "tool";
export interface KillSwitchRecord { id: string; organization_id: string | null; scope_type: KillSwitchScope; scope_id: string; reason: string; enabled: boolean; created_by: string; created_at: string; disabled_at: string | null }

export class KillSwitchRepository {
  public constructor(private readonly pool: Pool) {}

  public async set(input: { organizationId?: string; scopeType: KillSwitchScope; scopeId: string; reason: string; actorId: string }): Promise<KillSwitchRecord> {
    const result = await query<KillSwitchRecord>(this.pool, `INSERT INTO agent_kill_switches (organization_id, scope_type, scope_id, reason, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT ((COALESCE(organization_id, '' )), scope_type, scope_id) WHERE enabled DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now() RETURNING *`, [input.organizationId ?? null, input.scopeType, input.scopeId, input.reason, input.actorId]);
    return result.rows[0]!;
  }

  public async disable(organizationId: string | undefined, id: string): Promise<void> {
    const result = await query(this.pool, `UPDATE agent_kill_switches SET enabled = FALSE, disabled_at = now() WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND enabled`, [id, organizationId ?? null]);
    if (!result.rowCount) throw new Error("Kill switch not found");
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
