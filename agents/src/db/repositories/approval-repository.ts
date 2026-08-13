import type { Pool } from "pg";
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

export class ApprovalRepository {
  public constructor(private readonly pool: Pool) {}

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
      if (inserted.rows[0]) return inserted.rows[0];
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
    const result = await query<ApprovalRecord>(this.pool, `UPDATE agent_approval_records SET status = 'consumed', consumed_at = now() WHERE organization_id = $1 AND installation_id = $2 AND run_id = $3 AND provider_tool_call_id = $4 AND arguments_hash = $5 AND capability = $6 AND capability_version = $7 AND resource_snapshot = $8::jsonb AND preview_revision = $9 AND policy_revision = $10 AND permitted_effect_key = $11 AND status = 'approved' AND expires_at > now() RETURNING *`, [input.organizationId, input.installationId, input.runId, input.providerToolCallId, input.argumentsHash, input.capability, input.capabilityVersion, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.policyRevision, input.permittedEffectKey]);
    if (!result.rows[0]) throw new Error("Approval is missing, expired, changed, or already consumed");
    return result.rows[0];
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
      return record;
    });
  }

  public async cancel(organizationId: string, runId: string, providerToolCallId: string): Promise<void> {
    await query(this.pool, `UPDATE agent_approval_records SET status = 'cancelled', decided_at = now() WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 AND status IN ('pending', 'approved')`, [organizationId, runId, providerToolCallId]);
  }

  public async expirePending(limit = 100): Promise<Array<Pick<ApprovalRecord, "id" | "organization_id" | "installation_id" | "run_id" | "provider_tool_call_id">>> {
    const result = await query<Pick<ApprovalRecord, "id" | "organization_id" | "installation_id" | "run_id" | "provider_tool_call_id">>(
      this.pool,
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
       RETURNING approval.id, approval.organization_id, approval.installation_id,
                 approval.run_id, approval.provider_tool_call_id`,
      [Math.max(1, Math.min(limit, 500))],
    );
    return result.rows;
  }
}
