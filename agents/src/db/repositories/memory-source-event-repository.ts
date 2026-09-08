import type { Pool } from "pg";
import { evidenceDigest, type MemoryEvidenceEnvelope, type MemoryScope } from "../../memory/contracts";
import { query, withTransaction } from "../pool";

export interface MemorySourceEventInput {
  scope: Omit<MemoryScope, "namespace"> & { runId?: string; turnId?: string };
  eventType: string;
  sourceBoundary: string;
  evidence: MemoryEvidenceEnvelope;
  idempotencyKey: string;
  eventSequence?: number;
  channel?: string;
  extractionVersion?: string;
  occurredAt?: string;
}

export interface MemorySourceEventRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  installationId: string;
  conversationId?: string;
  endUserId?: string;
  runId?: string;
  turnId?: string;
  eventType: string;
  sourceBoundary: string;
  sourceEventIds: string[];
  evidence: MemoryEvidenceEnvelope;
  evidenceDigest: string;
  idempotencyKey: string;
  eventSequence?: number;
  channel?: string;
  extractionVersion: string;
  occurredAt: string;
  createdAt: string;
}

interface SourceEventRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  installation_id: string;
  conversation_id: string | null;
  end_user_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  event_type: string;
  source_boundary: string;
  external_event_ids: string[];
  evidence: MemoryEvidenceEnvelope;
  evidence_digest: string;
  redaction: "content_present" | "content_redacted";
  idempotency_key: string | null;
  event_sequence: number | string | null;
  channel: string | null;
  extraction_version: string;
  occurred_at: string | Date;
  created_at: string | Date;
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

function eventSequence(value: number | string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function sourceEventIdentityMatches(row: SourceEventRow, input: MemorySourceEventInput): boolean {
  const legacyDigestReplay = row.idempotency_key === null
    && row.evidence_digest === input.evidence.evidenceDigest
    && row.source_boundary === input.sourceBoundary;
  return row.organization_id === input.scope.organizationId
    && row.workspace_id === input.scope.workspaceId
    && row.agent_definition_id === input.scope.agentDefinitionId
    && row.agent_version_id === input.scope.agentVersionId
    && row.installation_id === input.scope.installationId
    && row.conversation_id === nullable(input.scope.conversationId)
    && row.end_user_id === nullable(input.scope.endUserId)
    && row.run_id === nullable(input.scope.runId)
    && row.turn_id === nullable(input.scope.turnId)
    && row.event_type === input.eventType
    && row.source_boundary === input.sourceBoundary
    && row.evidence_digest === input.evidence.evidenceDigest
    && (row.idempotency_key === input.idempotencyKey || legacyDigestReplay)
    && eventSequence(row.event_sequence) === eventSequence(input.eventSequence)
    && row.channel === nullable(input.channel?.trim() || undefined);
}

function required(value: string, field: string, max = 240): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field.toUpperCase()}_REQUIRED`);
  if (normalized.length > max) throw new Error(`${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

function rowToRecord(row: SourceEventRow): MemorySourceEventRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    agentVersionId: row.agent_version_id,
    installationId: row.installation_id,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.end_user_id ? { endUserId: row.end_user_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    eventType: row.event_type,
    sourceBoundary: row.source_boundary,
    sourceEventIds: row.external_event_ids ?? [],
    evidence: row.evidence,
    evidenceDigest: row.evidence_digest,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : { idempotencyKey: `legacy:${row.id}` }),
    ...(row.event_sequence === null ? {} : { eventSequence: Number(row.event_sequence) }),
    ...(row.channel ? { channel: row.channel } : {}),
    extractionVersion: row.extraction_version,
    occurredAt: new Date(row.occurred_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function validate(input: MemorySourceEventInput): void {
  required(input.scope.organizationId, "organization_id");
  required(input.scope.workspaceId, "workspace_id");
  required(input.scope.agentDefinitionId, "agent_definition_id");
  required(input.scope.agentVersionId, "agent_version_id");
  required(input.scope.installationId, "installation_id");
  required(input.eventType, "event_type", 160);
  required(input.sourceBoundary, "source_boundary");
  required(input.idempotencyKey, "idempotency_key");
  const digest = evidenceDigest(input.evidence.items);
  if (digest !== input.evidence.evidenceDigest) throw new Error("MEMORY_SOURCE_EVENT_DIGEST_MISMATCH");
  if (input.evidence.scope.organizationId !== input.scope.organizationId
    || input.evidence.scope.workspaceId !== input.scope.workspaceId
    || input.evidence.scope.agentDefinitionId !== input.scope.agentDefinitionId
    || input.evidence.scope.agentVersionId !== input.scope.agentVersionId
    || input.evidence.scope.installationId !== input.scope.installationId) {
    throw new Error("MEMORY_SOURCE_EVENT_SCOPE_MISMATCH");
  }
  if (input.eventSequence !== undefined && (!Number.isSafeInteger(input.eventSequence) || input.eventSequence < 0)) throw new Error("MEMORY_SOURCE_EVENT_SEQUENCE_INVALID");
}

const columns = `id, organization_id, workspace_id, agent_definition_id, agent_version_id,
  installation_id, conversation_id, end_user_id, run_id, turn_id, event_type,
  source_boundary, external_event_ids, evidence, evidence_digest, redaction, idempotency_key,
  event_sequence, channel, extraction_version, occurred_at, created_at`;

export class MemorySourceEventRepository {
  public constructor(private readonly pool: Pool) {}

  public async record(input: MemorySourceEventInput): Promise<{ status: "created" | "replayed"; event: MemorySourceEventRecord }> {
    validate(input);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<SourceEventRow>(
        `INSERT INTO memory_source_events (
           organization_id, workspace_id, agent_definition_id, agent_version_id,
           installation_id, conversation_id, end_user_id, run_id, turn_id,
           event_type, source_boundary, external_event_ids, evidence, evidence_digest,
           redaction, idempotency_key, event_sequence, channel, extraction_version, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13::jsonb,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT DO NOTHING
         RETURNING ${columns}`,
        [
          input.scope.organizationId,
          input.scope.workspaceId,
          input.scope.agentDefinitionId,
          input.scope.agentVersionId,
          input.scope.installationId,
          input.scope.conversationId ?? null,
          input.scope.endUserId ?? null,
          input.scope.runId,
          input.scope.turnId,
          input.eventType,
          input.sourceBoundary,
          input.evidence.sourceEventIds,
          JSON.stringify(input.evidence),
          input.evidence.evidenceDigest,
          input.evidence.redaction,
          input.idempotencyKey,
          input.eventSequence ?? null,
          input.channel?.trim() || null,
          input.extractionVersion?.trim() || "capture-v2",
          input.occurredAt ?? input.evidence.capturedAt,
        ],
      );
      if (inserted.rows[0]) return { status: "created", event: rowToRecord(inserted.rows[0]) };
      const existing = await client.query<SourceEventRow>(
        `SELECT ${columns} FROM memory_source_events
         WHERE organization_id = $1 AND (
           idempotency_key = $2
           OR (evidence_digest = $3 AND source_boundary = $4)
           OR (run_id = $5::uuid AND event_sequence = $6::bigint)
         )
         ORDER BY CASE
           WHEN idempotency_key = $2 THEN 0
           WHEN evidence_digest = $3 AND source_boundary = $4 THEN 1
           ELSE 2
         END, created_at ASC
         LIMIT 1 FOR UPDATE`,
        [input.scope.organizationId, input.idempotencyKey, input.evidence.evidenceDigest, input.sourceBoundary, input.scope.runId ?? null, input.eventSequence ?? null],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("MEMORY_SOURCE_EVENT_REPLAY_NOT_FOUND");
      if (input.eventSequence !== undefined
        && row.run_id === input.scope.runId
        && row.event_sequence !== null
        && Number(row.event_sequence) === input.eventSequence
        && row.idempotency_key !== input.idempotencyKey) {
        throw Object.assign(new Error("Memory source event sequence was already admitted for this run"), { code: "MEMORY_SOURCE_EVENT_SEQUENCE_CONFLICT" });
      }
      if (!sourceEventIdentityMatches(row, input)) {
        throw Object.assign(new Error("Memory source event identity was reused for a different event"), { code: "MEMORY_SOURCE_EVENT_IDENTITY_CONFLICT" });
      }
      return { status: "replayed", event: rowToRecord(row) };
    });
  }

  public async listAfter(input: { organizationId: string; runId: string; afterSequence?: number; limit?: number }): Promise<MemorySourceEventRecord[]> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 200), 1_000));
    const result = await query<SourceEventRow>(this.pool, `SELECT ${columns}
      FROM memory_source_events
      WHERE organization_id = $1 AND run_id = $2 AND COALESCE(event_sequence, 0) > $3
      ORDER BY COALESCE(event_sequence, 0) ASC, occurred_at ASC, id ASC LIMIT $4`,
      [input.organizationId, input.runId, Math.max(0, Math.trunc(input.afterSequence ?? 0)), limit]);
    return result.rows.map(rowToRecord);
  }
}

export { validate as validateMemorySourceEvent };
