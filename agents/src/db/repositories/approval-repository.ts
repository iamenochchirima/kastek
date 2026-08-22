import type { Pool, PoolClient } from "pg";
import {
  buildApprovalLifecycleEvent,
  buildEffectLifecycleEvent,
  enqueueOutbox,
  type ApprovalAnalyticsInput,
  type EffectAnalyticsInput,
} from "../../analytics";
import { query, withTransaction } from "../pool";

export interface ApprovalRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
  provider_tool_call_id: string;
  capability: string;
  capability_version: string;
  arguments_hash: string;
  resource_snapshot: Record<string, unknown>;
  preview_revision: string;
  approved_by: string | null;
  policy_revision: string;
  permitted_effect_key: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "cancelled";
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  consumed_at: string | null;
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord;
  /** True only for the request that atomically moved pending state to a decision. */
  accepted: boolean;
}

interface ApprovalAnalyticsRow extends ApprovalRecord {
  agent_definition_id: string;
  agent_version_id: string;
  correlation_id: string | null;
}

interface EffectAnalyticsRow {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
  provider_tool_call_id: string;
  capability: string;
  capability_version: string;
  status: EffectAnalyticsInput["status"];
  reconciliation_required: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  agent_definition_id: string;
  agent_version_id: string;
  correlation_id: string | null;
}

export class ApprovalRepository {
  public constructor(private readonly pool: Pool) {}

  public async getById(organizationId: string, approvalId: string): Promise<ApprovalRecord | null> {
    const result = await query<ApprovalRecord>(
      this.pool,
      `SELECT * FROM agent_approval_records WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, approvalId],
    );
    return result.rows[0] ?? null;
  }

  public async getForRun(organizationId: string, runId: string): Promise<ApprovalRecord | null> {
    const result = await query<ApprovalRecord>(
      this.pool,
      `SELECT * FROM agent_approval_records
       WHERE organization_id = $1 AND run_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId, runId],
    );
    return result.rows[0] ?? null;
  }

  public async createPending(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    capability: string;
    capabilityVersion: string;
    argumentsHash: string;
    resourceSnapshot: Record<string, unknown>;
    previewRevision: string;
    policyRevision: string;
    permittedEffectKey: string;
    expiresAt: string;
  }): Promise<ApprovalRecord> {
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new Error("Approval expiry must be in the future");
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<ApprovalRecord>(
        `INSERT INTO agent_approval_records
          (organization_id, installation_id, run_id, provider_tool_call_id, capability,
           capability_version, arguments_hash, resource_snapshot, preview_revision,
           policy_revision, permitted_effect_key, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'pending',$12)
         ON CONFLICT (run_id, provider_tool_call_id) DO NOTHING
         RETURNING *`,
        [input.organizationId, input.installationId, input.runId, input.providerToolCallId, input.capability, input.capabilityVersion, input.argumentsHash, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.policyRevision, input.permittedEffectKey, input.expiresAt],
      );
      if (inserted.rows[0]) {
        const record = inserted.rows[0];
        const analyticsRow = await this.getAnalyticsRow(client, record.id);
        await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "requested", "system", null, analyticsRow.created_at)));
        return record;
      }
      const existing = await client.query<ApprovalRecord>(
        `SELECT * FROM agent_approval_records WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 FOR UPDATE`,
        [input.organizationId, input.runId, input.providerToolCallId],
      );
      const record = existing.rows[0];
      if (!record || record.arguments_hash !== input.argumentsHash || record.capability !== input.capability || record.capability_version !== input.capabilityVersion || record.preview_revision !== input.previewRevision || record.policy_revision !== input.policyRevision || record.permitted_effect_key !== input.permittedEffectKey) {
        throw new Error("Approval proposal is stale or conflicts with an existing approval");
      }
      return record;
    });
  }

  public async decide(input: {
    organizationId: string;
    runId: string;
    providerToolCallId: string;
    argumentsHash: string;
    decision: "approved" | "rejected";
    approvedBy: string;
  }): Promise<ApprovalDecisionResult> {
    return withTransaction(this.pool, async (client) => {
      const status = input.decision === "approved" ? "approved" : "denied";
      const result = await client.query<ApprovalRecord>(
        `UPDATE agent_approval_records
         SET status = $5, approved_by = $6, decided_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3
           AND arguments_hash = $4 AND status = 'pending' AND expires_at > now()
         RETURNING *`,
        [input.organizationId, input.runId, input.providerToolCallId, input.argumentsHash, status, input.approvedBy],
      );
      const approval = result.rows[0];
      if (!approval) {
        const existing = await client.query<ApprovalRecord>(
          `SELECT * FROM agent_approval_records
           WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3
             AND arguments_hash = $4
           FOR UPDATE`,
          [input.organizationId, input.runId, input.providerToolCallId, input.argumentsHash],
        );
        const recorded = existing.rows[0];
        if (recorded && recorded.status === status && recorded.approved_by === input.approvedBy) {
          return { approval: recorded, accepted: false };
        }
        throw new Error("Approval action is stale, expired, or conflicts with the recorded decision");
      }
      const analyticsRow = await this.getAnalyticsRow(client, approval.id);
      await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(
        analyticsRow,
        input.decision === "approved" ? "approved" : "denied",
        "human",
        input.approvedBy,
        analyticsRow.decided_at ?? analyticsRow.created_at,
      )));
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, $3, 'agent_approval', $4, $5::jsonb)`,
        [input.organizationId, input.approvedBy, `agent_approval.${input.decision}`, approval.id, JSON.stringify({ runId: input.runId, installationId: approval.installation_id, providerToolCallId: input.providerToolCallId, capability: approval.capability, argumentsHash: approval.arguments_hash })],
      );
      return { approval, accepted: true };
    });
  }

  public async consume(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    argumentsHash: string;
    capability: string;
    capabilityVersion: string;
    resourceSnapshot: Record<string, unknown>;
    previewRevision: string;
    policyRevision: string;
    permittedEffectKey: string;
  }): Promise<ApprovalRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<ApprovalRecord>(`UPDATE agent_approval_records SET status = 'consumed', consumed_at = now() WHERE organization_id = $1 AND installation_id = $2 AND run_id = $3 AND provider_tool_call_id = $4 AND arguments_hash = $5 AND capability = $6 AND capability_version = $7 AND resource_snapshot = $8::jsonb AND preview_revision = $9 AND policy_revision = $10 AND permitted_effect_key = $11 AND status = 'approved' AND expires_at > now() RETURNING *`, [input.organizationId, input.installationId, input.runId, input.providerToolCallId, input.argumentsHash, input.capability, input.capabilityVersion, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.policyRevision, input.permittedEffectKey]);
      const record = result.rows[0];
      if (!record) throw new Error("Approval is missing, expired, changed, or already consumed");
      const analyticsRow = await this.getAnalyticsRow(client, record.id);
      await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "consumed", "system", null, analyticsRow.consumed_at ?? analyticsRow.created_at)));
      return record;
    });
  }

  /** Consumes one approval and starts its exact reserved effect atomically. */
  public async consumeAndStartEffect(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    argumentsHash: string;
    capability: string;
    capabilityVersion: string;
    resourceSnapshot: Record<string, unknown>;
    previewRevision: string;
    policyRevision: string;
    permittedEffectKey: string;
    effectIdempotencyKey: string;
  }): Promise<ApprovalRecord> {
    return withTransaction(this.pool, async (client) => {
      const approval = await client.query<ApprovalRecord>(
        `UPDATE agent_approval_records
         SET status = 'consumed', consumed_at = now()
         WHERE organization_id = $1 AND installation_id = $2 AND run_id = $3 AND provider_tool_call_id = $4
           AND arguments_hash = $5 AND capability = $6 AND capability_version = $7
           AND resource_snapshot = $8::jsonb AND preview_revision = $9 AND policy_revision = $10
           AND permitted_effect_key = $11 AND status = 'approved' AND expires_at > now()
         RETURNING *`,
        [input.organizationId, input.installationId, input.runId, input.providerToolCallId, input.argumentsHash, input.capability, input.capabilityVersion, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.policyRevision, input.permittedEffectKey],
      );
      const record = approval.rows[0];
      if (!record) throw new Error("Approval is missing, expired, changed, or already consumed");
      const receipt = await client.query(
        `UPDATE agent_effect_receipts
         SET status = 'executing', updated_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3
           AND capability = $4 AND capability_version = $5 AND arguments_hash = $6
           AND idempotency_key = $7 AND status = 'reserved'
         RETURNING id`,
        [input.organizationId, input.runId, input.providerToolCallId, input.capability, input.capabilityVersion, input.argumentsHash, input.effectIdempotencyKey],
      );
      if (!receipt.rows[0]) throw new Error("Effect receipt is missing, changed, or no longer reserved");
      const analyticsApproval = await this.getAnalyticsRow(client, record.id);
      await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsApproval, "consumed", "system", null, analyticsApproval.consumed_at ?? analyticsApproval.created_at)));
      const analyticsEffect = await this.getEffectAnalyticsRow(client, String(receipt.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.effectInput(analyticsEffect, "executing")));
      return record;
    });
  }

  public async cancel(organizationId: string, runId: string, providerToolCallId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<ApprovalRecord>(`UPDATE agent_approval_records SET status = 'cancelled', decided_at = now() WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 AND status IN ('pending', 'approved') RETURNING *`, [organizationId, runId, providerToolCallId]);
      const record = result.rows[0];
      if (!record) return;
      const analyticsRow = await this.getAnalyticsRow(client, record.id);
      await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "cancelled", "system", null, analyticsRow.decided_at ?? analyticsRow.created_at)));
    });
  }

  public async expirePending(limit = 100): Promise<Array<Pick<ApprovalRecord, "id" | "organization_id" | "installation_id" | "run_id" | "provider_tool_call_id">>> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<ApprovalRecord>(
        `WITH expired AS (
           SELECT id
           FROM agent_approval_records
           WHERE status = 'pending' AND expires_at <= now()
           ORDER BY expires_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE agent_approval_records AS approval
         SET status = 'expired', decided_at = now()
         FROM expired
         WHERE approval.id = expired.id AND approval.status = 'pending'
         RETURNING approval.*`,
        [Math.max(1, Math.min(limit, 500))],
      );
      for (const record of result.rows) {
        const analyticsRow = await this.getAnalyticsRow(client, record.id);
        await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "expired", "system", null, analyticsRow.decided_at ?? analyticsRow.created_at)));
      }
      return result.rows.map(({ id, organization_id, installation_id, run_id, provider_tool_call_id }) => ({ id, organization_id, installation_id, run_id, provider_tool_call_id }));
    });
  }

  private async getAnalyticsRow(client: PoolClient, approvalId: string): Promise<ApprovalAnalyticsRow> {
    const result = await client.query<ApprovalAnalyticsRow>(
      `SELECT aar.*, ar.agent_definition_id, ar.agent_version_id, ar.correlation_id
       FROM agent_approval_records aar
       JOIN agent_runs ar ON ar.id = aar.run_id
       WHERE aar.id = $1
       FOR UPDATE OF aar`,
      [approvalId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("APPROVAL_NOT_FOUND");
    return row;
  }

  private async getEffectAnalyticsRow(client: PoolClient, effectId: string): Promise<EffectAnalyticsRow> {
    const result = await client.query<EffectAnalyticsRow>(
      `SELECT er.id, er.organization_id, er.installation_id, er.run_id,
              er.provider_tool_call_id, er.capability, er.capability_version,
              er.status, er.reconciliation_required, er.created_at, er.updated_at,
              er.completed_at, ar.agent_definition_id, ar.agent_version_id,
              ar.correlation_id
       FROM agent_effect_receipts er
       JOIN agent_runs ar ON ar.id = er.run_id
       WHERE er.id = $1
       FOR UPDATE OF er`,
      [effectId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("EFFECT_RECEIPT_NOT_FOUND");
    return row;
  }

  private analyticsInput(
    row: ApprovalAnalyticsRow,
    action: ApprovalAnalyticsInput["action"],
    actorType: ApprovalAnalyticsInput["actorType"],
    actorRef: string | null,
    occurredAt: Date | string,
  ): ApprovalAnalyticsInput {
    return {
      organizationId: row.organization_id,
      runId: row.run_id,
      agentDefinitionId: row.agent_definition_id,
      agentVersionId: row.agent_version_id,
      installationId: row.installation_id,
      correlationId: row.correlation_id,
      approvalId: row.id,
      providerToolCallId: row.provider_tool_call_id,
      capability: row.capability,
      capabilityVersion: row.capability_version,
      action,
      status: row.status,
      actorType,
      actorRef,
      expiresAt: row.expires_at,
      occurredAt,
    };
  }

  private effectInput(row: EffectAnalyticsRow, action: EffectAnalyticsInput["action"]): EffectAnalyticsInput {
    return {
      organizationId: row.organization_id,
      runId: row.run_id,
      agentDefinitionId: row.agent_definition_id,
      agentVersionId: row.agent_version_id,
      installationId: row.installation_id,
      correlationId: row.correlation_id,
      effectId: row.id,
      providerToolCallId: row.provider_tool_call_id,
      capability: row.capability,
      capabilityVersion: row.capability_version,
      action,
      status: row.status,
      reconciliationRequired: row.reconciliation_required,
      occurredAt: action === "reserved" ? row.created_at : row.updated_at,
      completedAt: row.completed_at,
    };
  }
}
