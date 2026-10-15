import type { Pool, PoolClient } from "pg";
import {
  buildToolInvocationLifecycleEvent,
  classifyAgentFailure,
  enqueueOutbox,
  type ToolInvocationAnalyticsInput,
} from "../../analytics";
import { ToolPolicyError, type ToolInvocationResult } from "../../tools/types";
import { query, withTransaction } from "../pool";

export interface ToolProposalRecord {
  organizationId: string;
  runId: string;
  providerToolCallId: string;
  runtimeOperationId?: string;
  sequenceNumber: number;
  toolName: string;
  toolVersion: string;
  riskClass: string;
  argumentsHash: string;
  arguments: Record<string, unknown>;
  requiresApproval: boolean;
  batchId?: string;
  segmentId?: string;
}

type ToolInvocationStatus = ToolInvocationAnalyticsInput["status"];

interface PersistedToolInvocation {
  id: string;
  organization_id: string;
  run_id: string;
  provider_tool_call_id: string;
  runtime_operation_id: string;
  sequence_number: number;
  tool_name: string;
  tool_version: string;
  risk_class: ToolInvocationAnalyticsInput["riskClass"];
  arguments_hash: string;
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

  public async evidenceForRun(organizationId: string, runId: string): Promise<Array<{ tool_name: string; status: ToolInvocationStatus }>> {
    const result = await query<{ tool_name: string; status: ToolInvocationStatus }>(this.pool,
      `SELECT tool_name, status FROM tool_invocations
       WHERE organization_id = $1 AND run_id = $2
         AND status IN ('completed', 'failed', 'unknown')
       ORDER BY sequence_number, id`,
      [organizationId, runId]);
    return result.rows;
  }

  public async recordProposal(input: ToolProposalRecord): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ provider_tool_call_id: string }>(
      `INSERT INTO tool_invocations
          (organization_id, run_id, provider_tool_call_id, runtime_operation_id, sequence_number, tool_name,
           tool_version, risk_class, arguments_hash, arguments, status, batch_id, segment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
           CASE WHEN $11::boolean THEN 'awaiting_approval' ELSE 'proposed' END, $12, $13)
         ON CONFLICT (run_id, runtime_operation_id) DO NOTHING
         RETURNING provider_tool_call_id`,
        [
          input.organizationId,
          input.runId,
          input.providerToolCallId,
          input.runtimeOperationId ?? input.providerToolCallId,
          input.sequenceNumber,
          input.toolName,
          input.toolVersion,
          input.riskClass,
          input.argumentsHash,
          JSON.stringify(input.arguments),
          input.requiresApproval,
          input.batchId ?? null,
          input.segmentId ?? null,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await this.getPersisted(client, input.organizationId, input.runId, input.runtimeOperationId ?? input.providerToolCallId);
        if (
          existing.tool_name !== input.toolName
          || existing.tool_version !== input.toolVersion
          || existing.risk_class !== input.riskClass
          || existing.arguments_hash !== input.argumentsHash
        ) {
          throw new ToolPolicyError(
            "TOOL_INVOCATION_IDENTITY_CONFLICT",
            "A durable tool operation was reused with different invocation metadata",
          );
        }
        // Proposal evidence is immutable. Re-entry after an approval wait or a
        // worker retry must not emit a second proposal event.
        return;
      }
      const row = await this.getPersisted(client, input.organizationId, input.runId, input.runtimeOperationId ?? input.providerToolCallId);
      await enqueueOutbox(client, buildToolInvocationLifecycleEvent(this.analyticsInput(row, "proposed", null, input.requiresApproval)));
    });
  }

  public async recordActivityIdentity(input: {
    runId: string;
    runtimeOperationId: string;
    batchId?: string;
    segmentId?: string;
    temporalActivityId?: string;
  }): Promise<void> {
    const result = await query(
      this.pool,
      `UPDATE tool_invocations
       SET batch_id = COALESCE(batch_id, $3),
           segment_id = COALESCE(segment_id, $4),
           temporal_activity_id = COALESCE(temporal_activity_id, $5)
      WHERE run_id = $1 AND runtime_operation_id = $2`,
      [input.runId, input.runtimeOperationId, input.batchId ?? null, input.segmentId ?? null, input.temporalActivityId ?? null],
    );
    if (!result.rowCount) throw new Error("TOOL_INVOCATION_NOT_FOUND");
  }

  public async recordCompleted(input: {
    runId: string;
    providerToolCallId: string;
    runtimeOperationId?: string;
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
         WHERE run_id = $1 AND runtime_operation_id = COALESCE($2, provider_tool_call_id)`,
        [input.runId, input.runtimeOperationId ?? input.providerToolCallId, JSON.stringify(input.output), input.latencyMs, input.effectId ?? null],
      );
      if (!result.rowCount) throw new Error("TOOL_INVOCATION_NOT_FOUND");
      const row = await this.getPersisted(client, undefined, input.runId, input.runtimeOperationId ?? input.providerToolCallId);
      await enqueueOutbox(client, buildToolInvocationLifecycleEvent(this.analyticsInput(row, "completed")));
    });
  }

  public async recordFailed(input: { runId: string; providerToolCallId: string; runtimeOperationId?: string; error: Record<string, unknown>; status?: "failed" | "unknown" }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE tool_invocations
         SET status = $3, error = $4::jsonb, started_at = COALESCE(started_at, created_at), finished_at = now()
         WHERE run_id = $1 AND runtime_operation_id = COALESCE($2, provider_tool_call_id)`,
        [input.runId, input.runtimeOperationId ?? input.providerToolCallId, input.status ?? "failed", JSON.stringify(input.error)],
      );
      if (!result.rowCount) throw new Error("TOOL_INVOCATION_NOT_FOUND");
      const row = await this.getPersisted(client, undefined, input.runId, input.runtimeOperationId ?? input.providerToolCallId);
      await enqueueOutbox(client, buildToolInvocationLifecycleEvent(this.analyticsInput(row, "failed", classifyAgentFailure(input.error))));
    });
  }

  public async getCompleted(input: {
    organizationId: string;
    runId: string;
    providerToolCallId: string;
    runtimeOperationId?: string;
    toolName: string;
    argumentsHash: string;
  }): Promise<ToolInvocationResult | null> {
    const result = await query<{
      tool_name: string;
      tool_version: string;
      arguments_hash: string;
      status: ToolInvocationStatus;
      output: unknown;
      latency_ms: number | string | null;
      effect_id: string | null;
    }>(
      this.pool,
      `SELECT tool_name, tool_version, arguments_hash, status, output, latency_ms, effect_id
       FROM tool_invocations
       WHERE organization_id = $1 AND run_id = $2 AND runtime_operation_id = COALESCE($3, provider_tool_call_id)
       LIMIT 1`,
      [input.organizationId, input.runId, input.runtimeOperationId ?? input.providerToolCallId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.tool_name !== input.toolName || row.arguments_hash !== input.argumentsHash) {
      throw new ToolPolicyError("TOOL_REPLAY_SCOPE_CONFLICT", "A durable tool outcome did not match the requested tool call");
    }
    if (row.status !== "completed") return null;
    const outputRecord = row.output && typeof row.output === "object" && !Array.isArray(row.output)
      ? row.output as Record<string, unknown>
      : undefined;
    const control = outputRecord && (outputRecord.control === "awaiting_human" || outputRecord.control === "final_response")
      ? outputRecord.control
      : undefined;
    return {
      name: row.tool_name,
      version: row.tool_version,
      argumentsHash: row.arguments_hash,
      output: row.output,
      ...(control ? { control } : {}),
      ...(row.effect_id ? { effectId: row.effect_id } : {}),
      latencyMs: Number(row.latency_ms ?? 0),
    };
  }

  private async getPersisted(client: PoolClient, organizationId: string | undefined, runId: string, runtimeOperationId: string): Promise<PersistedToolInvocation> {
    const result = await client.query<PersistedToolInvocation>(
      `SELECT ti.id, ti.organization_id, ti.run_id, ti.provider_tool_call_id, ti.runtime_operation_id, ti.sequence_number,
              ti.tool_name, ti.tool_version, ti.risk_class, ti.arguments_hash, ti.status, ti.latency_ms, ti.effect_id,
              EXISTS (SELECT 1 FROM agent_approval_records aar
                      WHERE aar.run_id = ti.run_id AND aar.runtime_operation_id = ti.runtime_operation_id) AS requires_approval,
              ti.created_at, ti.finished_at, ar.agent_definition_id, ar.agent_version_id,
              ar.installation_id, ar.correlation_id
       FROM tool_invocations ti
       JOIN agent_runs ar ON ar.id = ti.run_id
       WHERE ti.run_id = $1 AND ti.runtime_operation_id = $2
         AND ($3::text IS NULL OR ti.organization_id = $3)
       FOR UPDATE OF ti`,
      [runId, runtimeOperationId, organizationId ?? null],
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

  public async getProposal(organizationId: string, runId: string, providerToolCallId: string, runtimeOperationId?: string): Promise<ToolProposalRecord | null> {
    const result = await query<ToolProposalRecord>(
      this.pool,
      `SELECT organization_id AS "organizationId", run_id AS "runId",
              provider_tool_call_id AS "providerToolCallId", runtime_operation_id AS "runtimeOperationId", sequence_number AS "sequenceNumber",
              tool_name AS "toolName", tool_version AS "toolVersion", risk_class AS "riskClass",
              arguments_hash AS "argumentsHash", arguments, (status = 'awaiting_approval') AS "requiresApproval"
       FROM tool_invocations
       WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3
         AND runtime_operation_id = COALESCE($4, runtime_operation_id)
       LIMIT 1`,
      [organizationId, runId, providerToolCallId, runtimeOperationId ?? null],
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
