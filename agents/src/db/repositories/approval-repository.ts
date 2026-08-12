import type { Pool } from "pg";
import { query } from "../pool";

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
  approved_by: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "cancelled";
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  consumed_at: string | null;
}

export class ApprovalRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    capability: string;
    capabilityVersion: string;
    argumentsHash: string;
    resourceSnapshot: Record<string, unknown>;
    previewRevision: string;
    approvedBy: string;
    expiresAt: string;
  }): Promise<ApprovalRecord> {
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new Error("Approval expiry must be in the future");
    const result = await query<ApprovalRecord>(this.pool, `INSERT INTO agent_approval_records (organization_id, installation_id, run_id, provider_tool_call_id, capability, capability_version, arguments_hash, resource_snapshot, preview_revision, approved_by, status, expires_at, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'approved',$11,now()) ON CONFLICT (run_id, provider_tool_call_id) DO UPDATE SET arguments_hash = EXCLUDED.arguments_hash, preview_revision = EXCLUDED.preview_revision, approved_by = EXCLUDED.approved_by, expires_at = EXCLUDED.expires_at, status = 'approved', decided_at = now() WHERE agent_approval_records.status IN ('pending', 'expired') RETURNING *`, [input.organizationId, input.installationId, input.runId, input.providerToolCallId, input.capability, input.capabilityVersion, input.argumentsHash, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.approvedBy, input.expiresAt]);
    if (!result.rows[0]) throw new Error("Approval is already consumed or cancelled");
    return result.rows[0];
  }

  public async consume(input: { organizationId: string; runId: string; providerToolCallId: string; argumentsHash: string; capabilityVersion: string }): Promise<ApprovalRecord> {
    const result = await query<ApprovalRecord>(this.pool, `UPDATE agent_approval_records SET status = 'consumed', consumed_at = now() WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 AND arguments_hash = $4 AND capability_version = $5 AND status = 'approved' AND expires_at > now() RETURNING *`, [input.organizationId, input.runId, input.providerToolCallId, input.argumentsHash, input.capabilityVersion]);
    if (!result.rows[0]) throw new Error("Approval is missing, expired, changed, or already consumed");
    return result.rows[0];
  }

  public async cancel(organizationId: string, runId: string, providerToolCallId: string): Promise<void> {
    await query(this.pool, `UPDATE agent_approval_records SET status = 'cancelled', decided_at = now() WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 AND status IN ('pending', 'approved')`, [organizationId, runId, providerToolCallId]);
  }
}
