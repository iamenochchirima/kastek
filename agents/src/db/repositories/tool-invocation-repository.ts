import type { Pool } from "pg";
import { query } from "../pool";

export interface ToolProposalRecord {
  organizationId: string;
  runId: string;
  providerToolCallId: string;
  sequenceNumber: number;
  toolName: string;
  toolVersion: string;
  riskClass: string;
  argumentsHash: string;
  arguments: Record<string, unknown>;
  requiresApproval: boolean;
}

export class ToolInvocationRepository {
  public constructor(private readonly pool: Pool) {}

  public async recordProposal(input: ToolProposalRecord): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO tool_invocations
        (organization_id, run_id, provider_tool_call_id, sequence_number, tool_name,
         tool_version, risk_class, arguments_hash, arguments, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
         CASE WHEN $10::boolean THEN 'awaiting_approval' ELSE 'proposed' END)
       ON CONFLICT (run_id, provider_tool_call_id) DO UPDATE SET
         arguments_hash = EXCLUDED.arguments_hash,
         arguments = EXCLUDED.arguments,
         status = CASE
           WHEN tool_invocations.status IN ('completed', 'failed') THEN tool_invocations.status
           ELSE EXCLUDED.status
         END`,
      [
        input.organizationId,
        input.runId,
        input.providerToolCallId,
        input.sequenceNumber,
        input.toolName,
        input.toolVersion,
        input.riskClass,
        input.argumentsHash,
        JSON.stringify(input.arguments),
        input.requiresApproval,
      ],
    );
  }

  public async recordCompleted(input: {
    runId: string;
    providerToolCallId: string;
    output: unknown;
    latencyMs: number;
    effectId?: string;
    approval?: unknown;
  }): Promise<void> {
    await query(
      this.pool,
      `UPDATE tool_invocations
       SET status = 'completed', output = $3::jsonb, latency_ms = $4,
           effect_id = $5, approval = COALESCE($6::jsonb, approval),
           started_at = COALESCE(started_at, created_at), finished_at = now()
       WHERE run_id = $1 AND provider_tool_call_id = $2`,
      [input.runId, input.providerToolCallId, JSON.stringify(input.output), input.latencyMs, input.effectId ?? null, input.approval ? JSON.stringify(input.approval) : null],
    );
  }

  public async recordFailed(input: { runId: string; providerToolCallId: string; error: Record<string, unknown> }): Promise<void> {
    await query(
      this.pool,
      `UPDATE tool_invocations
       SET status = 'failed', error = $3::jsonb, started_at = COALESCE(started_at, created_at), finished_at = now()
       WHERE run_id = $1 AND provider_tool_call_id = $2`,
      [input.runId, input.providerToolCallId, JSON.stringify(input.error)],
    );
  }

  public async recordApprovalDecision(input: {
    runId: string;
    providerToolCallId: string;
    decision: "approved" | "rejected";
    approval: unknown;
  }): Promise<void> {
    const approval = input.approval as { argumentsHash?: string; expiresAt?: string };
    if (!approval.argumentsHash || !approval.expiresAt) throw new Error("Approval must include arguments hash and expiry");
    if (new Date(approval.expiresAt).getTime() <= Date.now()) throw new Error("Approval has expired");
    const result = await query(
      this.pool,
      `UPDATE tool_invocations
       SET status = $3, approval = $4::jsonb
       WHERE run_id = $1 AND provider_tool_call_id = $2 AND status = 'awaiting_approval'
         AND arguments_hash = $5`,
      [input.runId, input.providerToolCallId, input.decision, JSON.stringify(input.approval), approval.argumentsHash],
    );
    if (!result.rowCount) throw new Error("Approval action is stale, mutated, or not awaiting approval");
  }

  public async list(organizationId: string, runId: string): Promise<Array<Record<string, unknown>>> {
    const result = await query(
      this.pool,
      `SELECT * FROM tool_invocations
       WHERE organization_id = $1 AND run_id = $2
       ORDER BY sequence_number ASC, created_at ASC`,
      [organizationId, runId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  public async outcomeSummary(organizationId: string): Promise<Array<{ status: string; count: number }>> {
    const result = await query<{ status: string; count: string }>(
      this.pool,
      `SELECT status, COUNT(*)::text AS count FROM tool_invocations
       WHERE organization_id = $1 GROUP BY status ORDER BY status`,
      [organizationId],
    );
    return result.rows.map((row) => ({ status: row.status, count: Number(row.count) }));
  }
}
