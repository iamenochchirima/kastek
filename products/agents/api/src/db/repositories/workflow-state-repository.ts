import type { Pool } from "pg";
import { query } from "../pool";

export interface WorkflowStateRecord {
  run_id: string;
  organization_id: string;
  state: Record<string, unknown>;
  revision: number;
  updated_at: string;
}

export class WorkflowStateRepository {
  public constructor(private readonly pool: Pool) {}

  public async get(organizationId: string, runId: string): Promise<WorkflowStateRecord | null> {
    const result = await query<WorkflowStateRecord>(this.pool, "SELECT * FROM run_workflow_state WHERE organization_id = $1 AND run_id = $2", [organizationId, runId]);
    const row = result.rows[0];
    return row ? { ...row, revision: Number(row.revision) } : null;
  }

  public async put(input: {
    organizationId: string;
    runId: string;
    state: Record<string, unknown>;
    expectedRevision?: number;
  }): Promise<WorkflowStateRecord> {
    const result = await query<WorkflowStateRecord>(
      this.pool,
      `INSERT INTO run_workflow_state (run_id, organization_id, state, revision)
       VALUES ($1, $2, $3::jsonb, 0)
       ON CONFLICT (run_id) DO UPDATE SET
         state = EXCLUDED.state, revision = run_workflow_state.revision + 1, updated_at = now()
       WHERE run_workflow_state.organization_id = $2
         AND ($4::bigint IS NULL OR run_workflow_state.revision = $4)
       RETURNING *`,
      [input.runId, input.organizationId, JSON.stringify(input.state), input.expectedRevision ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Workflow state revision conflict or run not found");
    return { ...row, revision: Number(row.revision) };
  }
}
