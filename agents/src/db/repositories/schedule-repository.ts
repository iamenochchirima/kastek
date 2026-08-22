import type { Pool, PoolClient } from "pg";
import { buildScheduleLifecycleEvent, enqueueOutbox, type ScheduleAnalyticsInput } from "../../analytics";
import { query, withTransaction } from "../pool";

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

interface ScheduleAnalyticsRow extends ScheduleRecord {
  agent_definition_id: string;
  agent_version_id: string;
}

export class ScheduleRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: { organizationId: string; installationId: string; expression: string; timezone?: string; scheduleInput?: Record<string, unknown>; nextRunAt?: string; actorId: string }): Promise<ScheduleRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<ScheduleRecord>(
        `INSERT INTO agent_schedules (organization_id, installation_id, expression, timezone, input, next_run_at, created_by)
         SELECT $1, id, $3, $4, $5::jsonb, $6, $7 FROM agent_installations
         WHERE id = $2 AND organization_id = $1 AND status = 'active'
           AND execution_mode IN ('system_hosted', 'kasitek_hosted') RETURNING *`,
        [input.organizationId, input.installationId, input.expression, input.timezone ?? "UTC", JSON.stringify(input.scheduleInput ?? {}), input.nextRunAt ?? null, input.actorId],
      );
      const schedule = result.rows[0];
      if (!schedule) throw new Error("Active installation not found");
      const analyticsRow = await this.getAnalyticsRow(client, schedule.id);
      await enqueueOutbox(client, buildScheduleLifecycleEvent(this.analyticsInput(analyticsRow, "created", null, "human", schedule.created_at)));
      return schedule;
    });
  }

  public async list(organizationId: string, installationId?: string): Promise<ScheduleRecord[]> {
    const result = await query<ScheduleRecord>(this.pool, `SELECT * FROM agent_schedules WHERE organization_id = $1 AND ($2::uuid IS NULL OR installation_id = $2) ORDER BY created_at DESC`, [organizationId, installationId ?? null]);
    return result.rows;
  }

  public async setStatus(organizationId: string, scheduleId: string, status: ScheduleRecord["status"], actorId: string): Promise<ScheduleRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<ScheduleRecord>(
        `SELECT schedules.* FROM agent_schedules schedules
         JOIN agent_installations installations ON installations.id = schedules.installation_id
         WHERE schedules.organization_id = $1 AND schedules.id = $2
           AND installations.execution_mode IN ('system_hosted', 'kasitek_hosted')
         FOR UPDATE`,
        [organizationId, scheduleId],
      );
      const previous = current.rows[0];
      if (!previous) throw new Error("Schedule not found");
      const result = await client.query<ScheduleRecord>(
        `UPDATE agent_schedules SET status = $3, updated_at = now()
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [organizationId, scheduleId, status],
      );
      const schedule = result.rows[0];
      if (!schedule) throw new Error("Schedule not found");
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, $3, 'agent_schedule', $4, '{}'::jsonb)`,
        [organizationId, actorId, `agent_schedule.${status}`, scheduleId],
      );
      if (previous.status !== status) {
        const analyticsRow = await this.getAnalyticsRow(client, schedule.id);
        await enqueueOutbox(client, buildScheduleLifecycleEvent(this.analyticsInput(analyticsRow, status === "active" ? "activated" : status, previous.status, "human", schedule.updated_at)));
      }
      return schedule;
    });
  }

  private async getAnalyticsRow(client: PoolClient, scheduleId: string): Promise<ScheduleAnalyticsRow> {
    const result = await client.query<ScheduleAnalyticsRow>(
      `SELECT schedules.*, installations.agent_definition_id, installations.agent_version_id
       FROM agent_schedules schedules
       JOIN agent_installations installations ON installations.id = schedules.installation_id
       WHERE schedules.id = $1`,
      [scheduleId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Schedule not found");
    return row;
  }

  private analyticsInput(
    row: ScheduleAnalyticsRow,
    action: ScheduleAnalyticsInput["action"],
    previousStatus: ScheduleAnalyticsInput["previousStatus"],
    actorType: ScheduleAnalyticsInput["actorType"],
    occurredAt: Date | string,
  ): ScheduleAnalyticsInput {
    return {
      scheduleId: row.id,
      organizationId: row.organization_id,
      agentDefinitionId: row.agent_definition_id,
      agentVersionId: row.agent_version_id,
      installationId: row.installation_id,
      action,
      status: row.status,
      previousStatus,
      timezone: row.timezone,
      nextRunAt: row.next_run_at,
      actorType,
      occurredAt,
    };
  }
}
