import type { Pool } from "pg";
import { query } from "../pool";

export interface ScheduleRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  expression: string;
  timezone: string;
  input: Record<string, unknown>;
  status: "active" | "paused" | "disabled";
  next_run_at: string | null;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class ScheduleRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: { organizationId: string; installationId: string; expression: string; timezone?: string; scheduleInput?: Record<string, unknown>; nextRunAt?: string; actorId: string }): Promise<ScheduleRecord> {
    const result = await query<ScheduleRecord>(
      this.pool,
      `INSERT INTO agent_schedules (organization_id, installation_id, expression, timezone, input, next_run_at, created_by)
       SELECT $1, id, $3, $4, $5::jsonb, $6, $7 FROM agent_installations
       WHERE id = $2 AND organization_id = $1 AND status = 'active' RETURNING *`,
      [input.organizationId, input.installationId, input.expression, input.timezone ?? "UTC", JSON.stringify(input.scheduleInput ?? {}), input.nextRunAt ?? null, input.actorId],
    );
    if (!result.rows[0]) throw new Error("Active installation not found");
    return result.rows[0];
  }

  public async list(organizationId: string, installationId?: string): Promise<ScheduleRecord[]> {
    const result = await query<ScheduleRecord>(this.pool, `SELECT * FROM agent_schedules WHERE organization_id = $1 AND ($2::uuid IS NULL OR installation_id = $2) ORDER BY created_at DESC`, [organizationId, installationId ?? null]);
    return result.rows;
  }

  public async setStatus(organizationId: string, scheduleId: string, status: ScheduleRecord["status"], actorId: string): Promise<ScheduleRecord> {
    const result = await query<ScheduleRecord>(this.pool, `UPDATE agent_schedules SET status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`, [organizationId, scheduleId, status]);
    if (!result.rows[0]) throw new Error("Schedule not found");
    await query(this.pool, `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata) VALUES ($1, 'human', $2, $3, 'agent_schedule', $4, '{}'::jsonb)`, [organizationId, actorId, `agent_schedule.${status}`, scheduleId]);
    return result.rows[0];
  }
}
