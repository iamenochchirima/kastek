import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type WorkflowCheckpointStatus = "completed" | "paused" | "failed";

export interface WorkflowCheckpointRecord {
  id: string;
  run_id: string;
  organization_id: string;
  sequence_number: number;
  node_id: string;
  next_node_id: string | null;
  status: WorkflowCheckpointStatus;
  state: Record<string, unknown>;
  output: unknown;
  trace: Array<{ nodeId: string; type: string; status: string }>;
  edge_iterations: Record<string, number>;
  node_iterations: Record<string, number>;
  steps: number;
  usage: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  idempotency_key: string;
  created_at: string;
}

export class WorkflowCheckpointRepository {
  public constructor(private readonly pool: Pool) {}

  public async getLatest(organizationId: string, runId: string): Promise<WorkflowCheckpointRecord | null> {
    const result = await query<WorkflowCheckpointRecord>(
      this.pool,
      `SELECT * FROM run_workflow_checkpoints
       WHERE organization_id = $1 AND run_id = $2
       ORDER BY sequence_number DESC
       LIMIT 1`,
      [organizationId, runId],
    );
    const row = result.rows[0];
    return row ? normalizeCheckpoint(row) : null;
  }

  public async put(input: {
    organizationId: string;
    runId: string;
    nodeId: string;
    nextNodeId?: string;
    status: WorkflowCheckpointStatus;
    state: Record<string, unknown>;
    output?: unknown;
    trace: Array<{ nodeId: string; type: string; status: string }>;
    edgeIterations?: Record<string, number>;
    nodeIterations?: Record<string, number>;
    steps?: number;
    usage: WorkflowCheckpointRecord["usage"];
    idempotencyKey: string;
  }): Promise<WorkflowCheckpointRecord> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<WorkflowCheckpointRecord>(
        `SELECT * FROM run_workflow_checkpoints
         WHERE organization_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [input.organizationId, input.runId, input.idempotencyKey],
      );
      if (existing.rows[0]) return normalizeCheckpoint(existing.rows[0]);
      const run = await client.query<{ id: string }>(
        "SELECT id FROM agent_runs WHERE id = $1 AND organization_id = $2 FOR UPDATE",
        [input.runId, input.organizationId],
      );
      if (!run.rows[0]) throw new Error("Workflow checkpoint run not found");
      const sequence = await client.query<{ sequence_number: string }>(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number
         FROM run_workflow_checkpoints WHERE run_id = $1`,
        [input.runId],
      );
      const result = await client.query<WorkflowCheckpointRecord>(
        `INSERT INTO run_workflow_checkpoints
          (run_id, organization_id, sequence_number, node_id, next_node_id, status, state, output, trace,
           edge_iterations, node_iterations, steps, usage, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14)
         RETURNING *`,
        [
          input.runId,
          input.organizationId,
          Number(sequence.rows[0]?.sequence_number ?? 1),
          input.nodeId,
          input.nextNodeId ?? null,
          input.status,
          JSON.stringify(input.state),
          input.output === undefined ? null : JSON.stringify(input.output),
          JSON.stringify(input.trace),
          JSON.stringify(input.edgeIterations ?? {}),
          JSON.stringify(input.nodeIterations ?? {}),
          input.steps ?? 0,
          JSON.stringify(input.usage),
          input.idempotencyKey,
        ],
      );
      return normalizeCheckpoint(result.rows[0]!);
    });
  }
}

function normalizeCheckpoint(row: WorkflowCheckpointRecord): WorkflowCheckpointRecord {
  return {
    ...row,
    sequence_number: Number(row.sequence_number),
    state: row.state ?? {},
    output: row.output ?? null,
    trace: Array.isArray(row.trace) ? row.trace : [],
    edge_iterations: normalizeCounters(row.edge_iterations),
    node_iterations: normalizeCounters(row.node_iterations),
    steps: Number(row.steps ?? 0),
    usage: {
      modelCalls: Number(row.usage?.modelCalls ?? 0),
      toolCalls: Number(row.usage?.toolCalls ?? 0),
      inputTokens: Number(row.usage?.inputTokens ?? 0),
      outputTokens: Number(row.usage?.outputTokens ?? 0),
      totalTokens: Number(row.usage?.totalTokens ?? 0),
      estimatedCostUsd: Number(row.usage?.estimatedCostUsd ?? 0),
    },
  };
}

function normalizeCounters(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, count]) => typeof count === "number" && Number.isFinite(count) && count >= 0)
    .map(([key, count]) => [key, Math.floor(count as number)]));
}
