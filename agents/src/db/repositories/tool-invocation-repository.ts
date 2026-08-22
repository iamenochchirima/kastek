import type { Pool, PoolClient } from "pg";
import {
  buildToolInvocationLifecycleEvent,
  classifyAgentFailure,
  enqueueOutbox,
  type ToolInvocationAnalyticsInput,
} from "../../analytics";
import { query, withTransaction } from "../pool";

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

type ToolInvocationStatus = ToolInvocationAnalyticsInput["status"];

interface PersistedToolInvocation {
  id: string;
  organization_id: string;
  run_id: string;
  provider_tool_call_id: string;
  sequence_number: number;
  tool_name: string;
  tool_version: string;
  risk_class: ToolInvocationAnalyticsInput["riskClass"];
  status: ToolInvocationStatus;
  latency_ms: number | null;
  effect_id: string | null;
  requires_approval: boolean;
  created_at: Date | string;
  finished_at: Date | string | null;
  agent_definition_id: string;
  agent_version_id: string;
  installation_id: string;
  correlation_id: string | null;
}

export class ToolInvocationRepository {
  public constructor(private readonly pool: Pool) {}

  public async recordProposal(input: ToolProposalRecord): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
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
      const row = await this.getPersisted(client, input.organizationId, input.runId, input.providerToolCallId);
      await enqueueOutbox(client, buildToolInvocationLifecycleEvent(this.analyticsInput(row, "proposed", null, input.requiresApproval)));
    });
  }

  public async recordCompleted(input: {
    runId: string;
    providerToolCallId: string;
    output: unknown;
    latencyMs: number;
    effectId?: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE tool_invocations
         SET status = 'completed', output = $3::jsonb, latency_ms = $4,
             effect_id = $5,
             started_at = COALESCE(started_at, created_at), finished_at = now()
         WHERE run_id = $1 AND provider_tool_call_id = $2`,
        [input.runId, input.providerToolCallId, JSON.stringify(input.output), input.latencyMs, input.effectId ?? null],
      );
      if (!result.rowCount) throw new Error("TOOL_INVOCATION_NOT_FOUND");
      const row = await this.getPersisted(client, undefined, input.runId, input.providerToolCallId);
      await enqueueOutbox(client, buildToolInvocationLifecycleEvent(this.analyticsInput(row, "completed")));
    });
  }

  public async recordFailed(input: { runId: string; providerToolCallId: string; error: Record<string, unknown> }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE tool_invocations
         SET status = 'failed', error = $3::jsonb, started_at = COALESCE(started_at, created_at), finished_at = now()
         WHERE run_id = $1 AND provider_tool_call_id = $2`,
        [input.runId, input.providerToolCallId, JSON.stringify(input.error)],
      );
      if (!result.rowCount) throw new Error("TOOL_INVOCATION_NOT_FOUND");
      const row = await this.getPersisted(client, undefined, input.runId, input.providerToolCallId);
      await enqueueOutbox(client, buildToolInvocationLifecycleEvent(this.analyticsInput(row, "failed", classifyAgentFailure(input.error))));
    });
  }

  private async getPersisted(client: PoolClient, organizationId: string | undefined, runId: string, providerToolCallId: string): Promise<PersistedToolInvocation> {
    const result = await client.query<PersistedToolInvocation>(
      `SELECT ti.id, ti.organization_id, ti.run_id, ti.provider_tool_call_id, ti.sequence_number,
              ti.tool_name, ti.tool_version, ti.risk_class, ti.status, ti.latency_ms, ti.effect_id,
              EXISTS (SELECT 1 FROM agent_approval_records aar
                      WHERE aar.run_id = ti.run_id AND aar.provider_tool_call_id = ti.provider_tool_call_id) AS requires_approval,
              ti.created_at, ti.finished_at, ar.agent_definition_id, ar.agent_version_id,
              ar.installation_id, ar.correlation_id
       FROM tool_invocations ti
       JOIN agent_runs ar ON ar.id = ti.run_id
       WHERE ti.run_id = $1 AND ti.provider_tool_call_id = $2
         AND ($3::text IS NULL OR ti.organization_id = $3)
       FOR UPDATE OF ti`,
      [runId, providerToolCallId, organizationId ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("TOOL_INVOCATION_NOT_FOUND");
    return row;
  }

  private analyticsInput(
    row: PersistedToolInvocation,
    action: ToolInvocationAnalyticsInput["action"],
    failureClass: ToolInvocationAnalyticsInput["failureClass"] = null,
    requiresApproval = row.requires_approval,
  ): ToolInvocationAnalyticsInput {
    return {
      organizationId: row.organization_id,
      runId: row.run_id,
      agentDefinitionId: row.agent_definition_id,
      agentVersionId: row.agent_version_id,
      installationId: row.installation_id,
      correlationId: row.correlation_id,
      toolInvocationId: row.id,
      providerToolCallId: row.provider_tool_call_id,
      toolName: row.tool_name,
      toolVersion: row.tool_version,
      riskClass: row.risk_class,
      action,
      status: row.status,
      sequenceNumber: row.sequence_number,
      requiresApproval,
      latencyMs: row.latency_ms,
      effectId: row.effect_id,
      failureClass,
      occurredAt: action === "proposed" ? row.created_at : row.finished_at ?? row.created_at,
    };
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

  public async getProposal(organizationId: string, runId: string, providerToolCallId: string): Promise<ToolProposalRecord | null> {
    const result = await query<ToolProposalRecord>(
      this.pool,
      `SELECT organization_id AS "organizationId", run_id AS "runId",
              provider_tool_call_id AS "providerToolCallId", sequence_number AS "sequenceNumber",
              tool_name AS "toolName", tool_version AS "toolVersion", risk_class AS "riskClass",
              arguments_hash AS "argumentsHash", arguments, (status = 'awaiting_approval') AS "requiresApproval"
       FROM tool_invocations
       WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3
       LIMIT 1`,
      [organizationId, runId, providerToolCallId],
    );
    return result.rows[0] ?? null;
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
