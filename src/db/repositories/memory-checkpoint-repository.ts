import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { query, withTransaction } from "../pool";
import { enqueueMemoryLifecycleEvent } from "../../analytics/memory";
import { evidenceDigest, type MemoryCheckpointPort, type MemoryCheckpointReceipt, type MemoryCheckpointRequest } from "../../memory/contracts";

interface MemorySourceEventRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  agent_version_id: string | null;
  installation_id: string;
  conversation_id: string | null;
  end_user_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  source_boundary: string;
  evidence_digest: string;
}

interface MemoryCheckpointRow {
  id: string;
  evidence_digest: string;
  source_boundary: string;
  status: "requested" | "committed" | "blocked" | "failed";
  committed_at: string | null;
}

function boundedDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateCheckpointRequest(request: MemoryCheckpointRequest): void {
  const required = [
    ["organizationId", request.scope.organizationId],
    ["workspaceId", request.scope.workspaceId],
    ["agentDefinitionId", request.scope.agentDefinitionId],
    ["installationId", request.scope.installationId],
    ["runId", request.runId],
    ["turnId", request.turnId],
    ["sourceBoundary", request.sourceBoundary],
    ["idempotencyKey", request.idempotencyKey],
  ] as const;
  const missing = required.find(([, value]) => !value || typeof value !== "string");
  if (missing) throw Object.assign(new Error(`Memory checkpoint field is required: ${missing[0]}`), { code: "MEMORY_CHECKPOINT_INVALID" });
  if (!Number.isInteger(request.compactionGeneration) || request.compactionGeneration < 0) {
    throw Object.assign(new Error("Compaction generation must be a non-negative integer"), { code: "MEMORY_CHECKPOINT_INVALID" });
  }
  const calculatedDigest = evidenceDigest(request.evidence.items);
  if (calculatedDigest !== request.evidence.evidenceDigest) {
    throw Object.assign(new Error("Memory checkpoint evidence digest does not match its items"), { code: "MEMORY_CHECKPOINT_DIGEST_MISMATCH" });
  }
  if (request.evidence.scope.organizationId !== request.scope.organizationId
    || request.evidence.scope.workspaceId !== request.scope.workspaceId
    || request.evidence.scope.agentDefinitionId !== request.scope.agentDefinitionId
    || request.evidence.scope.installationId !== request.scope.installationId) {
    throw Object.assign(new Error("Memory checkpoint evidence scope does not match the checkpoint scope"), { code: "MEMORY_CHECKPOINT_SCOPE_MISMATCH" });
  }
}

export class MemoryCheckpointRepository implements MemoryCheckpointPort {
  private readonly analyticsEnabled: boolean;

  public constructor(
    private readonly pool: Pool,
    options: { analyticsEnabled?: boolean } = {},
  ) {
    this.analyticsEnabled = options.analyticsEnabled === true;
  }

  public async commit(request: MemoryCheckpointRequest): Promise<MemoryCheckpointReceipt> {
    validateCheckpointRequest(request);
    return withTransaction(this.pool, async (client) => this.commitWithClient(client, request));
  }

  private async commitWithClient(client: PoolClient, request: MemoryCheckpointRequest): Promise<MemoryCheckpointReceipt> {
    const existing = await client.query<MemoryCheckpointRow>(
      `SELECT id, evidence_digest, source_boundary, status, committed_at
       FROM memory_checkpoints
       WHERE organization_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [request.scope.organizationId, request.idempotencyKey],
    );
    const current = existing.rows[0];
    if (current && (current.evidence_digest !== request.evidence.evidenceDigest || current.source_boundary !== request.sourceBoundary)) {
      throw Object.assign(new Error("Memory checkpoint idempotency key was reused for a different evidence boundary"), { code: "MEMORY_CHECKPOINT_IDEMPOTENCY_CONFLICT" });
    }
    if (current?.status === "committed" && current.committed_at) {
      if (this.analyticsEnabled) {
        await this.enqueueAnalytics(client, request, current.id, "replayed", current.committed_at);
      }
      return {
        checkpointId: current.id,
        evidenceDigest: current.evidence_digest,
        sourceBoundary: current.source_boundary,
        status: "replayed",
        committedAt: current.committed_at,
      };
    }

    const sourceEvent = await client.query<MemorySourceEventRow>(
      `INSERT INTO memory_source_events (
         organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, conversation_id, end_user_id, run_id, turn_id,
         source_boundary, external_event_ids, evidence, evidence_digest,
         redaction, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13, $14, $15)
       ON CONFLICT (organization_id, installation_id, run_id, turn_id, evidence_digest, source_boundary)
       DO NOTHING
       RETURNING id, organization_id, workspace_id, agent_definition_id, agent_version_id,
                 installation_id, conversation_id, end_user_id, run_id, turn_id,
                 source_boundary, evidence_digest`,
      [
        request.scope.organizationId,
        request.scope.workspaceId,
        request.scope.agentDefinitionId,
        request.scope.agentVersionId,
        request.scope.installationId,
        request.scope.conversationId ?? null,
        request.scope.endUserId ?? null,
        request.runId,
        request.turnId,
        request.sourceBoundary,
        request.evidence.sourceEventIds,
        JSON.stringify(request.evidence),
        request.evidence.evidenceDigest,
        request.evidence.redaction,
        request.evidence.capturedAt,
      ],
    );
    let sourceEventRow = sourceEvent.rows[0];
    if (!sourceEventRow) {
      sourceEventRow = (await client.query<MemorySourceEventRow>(
        `SELECT id, organization_id, workspace_id, agent_definition_id, agent_version_id,
                installation_id, conversation_id, end_user_id, run_id, turn_id,
                source_boundary, evidence_digest
         FROM memory_source_events
         WHERE organization_id = $1 AND evidence_digest = $2 AND source_boundary = $3
           AND installation_id = $4 AND run_id = $5 AND turn_id = $6
         FOR UPDATE`,
        [request.scope.organizationId, request.evidence.evidenceDigest, request.sourceBoundary, request.scope.installationId, request.runId, request.turnId],
      )).rows[0];
    }
    if (sourceEventRow && (
      sourceEventRow.organization_id !== request.scope.organizationId
      || sourceEventRow.workspace_id !== request.scope.workspaceId
      || sourceEventRow.agent_definition_id !== request.scope.agentDefinitionId
      || sourceEventRow.agent_version_id !== (request.scope.agentVersionId ?? null)
      || sourceEventRow.installation_id !== request.scope.installationId
      || sourceEventRow.conversation_id !== (request.scope.conversationId ?? null)
      || sourceEventRow.end_user_id !== (request.scope.endUserId ?? null)
      || sourceEventRow.run_id !== request.runId
      || sourceEventRow.turn_id !== request.turnId
      || sourceEventRow.source_boundary !== request.sourceBoundary
      || sourceEventRow.evidence_digest !== request.evidence.evidenceDigest
    )) {
      throw Object.assign(new Error("Memory source event identity conflict"), { code: "MEMORY_SOURCE_EVENT_IDENTITY_CONFLICT" });
    }
    const sourceEventId = sourceEventRow?.id;
    if (!sourceEventId) throw new Error("Memory source event was not persisted");

    const checkpoint = await client.query<MemoryCheckpointRow>(
      `INSERT INTO memory_checkpoints (
         organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, conversation_id, run_id, turn_id,
         compaction_generation, source_boundary, evidence_digest,
         idempotency_key, source_event_id, status, committed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'committed', now())
       ON CONFLICT (organization_id, idempotency_key)
       DO NOTHING
       RETURNING id, evidence_digest, source_boundary, status, committed_at`,
      [
        request.scope.organizationId,
        request.scope.workspaceId,
        request.scope.agentDefinitionId,
        request.scope.agentVersionId,
        request.scope.installationId,
        request.scope.conversationId ?? null,
        request.runId,
        request.turnId,
        request.compactionGeneration,
        request.sourceBoundary,
        request.evidence.evidenceDigest,
        request.idempotencyKey,
        sourceEventId,
      ],
    );
    let committed = checkpoint.rows[0];
    let resultStatus: "committed" | "replayed" = checkpoint.rows[0] ? "committed" : "replayed";
    if (!committed) committed = (await client.query<MemoryCheckpointRow>(
      `SELECT id, evidence_digest, source_boundary, status, committed_at
       FROM memory_checkpoints
       WHERE organization_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [request.scope.organizationId, request.idempotencyKey],
    )).rows[0];
    if (committed && !committed.committed_at) {
      const retried = await client.query<MemoryCheckpointRow>(
        `UPDATE memory_checkpoints
         SET source_event_id = $2, status = 'committed', committed_at = now(),
             error_code = NULL, error_digest = NULL
         WHERE id = $1
         RETURNING id, evidence_digest, source_boundary, status, committed_at`,
        [committed.id, sourceEventId],
      );
      committed = retried.rows[0] ?? committed;
      resultStatus = "committed";
    }
    if (!committed?.committed_at) throw new Error("Memory checkpoint was not committed");
    if (this.analyticsEnabled) {
      await this.enqueueAnalytics(client, request, committed.id, resultStatus, committed.committed_at);
    }
    return {
      checkpointId: committed.id,
      evidenceDigest: committed.evidence_digest,
      sourceBoundary: committed.source_boundary,
      // The initial existence check is intentionally not used for this status:
      // two transactions can both observe no row before either inserts.  The
      // insert result is the authoritative winner; a follow-up row means this
      // call lost the idempotency race and replayed the winner.
      status: resultStatus,
      committedAt: committed.committed_at,
    };
  }

  private async enqueueAnalytics(
    client: PoolClient,
    request: MemoryCheckpointRequest,
    checkpointId: string,
    status: "committed" | "replayed",
    occurredAt: string,
  ): Promise<void> {
    const namespace = request.scope.conversationId
      ? "conversation"
      : request.scope.endUserId
        ? "end_user_private"
        : "workspace_shared";
    await enqueueMemoryLifecycleEvent(client, {
      organizationId: request.scope.organizationId,
      workspaceId: request.scope.workspaceId,
      agentDefinitionId: request.scope.agentDefinitionId,
      agentVersionId: request.scope.agentVersionId,
      installationId: request.scope.installationId,
      checkpointId,
      runId: request.runId,
      memoryKind: "working",
      namespace,
      action: "checkpoint",
      status,
      sourceEventCount: request.evidence.sourceEventIds.length,
      reasonCode: "compaction",
      occurredAt,
      causationId: request.evidence.evidenceDigest,
    });
  }

  public async markBlocked(input: { organizationId: string; idempotencyKey: string; errorCode: string; error?: string }): Promise<void> {
    await query(this.pool,
      `UPDATE memory_checkpoints
       SET status = 'blocked', committed_at = NULL, error_code = $3, error_digest = $4
       WHERE organization_id = $1 AND idempotency_key = $2 AND status <> 'committed'`,
      [input.organizationId, input.idempotencyKey, input.errorCode.slice(0, 120), input.error ? boundedDigest(input.error) : null]);
  }

  public async markFailed(input: { organizationId: string; idempotencyKey: string; errorCode: string; error?: string }): Promise<void> {
    await query(this.pool,
      `UPDATE memory_checkpoints
       SET status = 'failed', committed_at = NULL, error_code = $3, error_digest = $4
       WHERE organization_id = $1 AND idempotency_key = $2 AND status <> 'committed'`,
      [input.organizationId, input.idempotencyKey, input.errorCode.slice(0, 120), input.error ? boundedDigest(input.error) : null]);
  }
}

export { validateCheckpointRequest };
