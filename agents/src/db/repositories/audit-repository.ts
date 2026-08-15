import type { Pool } from "pg";
import { query } from "../pool";

export interface AuditRecord {
  id: string;
  organization_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  correlation_id: string | null;
  execution_mode: "system_hosted" | "kasitek_hosted" | "external_connected" | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class AuditRepository {
  public constructor(private readonly pool: Pool) {}

  public async list(input: { organizationId: string; action?: string; resourceType?: string; limit?: number }): Promise<AuditRecord[]> {
    const result = await query<AuditRecord>(
      this.pool,
      `SELECT * FROM audit_records
       WHERE organization_id = $1
         AND ($2::text IS NULL OR action = $2)
         AND ($3::text IS NULL OR resource_type = $3)
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [input.organizationId, input.action ?? null, input.resourceType ?? null, Math.max(1, Math.min(input.limit ?? 100, 500))],
    );
    return result.rows;
  }
}
