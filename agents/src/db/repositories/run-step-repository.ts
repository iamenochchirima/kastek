import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type RunStepType = "context" | "retrieval" | "model" | "policy" | "approval" | "tool" | "delivery" | "system";
export type RunStepStatus = "started" | "completed" | "failed" | "skipped";

export interface RunStepRecord {
  id: string;
  run_id: string;
  organization_id: string;
  sequence_number: number;
  step_type: RunStepType;
  status: RunStepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
}

export class RunStepRepository {
  public constructor(private readonly pool: Pool) {}

  public async startStep(input: {
    runId: string;
    organizationId: string;
    stepType: RunStepType;
    input?: Record<string, unknown>;
  }): Promise<RunStepRecord> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE", [input.runId]);
      const next = await client.query<{ sequence_number: number }>(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number
         FROM run_steps WHERE run_id = $1`,
        [input.runId],
      );
      const sequenceNumber = Number(next.rows[0]?.sequence_number ?? 1);
      const result = await client.query<RunStepRecord>(
        `INSERT INTO run_steps
          (run_id, organization_id, sequence_number, step_type, status, input)
         VALUES ($1, $2, $3, $4, 'started', $5::jsonb)
         RETURNING *`,
        [input.runId, input.organizationId, sequenceNumber, input.stepType, JSON.stringify(input.input ?? {})],
      );
      return result.rows[0]!;
    });
  }

  public async finishStep(input: {
    stepId: string;
    status: Exclude<RunStepStatus, "started">;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
  }): Promise<void> {
    await query(
      this.pool,
      `UPDATE run_steps
       SET status = $2, output = $3::jsonb, error = $4::jsonb, finished_at = now()
       WHERE id = $1 AND status = 'started'`,
      [input.stepId, input.status, input.output ? JSON.stringify(input.output) : null, input.error ? JSON.stringify(input.error) : null],
    );
  }

  public async listSteps(organizationId: string, runId: string): Promise<RunStepRecord[]> {
    const result = await query<RunStepRecord>(
      this.pool,
      `SELECT * FROM run_steps
       WHERE organization_id = $1 AND run_id = $2
       ORDER BY sequence_number ASC`,
      [organizationId, runId],
    );
    return result.rows;
  }
}
