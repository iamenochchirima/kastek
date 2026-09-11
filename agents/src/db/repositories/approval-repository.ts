import { createHash } from "node:crypto";
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
  approval_group_id?: string | null;
  provider_tool_call_id: string;
  runtime_operation_id: string;
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

export type ApprovalGroupStatus = "pending" | "approved" | "partially_approved" | "rejected" | "expired" | "cancelled" | "invalidated" | "consumed";

export interface ApprovalGroupRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
  batch_id: string;
  turn_key: string;
  plan_digest: string;
  policy_revision: string;
  status: ApprovalGroupStatus;
  selected_operation_ids: string[];
  decision: "approved" | "partially_approved" | "rejected" | null;
  decided_by: string | null;
  decision_idempotency_key: string | null;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  consumed_at: string | null;
}

export interface ApprovalGroupDecisionResult {
  group: ApprovalGroupRecord;
  approvals: ApprovalRecord[];
  accepted: boolean;
}

export interface ApprovalGroupProposal {
  providerToolCallId: string;
  runtimeOperationId: string;
  capability: string;
  capabilityVersion: string;
  argumentsHash: string;
  resourceSnapshot: Record<string, unknown>;
  previewRevision: string;
  policyRevision: string;
  permittedEffectKey: string;
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord;
  /** True only for the request that atomically moved pending state to a decision. */
  accepted: boolean;
}

function normalizeGroup(row: ApprovalGroupRecord): ApprovalGroupRecord {
  const selected = Array.isArray(row.selected_operation_ids)
    ? row.selected_operation_ids.filter((value): value is string => typeof value === "string")
    : [];
  return { ...row, selected_operation_ids: selected };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function approvalPlanDigest(proposals: ApprovalGroupProposal[], policyRevision: string): string {
  const payload = proposals
    .map((proposal) => ({
      providerToolCallId: proposal.providerToolCallId,
      runtimeOperationId: proposal.runtimeOperationId,
      capability: proposal.capability,
      capabilityVersion: proposal.capabilityVersion,
      argumentsHash: proposal.argumentsHash,
      resourceSnapshot: canonicalize(proposal.resourceSnapshot),
      previewRevision: proposal.previewRevision,
      policyRevision: proposal.policyRevision,
      permittedEffectKey: proposal.permittedEffectKey,
    }))
    // Model order is part of the reviewed batch contract. Keep object keys
    // canonicalized above, but do not sort proposals: a reordered batch must
    // produce a fresh digest and cannot reuse an existing approval barrier.
  return createHash("sha256").update(JSON.stringify({ policyRevision, proposals: payload })).digest("hex");
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

  public async getGroup(organizationId: string, groupId: string): Promise<ApprovalGroupRecord | null> {
    const result = await query<ApprovalGroupRecord>(
      this.pool,
      `SELECT * FROM agent_approval_groups WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, groupId],
    );
    return result.rows[0] ? normalizeGroup(result.rows[0]) : null;
  }

  public async getActiveGroup(organizationId: string, runId: string): Promise<{ group: ApprovalGroupRecord; approvals: ApprovalRecord[] } | null> {
    const result = await query<ApprovalGroupRecord>(
      this.pool,
      `SELECT * FROM agent_approval_groups
       WHERE organization_id = $1 AND run_id = $2
         AND status IN ('pending', 'approved', 'partially_approved')
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId, runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { group: normalizeGroup(row), approvals: await this.listGroupOperations(organizationId, row.id) };
  }

  public async listGroups(organizationId: string, runId: string): Promise<ApprovalGroupRecord[]> {
    const result = await query<ApprovalGroupRecord>(
      this.pool,
      `SELECT * FROM agent_approval_groups
       WHERE organization_id = $1 AND run_id = $2
       ORDER BY created_at DESC, id DESC`,
      [organizationId, runId],
    );
    return result.rows.map(normalizeGroup);
  }

  public async listGroupOperations(organizationId: string, groupId: string): Promise<ApprovalRecord[]> {
    const result = await query<ApprovalRecord>(
      this.pool,
      `SELECT * FROM agent_approval_records
       WHERE organization_id = $1 AND approval_group_id = $2
       ORDER BY created_at ASC, runtime_operation_id ASC`,
      [organizationId, groupId],
    );
    return result.rows;
  }

  public async getApprovedOperation(input: {
    organizationId: string;
    runId: string;
    groupId: string;
    runtimeOperationId: string;
    argumentsHash: string;
  }): Promise<ApprovalRecord | null> {
    const result = await query<ApprovalRecord>(
      this.pool,
      `SELECT * FROM agent_approval_records
       WHERE organization_id = $1 AND run_id = $2 AND approval_group_id = $3
         AND runtime_operation_id = $4 AND arguments_hash = $5
         AND status = 'approved' AND expires_at > now()
       LIMIT 1`,
      [input.organizationId, input.runId, input.groupId, input.runtimeOperationId, input.argumentsHash],
    );
    return result.rows[0] ?? null;
  }

  public async createGroup(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    batchId: string;
    turnKey: string;
    policyRevision: string;
    expiresAt: string;
    proposals: ApprovalGroupProposal[];
  }): Promise<{ group: ApprovalGroupRecord; approvals: ApprovalRecord[] }> {
    if (!input.proposals.length) throw new Error("Approval group requires at least one proposal");
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new Error("Approval group expiry must be in the future");
    const planDigest = approvalPlanDigest(input.proposals, input.policyRevision);
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<ApprovalGroupRecord>(
        `SELECT * FROM agent_approval_groups
         WHERE organization_id = $1 AND run_id = $2 AND batch_id = $3 AND turn_key = $4
         FOR UPDATE`,
        [input.organizationId, input.runId, input.batchId, input.turnKey],
      );
      const existingGroup = existing.rows[0];
      if (existingGroup) {
        const normalized = normalizeGroup(existingGroup);
        if (normalized.plan_digest !== planDigest || normalized.policy_revision !== input.policyRevision) {
          throw new Error("Approval group proposal is stale or conflicts with an existing group");
        }
        const approvals = await this.listGroupOperationsWithClient(client, input.organizationId, normalized.id);
        return { group: normalized, approvals };
      }
      const inserted = await client.query<ApprovalGroupRecord>(
        `INSERT INTO agent_approval_groups
          (organization_id, installation_id, run_id, batch_id, turn_key, plan_digest, policy_revision, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)
         RETURNING *`,
        [input.organizationId, input.installationId, input.runId, input.batchId, input.turnKey, planDigest, input.policyRevision, input.expiresAt],
      );
      const group = normalizeGroup(inserted.rows[0]!);
      const approvals: ApprovalRecord[] = [];
      for (const proposal of input.proposals) {
        const result = await client.query<ApprovalRecord>(
          `INSERT INTO agent_approval_records
            (organization_id, installation_id, run_id, approval_group_id, provider_tool_call_id, runtime_operation_id, capability,
             capability_version, arguments_hash, resource_snapshot, preview_revision, policy_revision,
             permitted_effect_key, status, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,'pending',$14)
           ON CONFLICT (run_id, runtime_operation_id) DO NOTHING
           RETURNING *`,
          [input.organizationId, input.installationId, input.runId, group.id, proposal.providerToolCallId, proposal.runtimeOperationId, proposal.capability, proposal.capabilityVersion, proposal.argumentsHash, JSON.stringify(proposal.resourceSnapshot), proposal.previewRevision, proposal.policyRevision, proposal.permittedEffectKey, input.expiresAt],
        );
        const record = result.rows[0];
        if (!record) throw new Error("Approval group operation was not persisted");
        if (record.approval_group_id !== group.id || record.arguments_hash !== proposal.argumentsHash || record.capability !== proposal.capability || record.capability_version !== proposal.capabilityVersion || record.policy_revision !== proposal.policyRevision || record.permitted_effect_key !== proposal.permittedEffectKey) {
          throw new Error("Approval group operation identity conflict");
        }
        approvals.push(record);
        const analyticsRow = await this.getAnalyticsRow(client, record.id);
        await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "requested", "system", null, analyticsRow.created_at)));
      }
      return { group, approvals };
    });
  }

  public async decideGroup(input: {
    organizationId: string;
    runId: string;
    groupId: string;
    planDigest: string;
    decision: "approved" | "rejected";
    selectedOperationIds?: string[];
    approvedBy: string;
    idempotencyKey?: string;
  }): Promise<ApprovalGroupDecisionResult> {
    let expired = false;
    const result = await withTransaction(this.pool, async (client) => {
      const locked = await client.query<ApprovalGroupRecord>(
        `SELECT * FROM agent_approval_groups
         WHERE organization_id = $1 AND run_id = $2 AND id = $3
         FOR UPDATE`,
        [input.organizationId, input.runId, input.groupId],
      );
      const current = locked.rows[0];
      if (!current) throw new Error("APPROVAL_GROUP_NOT_FOUND");
      const group = normalizeGroup(current);
      if (group.plan_digest !== input.planDigest) throw new Error("APPROVAL_GROUP_DIGEST_MISMATCH");
      const approvals = await this.listGroupOperationsWithClient(client, input.organizationId, group.id);
      const allOperationIds = approvals.map((approval) => approval.runtime_operation_id);
      if (input.decision === "rejected" && input.selectedOperationIds?.length) {
        throw new Error("APPROVAL_GROUP_SELECTION_NOT_ALLOWED");
      }
      const requestedSelected = input.decision === "approved"
        ? input.selectedOperationIds ?? allOperationIds
        : [];
      if (input.decision === "approved" && requestedSelected.length === 0) {
        throw new Error("APPROVAL_GROUP_SELECTION_EMPTY");
      }
      if (new Set(requestedSelected).size !== requestedSelected.length) {
        throw new Error("APPROVAL_GROUP_SELECTION_DUPLICATE");
      }
      if (requestedSelected.some((operationId) => !allOperationIds.includes(operationId))) {
        throw new Error("APPROVAL_GROUP_OPERATION_NOT_FOUND");
      }
      // Selection order is presentation input, not authorization meaning.
      // Persist it in the immutable proposal order so an equivalent retry with
      // reordered selected IDs remains idempotent.
      const selectedSet = new Set(requestedSelected);
      const selected = allOperationIds.filter((operationId) => selectedSet.has(operationId));
      const requestedStatus = input.decision === "rejected" ? "rejected" : selected.length === allOperationIds.length ? "approved" : "partially_approved";
      const expectedDecision = requestedStatus === "rejected" ? "rejected" : requestedStatus;
      if (group.status !== "pending") {
        const sameDecision = group.decision === expectedDecision
          && group.decided_by === input.approvedBy
          && arraysEqual(group.selected_operation_ids, selected);
        if (sameDecision) return { group, approvals, accepted: false };
        throw new Error("APPROVAL_GROUP_NOT_PENDING");
      }
      if (new Date(group.expires_at).getTime() <= Date.now()) {
        await client.query(
          `UPDATE agent_approval_groups
           SET status = 'expired', decision = 'rejected', selected_operation_ids = '[]'::jsonb, decided_at = now()
           WHERE organization_id = $1 AND run_id = $2 AND id = $3 AND status = 'pending'`,
          [input.organizationId, input.runId, input.groupId],
        );
        await client.query(
          `UPDATE agent_approval_records SET status = 'expired', decided_at = now()
           WHERE organization_id = $1 AND run_id = $2 AND approval_group_id = $3 AND status = 'pending'`,
          [input.organizationId, input.runId, input.groupId],
        );
        expired = true;
        const expiredGroup = await this.getGroupWithClient(client, input.organizationId, input.groupId);
        const expiredApprovals = await this.listGroupOperationsWithClient(client, input.organizationId, input.groupId);
        return {
          group: expiredGroup ?? { ...group, status: "expired", decision: "rejected", selected_operation_ids: [] },
          approvals: expiredApprovals,
          accepted: false,
        };
      }
      const updated = await client.query<ApprovalGroupRecord>(
        `UPDATE agent_approval_groups
         SET status = $4, decision = $5, selected_operation_ids = $6::jsonb,
             decided_by = $7, decision_idempotency_key = COALESCE($8, decision_idempotency_key), decided_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND id = $3 AND status = 'pending'
         RETURNING *`,
        [input.organizationId, input.runId, input.groupId, requestedStatus, expectedDecision, JSON.stringify(selected), input.approvedBy, input.idempotencyKey ?? null],
      );
      const updatedGroup = normalizeGroup(updated.rows[0] ?? group);
      const approvedSet = new Set(selected);
      for (const approval of approvals) {
        const operationStatus = approvedSet.has(approval.runtime_operation_id) && input.decision !== "rejected" ? "approved" : "denied";
        const operation = await client.query<ApprovalRecord>(
          `UPDATE agent_approval_records
           SET status = $4, approved_by = $5, decided_at = now()
           WHERE organization_id = $1 AND run_id = $2 AND id = $3 AND status = 'pending'
           RETURNING *`,
          [input.organizationId, input.runId, approval.id, operationStatus, input.approvedBy],
        );
        const record = operation.rows[0] ?? approval;
        const analyticsRow = await this.getAnalyticsRow(client, record.id);
        await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, operationStatus === "approved" ? "approved" : "denied", "human", input.approvedBy, analyticsRow.decided_at ?? analyticsRow.created_at)));
      }
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, $3, 'agent_approval_group', $4, $5::jsonb)`,
        [input.organizationId, input.approvedBy, `agent_approval_group.${expectedDecision}`, group.id, JSON.stringify({ runId: input.runId, planDigest: input.planDigest, selectedOperationIds: selected })],
      );
      return { group: updatedGroup, approvals: await this.listGroupOperationsWithClient(client, input.organizationId, group.id), accepted: true };
    });
    if (expired) throw new Error("APPROVAL_GROUP_EXPIRED");
    return result;
  }

  public async expireGroups(limit = 100): Promise<Array<Pick<ApprovalGroupRecord, "id" | "organization_id" | "installation_id" | "run_id">>> {
    return withTransaction(this.pool, async (client) => {
      const groups = await client.query<ApprovalGroupRecord>(
        `WITH expired AS (
           SELECT id FROM agent_approval_groups
           WHERE status = 'pending' AND expires_at <= now()
           ORDER BY expires_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE agent_approval_groups AS group_record
         SET status = 'expired', decision = 'rejected', decided_at = now()
         FROM expired
         WHERE group_record.id = expired.id AND group_record.status = 'pending'
         RETURNING group_record.*`,
        [Math.max(1, Math.min(limit, 500))],
      );
      for (const group of groups.rows) {
        await client.query(
          `UPDATE agent_approval_records SET status = 'expired', decided_at = now()
           WHERE organization_id = $1 AND approval_group_id = $2 AND status = 'pending'`,
          [group.organization_id, group.id],
        );
      }
      return groups.rows.map(({ id, organization_id, installation_id, run_id }) => ({ id, organization_id, installation_id, run_id }));
    });
  }

  /**
   * Invalidates a prepared group when its reviewed resource, capability
   * version, or policy no longer matches the execution request. Invalidated
   * groups cannot be approved or resumed; their child records remain as
   * audit evidence and are cancelled so no effect can consume them.
   */
  public async invalidateGroup(organizationId: string, runId: string, groupId: string, reason?: string): Promise<ApprovalGroupRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query<ApprovalGroupRecord>(
        `UPDATE agent_approval_groups
         SET status = 'invalidated', decision = 'rejected', selected_operation_ids = '[]'::jsonb, decided_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND id = $3
           AND status IN ('pending', 'approved', 'partially_approved')
         RETURNING *`,
        [organizationId, runId, groupId],
      );
      const group = updated.rows[0];
      if (!group) return this.getGroupWithClient(client, organizationId, groupId);
      const operations = await this.listGroupOperationsWithClient(client, organizationId, groupId);
      for (const approval of operations) {
        const child = await client.query<ApprovalRecord>(
          `UPDATE agent_approval_records SET status = 'cancelled', decided_at = now()
           WHERE organization_id = $1 AND run_id = $2 AND id = $3 AND status IN ('pending', 'approved')
           RETURNING *`,
          [organizationId, runId, approval.id],
        );
        const record = child.rows[0] ?? approval;
        const analyticsRow = await this.getAnalyticsRow(client, record.id);
        await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "cancelled", "system", null, analyticsRow.decided_at ?? analyticsRow.created_at)));
      }
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'system', 'approval-runtime', 'agent_approval_group.invalidated', 'agent_approval_group', $2, $3::jsonb)`,
        [organizationId, groupId, JSON.stringify({ runId, reason: reason ?? "approval_plan_changed" })],
      );
      return normalizeGroup(group);
    });
  }

  public async cancelGroup(organizationId: string, runId: string, groupId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const group = await client.query<ApprovalGroupRecord>(
        `UPDATE agent_approval_groups
         SET status = 'cancelled', decision = 'rejected', decided_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND id = $3 AND status = 'pending'
         RETURNING *`,
        [organizationId, runId, groupId],
      );
      const record = group.rows[0];
      if (!record) return;
      const operations = await this.listGroupOperationsWithClient(client, organizationId, groupId);
      for (const approval of operations) {
        const updated = await client.query<ApprovalRecord>(
          `UPDATE agent_approval_records SET status = 'cancelled', decided_at = now()
           WHERE organization_id = $1 AND run_id = $2 AND id = $3 AND status IN ('pending', 'approved')
           RETURNING *`,
          [organizationId, runId, approval.id],
        );
        const row = updated.rows[0] ?? approval;
        const analyticsRow = await this.getAnalyticsRow(client, row.id);
        await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "cancelled", "system", null, analyticsRow.decided_at ?? analyticsRow.created_at)));
      }
    });
  }

  public async createPending(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    runtimeOperationId?: string;
    capability: string;
    capabilityVersion: string;
    argumentsHash: string;
    resourceSnapshot: Record<string, unknown>;
    previewRevision: string;
    policyRevision: string;
    permittedEffectKey: string;
    expiresAt: string;
    approvalGroupId?: string;
  }): Promise<ApprovalRecord> {
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new Error("Approval expiry must be in the future");
    const runtimeOperationId = input.runtimeOperationId ?? input.providerToolCallId;
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<ApprovalRecord>(
        `INSERT INTO agent_approval_records
          (organization_id, installation_id, run_id, approval_group_id, provider_tool_call_id, runtime_operation_id, capability,
           capability_version, arguments_hash, resource_snapshot, preview_revision,
           policy_revision, permitted_effect_key, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,'pending',$14)
         ON CONFLICT (run_id, runtime_operation_id) DO NOTHING
         RETURNING *`,
        [input.organizationId, input.installationId, input.runId, input.approvalGroupId ?? null, input.providerToolCallId, runtimeOperationId, input.capability, input.capabilityVersion, input.argumentsHash, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.policyRevision, input.permittedEffectKey, input.expiresAt],
      );
      if (inserted.rows[0]) {
        const record = inserted.rows[0];
        const analyticsRow = await this.getAnalyticsRow(client, record.id);
        await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "requested", "system", null, analyticsRow.created_at)));
        return record;
      }
      const existing = await client.query<ApprovalRecord>(
        `SELECT * FROM agent_approval_records WHERE organization_id = $1 AND run_id = $2 AND runtime_operation_id = $3 FOR UPDATE`,
        [input.organizationId, input.runId, runtimeOperationId],
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
    runtimeOperationId?: string;
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
           AND runtime_operation_id = COALESCE($4, runtime_operation_id)
           AND arguments_hash = $7 AND status = 'pending' AND expires_at > now()
           RETURNING *`,
        [input.organizationId, input.runId, input.providerToolCallId, input.runtimeOperationId ?? null, status, input.approvedBy, input.argumentsHash],
      );
      const approval = result.rows[0];
      if (!approval) {
        const existing = await client.query<ApprovalRecord>(
          `SELECT * FROM agent_approval_records
           WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3
             AND runtime_operation_id = COALESCE($4, runtime_operation_id)
             AND arguments_hash = $5
           FOR UPDATE`,
          [input.organizationId, input.runId, input.providerToolCallId, input.runtimeOperationId ?? null, input.argumentsHash],
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
    runtimeOperationId?: string;
    argumentsHash: string;
    capability: string;
    capabilityVersion: string;
    resourceSnapshot: Record<string, unknown>;
    previewRevision: string;
    policyRevision: string;
    permittedEffectKey: string;
  }): Promise<ApprovalRecord> {
    const runtimeOperationId = input.runtimeOperationId ?? input.providerToolCallId;
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<ApprovalRecord>(`UPDATE agent_approval_records SET status = 'consumed', consumed_at = now() WHERE organization_id = $1 AND installation_id = $2 AND run_id = $3 AND provider_tool_call_id = $4 AND runtime_operation_id = $5 AND arguments_hash = $6 AND capability = $7 AND capability_version = $8 AND resource_snapshot = $9::jsonb AND preview_revision = $10 AND policy_revision = $11 AND permitted_effect_key = $12 AND status = 'approved' AND expires_at > now() RETURNING *`, [input.organizationId, input.installationId, input.runId, input.providerToolCallId, runtimeOperationId, input.argumentsHash, input.capability, input.capabilityVersion, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.policyRevision, input.permittedEffectKey]);
      const record = result.rows[0];
      if (!record) throw new Error("Approval is missing, expired, changed, or already consumed");
      const analyticsRow = await this.getAnalyticsRow(client, record.id);
      await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "consumed", "system", null, analyticsRow.consumed_at ?? analyticsRow.created_at)));
      await this.markGroupConsumedIfSettled(client, record.approval_group_id);
      return record;
    });
  }

  /** Consumes one approval and starts its exact reserved effect atomically. */
  public async consumeAndStartEffect(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    runtimeOperationId?: string;
    argumentsHash: string;
    capability: string;
    capabilityVersion: string;
    resourceSnapshot: Record<string, unknown>;
    previewRevision: string;
    policyRevision: string;
    permittedEffectKey: string;
    effectIdempotencyKey: string;
  }): Promise<ApprovalRecord> {
    const runtimeOperationId = input.runtimeOperationId ?? input.providerToolCallId;
    return withTransaction(this.pool, async (client) => {
      const approval = await client.query<ApprovalRecord>(
        `UPDATE agent_approval_records
         SET status = 'consumed', consumed_at = now()
         WHERE organization_id = $1 AND installation_id = $2 AND run_id = $3 AND provider_tool_call_id = $4
           AND runtime_operation_id = $5 AND arguments_hash = $6 AND capability = $7 AND capability_version = $8
           AND resource_snapshot = $9::jsonb AND preview_revision = $10 AND policy_revision = $11
           AND permitted_effect_key = $12 AND status = 'approved' AND expires_at > now()
         RETURNING *`,
        [input.organizationId, input.installationId, input.runId, input.providerToolCallId, runtimeOperationId, input.argumentsHash, input.capability, input.capabilityVersion, JSON.stringify(input.resourceSnapshot), input.previewRevision, input.policyRevision, input.permittedEffectKey],
      );
      const record = approval.rows[0];
      if (!record) throw new Error("Approval is missing, expired, changed, or already consumed");
      const receipt = await client.query(
        `UPDATE agent_effect_receipts
         SET status = 'executing', updated_at = now()
         WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3
           AND runtime_operation_id = $4 AND capability = $5 AND capability_version = $6 AND arguments_hash = $7
           AND idempotency_key = $8 AND status = 'reserved'
         RETURNING id`,
        [input.organizationId, input.runId, input.providerToolCallId, runtimeOperationId, input.capability, input.capabilityVersion, input.argumentsHash, input.effectIdempotencyKey],
      );
      if (!receipt.rows[0]) throw new Error("Effect receipt is missing, changed, or no longer reserved");
      const analyticsApproval = await this.getAnalyticsRow(client, record.id);
      await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsApproval, "consumed", "system", null, analyticsApproval.consumed_at ?? analyticsApproval.created_at)));
      const analyticsEffect = await this.getEffectAnalyticsRow(client, String(receipt.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.effectInput(analyticsEffect, "executing")));
      await this.markGroupConsumedIfSettled(client, record.approval_group_id);
      return record;
    });
  }

  public async cancel(organizationId: string, runId: string, providerToolCallId: string, runtimeOperationId?: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<ApprovalRecord>(`UPDATE agent_approval_records SET status = 'cancelled', decided_at = now() WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 AND runtime_operation_id = COALESCE($4, provider_tool_call_id) AND status IN ('pending', 'approved') RETURNING *`, [organizationId, runId, providerToolCallId, runtimeOperationId ?? null]);
      const record = result.rows[0];
      if (!record) return;
      const analyticsRow = await this.getAnalyticsRow(client, record.id);
      await enqueueOutbox(client, buildApprovalLifecycleEvent(this.analyticsInput(analyticsRow, "cancelled", "system", null, analyticsRow.decided_at ?? analyticsRow.created_at)));
    });
  }

  public async expirePending(limit = 100): Promise<Array<Pick<ApprovalRecord, "id" | "organization_id" | "installation_id" | "run_id" | "provider_tool_call_id" | "runtime_operation_id">>> {
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
      return result.rows.map(({ id, organization_id, installation_id, run_id, provider_tool_call_id, runtime_operation_id }) => ({ id, organization_id, installation_id, run_id, provider_tool_call_id, runtime_operation_id }));
    });
  }

  private async listGroupOperationsWithClient(client: PoolClient, organizationId: string, groupId: string): Promise<ApprovalRecord[]> {
    const result = await client.query<ApprovalRecord>(
      `SELECT * FROM agent_approval_records
       WHERE organization_id = $1 AND approval_group_id = $2
       ORDER BY created_at ASC, runtime_operation_id ASC`,
      [organizationId, groupId],
    );
    return result.rows;
  }

  private async getGroupWithClient(client: PoolClient, organizationId: string, groupId: string): Promise<ApprovalGroupRecord | null> {
    const result = await client.query<ApprovalGroupRecord>(
      `SELECT * FROM agent_approval_groups WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, groupId],
    );
    return result.rows[0] ? normalizeGroup(result.rows[0]) : null;
  }

  private async markGroupConsumedIfSettled(client: PoolClient, groupId: string | null | undefined): Promise<void> {
    if (!groupId) return;
    await client.query(
      `UPDATE agent_approval_groups AS approval_group
       SET status = 'consumed', consumed_at = now()
       WHERE approval_group.id = $1
         AND approval_group.status IN ('approved', 'partially_approved')
         AND NOT EXISTS (
           SELECT 1 FROM agent_approval_records operation
           WHERE operation.approval_group_id = approval_group.id AND operation.status = 'approved'
         )`,
      [groupId],
    );
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
