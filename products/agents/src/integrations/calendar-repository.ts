import type { Pool } from "pg";
import { query } from "../db/pool";
import type { DatabaseTimestamp } from "../db/timestamps";

export interface InternalCalendarEvent {
  id: string;
  organization_id: string;
  installation_id: string;
  title: string;
  description: string;
  start_at: DatabaseTimestamp;
  end_at: DatabaseTimestamp;
  timezone: string;
  location: string;
  attendees: string[];
  status: "active" | "cancelled";
  created_by: string;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

export class CalendarRepository {
  public constructor(private readonly pool: Pool) {}

  public async list(input: { organizationId: string; installationId: string; start?: string; end?: string; limit?: number }): Promise<InternalCalendarEvent[]> {
    const result = await query<InternalCalendarEvent>(this.pool, `
      SELECT id, organization_id, installation_id, title, description, start_at, end_at, timezone, location, attendees, status, created_by, created_at, updated_at
      FROM internal_calendar_events
      WHERE organization_id = $1 AND installation_id = $2 AND status = 'active'
        AND ($3::timestamptz IS NULL OR end_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR start_at <= $4::timestamptz)
      ORDER BY start_at ASC LIMIT $5`, [input.organizationId, input.installationId, input.start ?? null, input.end ?? null, Math.max(1, Math.min(input.limit ?? 50, 200))]);
    return result.rows;
  }

  public async create(input: { organizationId: string; installationId: string; title: string; description?: string; start: string; end: string; timezone?: string; location?: string; attendees?: string[]; idempotencyKey?: string; createdBy: string }): Promise<InternalCalendarEvent> {
    const result = await query<InternalCalendarEvent>(this.pool, `
      INSERT INTO internal_calendar_events
        (organization_id, installation_id, title, description, start_at, end_at, timezone, location, attendees, idempotency_key, created_by)
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9::jsonb, $10, $11)
      ON CONFLICT (installation_id, idempotency_key) DO UPDATE SET updated_at = internal_calendar_events.updated_at
      RETURNING id, organization_id, installation_id, title, description, start_at, end_at, timezone, location, attendees, status, created_by, created_at, updated_at`, [input.organizationId, input.installationId, input.title.trim(), input.description?.trim() ?? "", input.start, input.end, input.timezone?.trim() || "UTC", input.location?.trim() ?? "", JSON.stringify(input.attendees ?? []), input.idempotencyKey ?? null, input.createdBy]);
    return result.rows[0]!;
  }

  public async update(input: { organizationId: string; installationId: string; eventId: string; title?: string; description?: string; start?: string; end?: string; timezone?: string; location?: string; attendees?: string[] }): Promise<InternalCalendarEvent> {
    const result = await query<InternalCalendarEvent>(this.pool, `
      UPDATE internal_calendar_events SET
        title = COALESCE($4, title), description = COALESCE($5, description),
        start_at = COALESCE($6::timestamptz, start_at), end_at = COALESCE($7::timestamptz, end_at),
        timezone = COALESCE($8, timezone), location = COALESCE($9, location),
        attendees = COALESCE($10::jsonb, attendees), updated_at = now()
      WHERE id = $1 AND organization_id = $2 AND installation_id = $3 AND status = 'active'
      RETURNING id, organization_id, installation_id, title, description, start_at, end_at, timezone, location, attendees, status, created_by, created_at, updated_at`, [input.eventId, input.organizationId, input.installationId, input.title?.trim() ?? null, input.description?.trim() ?? null, input.start ?? null, input.end ?? null, input.timezone?.trim() ?? null, input.location?.trim() ?? null, input.attendees ? JSON.stringify(input.attendees) : null]);
    if (!result.rows[0]) throw new Error("Calendar event not found");
    return result.rows[0];
  }

  public async cancel(input: { organizationId: string; installationId: string; eventId: string }): Promise<void> {
    const result = await query(this.pool, `UPDATE internal_calendar_events SET status = 'cancelled', updated_at = now() WHERE id = $1 AND organization_id = $2 AND installation_id = $3 AND status = 'active'`, [input.eventId, input.organizationId, input.installationId]);
    if (!result.rowCount) throw new Error("Calendar event not found");
  }
}
