import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { query, withTransaction } from "../db/pool";
import { MemoryRevisionRepository } from "../db/repositories/memory-revision-repository";
import { canonicalFactKey } from "./contracts";

type LegacyNamespace = "conversation" | "user_private" | "organization_shared" | "agent_private";
type LegacyMemoryType = "working" | "semantic" | "episodic" | "procedural";

export interface LegacyMemoryRow {
  id: string;
  organization_id: string;
  agent_definition_id: string | null;
  installation_id: string | null;
  agent_version_id: string | null;
  workspace_id: string | null;
  conversation_id: string | null;
  owner_user_id: string | null;
  namespace: LegacyNamespace;
  memory_type: LegacyMemoryType;
  canonical_text: string;
  content: Record<string, unknown>;
  source_type: "explicit" | "imported" | "inferred";
  provenance: Record<string, unknown>;
  sensitivity: "normal" | "sensitive" | "restricted";
  confidence: number | null;
  fact_key: string | null;
  supersedes_memory_id: string | null;
  status: "active" | "deleted" | "expired" | "review_pending" | "quarantined" | "superseded" | "rejected";
  expires_at: string | null;
  last_revalidated_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryMigrationMapping {
  status: "migrated" | "skipped";
  reason?: "summary_not_promoted" | "procedural_separate" | "missing_scope";
  namespace?: "conversation" | "end_user_private" | "workspace_shared" | "agent_private";
  memoryType?: "semantic" | "episodic";
  lifecycleState?: "active" | "deleted" | "expired" | "review_pending" | "quarantined" | "superseded" | "rejected";
}

export function mapLegacyMemory(row: Pick<LegacyMemoryRow, "namespace" | "memory_type" | "status" | "agent_definition_id" | "installation_id" | "workspace_id">): MemoryMigrationMapping {
  if (row.memory_type === "working") return { status: "skipped", reason: "summary_not_promoted" };
  if (row.memory_type === "procedural") return { status: "skipped", reason: "procedural_separate" };
  if (!row.agent_definition_id || !row.installation_id || !row.workspace_id) return { status: "skipped", reason: "missing_scope" };
  const namespace = row.namespace === "user_private" ? "end_user_private" : row.namespace === "organization_shared" ? "workspace_shared" : row.namespace;
  return { status: "migrated", namespace, memoryType: row.memory_type, lifecycleState: row.status };
}

function checksum(row: LegacyMemoryRow): string {
  return createHash("sha256").update(JSON.stringify({
    id: row.id,
    canonicalText: row.canonical_text,
    content: row.content,
    status: row.status,
    factKey: row.fact_key,
    supersedesMemoryId: row.supersedes_memory_id,
    updatedAt: row.updated_at,
  })).digest("hex");
}

interface ReceiptRow {
  id: string;
  source_checksum: string;
  status: "dry_run" | "migrated" | "skipped" | "failed";
  canonical_fact_id: string | null;
  canonical_revision_id: string | null;
}

export interface MemoryBackfillReport {
  dryRun: boolean;
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  receipts: number;
  sourceCounts: MemoryBackfillDimensionCounts;
  targetCounts: MemoryBackfillDimensionCounts;
}

export interface MemoryBackfillDimensionCounts {
  organization: Record<string, number>;
  workspace: Record<string, number>;
  agent: Record<string, number>;
  namespace: Record<string, number>;
  state: Record<string, number>;
  type: Record<string, number>;
  sensitivity: Record<string, number>;
}

function emptyDimensionCounts(): MemoryBackfillDimensionCounts {
  return {
    organization: {},
    workspace: {},
    agent: {},
    namespace: {},
    state: {},
    type: {},
    sensitivity: {},
  };
}

function incrementDimension(counts: Record<string, number>, value: string | null | undefined): void {
  const key = value?.trim() || "__missing__";
  counts[key] = (counts[key] ?? 0) + 1;
}

function incrementLegacyDimensions(counts: MemoryBackfillDimensionCounts, row: Pick<LegacyMemoryRow, "organization_id" | "workspace_id" | "agent_definition_id" | "namespace" | "status" | "memory_type" | "sensitivity">): void {
  incrementDimension(counts.organization, row.organization_id);
  incrementDimension(counts.workspace, row.workspace_id);
  incrementDimension(counts.agent, row.agent_definition_id);
  incrementDimension(counts.namespace, row.namespace);
  incrementDimension(counts.state, row.status);
  incrementDimension(counts.type, row.memory_type);
  incrementDimension(counts.sensitivity, row.sensitivity);
}

function incrementTargetDimensions(counts: MemoryBackfillDimensionCounts, row: { organization_id: string; workspace_id: string; agent_definition_id: string; namespace: string; lifecycle_state: string; memory_type: string; sensitivity: string }): void {
  incrementDimension(counts.organization, row.organization_id);
  incrementDimension(counts.workspace, row.workspace_id);
  incrementDimension(counts.agent, row.agent_definition_id);
  incrementDimension(counts.namespace, row.namespace);
  incrementDimension(counts.state, row.lifecycle_state);
  incrementDimension(counts.type, row.memory_type);
  incrementDimension(counts.sensitivity, row.sensitivity);
}

/** Resumable legacy-to-v2 backfill. Knowledge and procedural data remain on their own interfaces. */
export class MemoryBackfillService {
  public constructor(private readonly pool: Pool, private readonly revisions: MemoryRevisionRepository = new MemoryRevisionRepository(pool)) {}

  public async run(input: { organizationId: string; dryRun: boolean; limit?: number }): Promise<MemoryBackfillReport> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 500), 5_000));
    const rows = await query<LegacyMemoryRow>(this.pool, `
      SELECT memory.id, memory.organization_id, memory.agent_definition_id, memory.installation_id,
             installation.agent_version_id, installation.scope_id AS workspace_id,
             memory.conversation_id, memory.owner_user_id, memory.namespace, memory.memory_type,
             memory.canonical_text, memory.content, memory.source_type, memory.provenance,
             memory.sensitivity, memory.confidence, memory.fact_key, memory.supersedes_memory_id,
             memory.status, memory.expires_at, memory.last_revalidated_at, memory.created_by,
             memory.created_at, memory.updated_at
      FROM memory_records memory
      LEFT JOIN agent_installations installation ON installation.id = memory.installation_id
      WHERE memory.organization_id = $1
      ORDER BY memory.created_at ASC, memory.id ASC
      LIMIT $2`, [input.organizationId, limit]);
    const sourceCounts = emptyDimensionCounts();
    for (const row of rows.rows) incrementLegacyDimensions(sourceCounts, row);
    const report: MemoryBackfillReport = { dryRun: input.dryRun, scanned: rows.rows.length, migrated: 0, skipped: 0, failed: 0, receipts: 0, sourceCounts, targetCounts: emptyDimensionCounts() };
    for (const row of rows.rows) {
      const result = await this.migrateRow(row, input.dryRun);
      report.receipts += 1;
      if (result === "migrated") report.migrated += 1;
      else if (result === "skipped") report.skipped += 1;
      else report.failed += 1;
    }
    const targetRows = await query<{ organization_id: string; workspace_id: string; agent_definition_id: string; namespace: string; lifecycle_state: string; memory_type: string; sensitivity: string }>(this.pool, `
      SELECT revision.organization_id, fact.workspace_id, fact.agent_definition_id,
             fact.namespace, revision.lifecycle_state, fact.memory_type, revision.sensitivity
      FROM agent_memory_revisions revision
      JOIN agent_memory_facts fact ON fact.id = revision.fact_id
      WHERE revision.organization_id = $1`, [input.organizationId]);
    for (const row of targetRows.rows) incrementTargetDimensions(report.targetCounts, row);
    return report;
  }

  private async migrateRow(row: LegacyMemoryRow, dryRun: boolean): Promise<"migrated" | "skipped" | "failed"> {
    const sourceChecksum = checksum(row);
    const existing = await query<ReceiptRow>(this.pool, `SELECT id, source_checksum, status, canonical_fact_id, canonical_revision_id
      FROM agent_memory_migration_receipts WHERE organization_id = $1 AND legacy_memory_id = $2`, [row.organization_id, row.id]);
    if (existing.rows[0]?.status === "migrated" && existing.rows[0].source_checksum === sourceChecksum) return "migrated";
    const mapping = mapLegacyMemory(row);
    if (dryRun || mapping.status === "skipped") {
      await this.writeReceipt(row, sourceChecksum, mapping.status === "skipped" ? "skipped" : "dry_run", mapping.reason);
      return mapping.status;
    }
    try {
      const factKey = row.fact_key?.trim() || `legacy:${row.id}`;
      const subject = row.owner_user_id ? `actor:${row.owner_user_id}` : row.conversation_id ? `conversation:${row.conversation_id}` : `legacy:${row.id}`;
      const predicate = row.fact_key ? "legacy_fact" : "legacy_record";
      const fact = await this.revisions.createFact({
        organizationId: row.organization_id,
        workspaceId: row.workspace_id!,
        agentDefinitionId: row.agent_definition_id!,
        installationId: row.installation_id!,
        agentVersionId: row.agent_version_id ?? undefined,
        ...(mapping.namespace === "conversation" ? { conversationId: row.conversation_id ?? undefined } : {}),
        ...(mapping.namespace === "end_user_private" ? { endUserId: row.owner_user_id ?? undefined } : {}),
        namespace: mapping.namespace!,
        memoryType: mapping.memoryType!,
        subjectKey: subject,
        predicateKey: predicate,
        factKey: canonicalFactKey({ organizationId: row.organization_id, workspaceId: row.workspace_id!, agentDefinitionId: row.agent_definition_id!, installationId: row.installation_id!, namespace: mapping.namespace!, subject, predicate: `${predicate}:${factKey}` }),
      });
      const predecessorReceipt = row.supersedes_memory_id
        ? await query<ReceiptRow>(this.pool, `SELECT canonical_revision_id, source_checksum, status FROM agent_memory_migration_receipts WHERE organization_id = $1 AND legacy_memory_id = $2`, [row.organization_id, row.supersedes_memory_id])
        : { rows: [] as ReceiptRow[] };
      const predecessorRevisionId = predecessorReceipt.rows[0]?.status === "migrated" ? predecessorReceipt.rows[0].canonical_revision_id ?? undefined : undefined;
      const sourceOccurredAt = new Date(row.created_at).toISOString();
      const result = await this.revisions.appendRevision(fact.id, {
        memoryType: mapping.memoryType!,
        lifecycleState: mapping.lifecycleState!,
        transitionType: predecessorRevisionId ? "supersession" : "assertion",
        canonicalText: row.canonical_text,
        typedValue: row.content,
        ...(mapping.memoryType === "episodic" ? { eventTime: sourceOccurredAt, eventSummary: row.canonical_text } : {}),
        validFrom: sourceOccurredAt,
        ...(row.expires_at ? { validTo: new Date(row.expires_at).toISOString() } : {}),
        observedAt: row.last_revalidated_at ?? sourceOccurredAt,
        ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
        sourceTrust: row.source_type === "explicit" ? "user_explicit" : row.source_type === "imported" ? "imported" : "model_inferred",
        sensitivity: row.sensitivity,
        provenance: { ...row.provenance, legacyMemoryId: row.id, migrationChecksum: sourceChecksum },
        evidenceDigest: sourceChecksum,
        extractionVersion: "legacy-backfill-v1",
        sourceEventIds: [`legacy:memory:${row.id}`],
        sourceEventType: "legacy.memory_record",
        sourceOccurredAt,
        ...(predecessorRevisionId ? { predecessorRevisionId } : {}),
        idempotencyKey: `legacy-memory:${row.id}`,
        createdBy: "system:memory-backfill",
      });
      await this.writeReceipt(row, sourceChecksum, "migrated", undefined, fact.id, result.revision.id);
      return "migrated";
    } catch (error) {
      await this.writeReceipt(row, sourceChecksum, "failed", typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code).slice(0, 120) : "MEMORY_BACKFILL_FAILED");
      return "failed";
    }
  }

  private async writeReceipt(row: LegacyMemoryRow, sourceChecksum: string, status: ReceiptRow["status"], reason?: string, factId?: string, revisionId?: string): Promise<void> {
    await query(this.pool, `INSERT INTO agent_memory_migration_receipts (
      organization_id, legacy_memory_id, source_checksum, status, skip_reason, canonical_fact_id, canonical_revision_id, error_code
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (organization_id, legacy_memory_id) DO UPDATE SET source_checksum=EXCLUDED.source_checksum, status=EXCLUDED.status,
      skip_reason=EXCLUDED.skip_reason, canonical_fact_id=EXCLUDED.canonical_fact_id, canonical_revision_id=EXCLUDED.canonical_revision_id,
      error_code=EXCLUDED.error_code, updated_at=now()`,
      [row.organization_id, row.id, sourceChecksum, status, status === "skipped" ? reason ?? null : null, factId ?? null, revisionId ?? null, status === "failed" ? reason ?? "MEMORY_BACKFILL_FAILED" : null]);
  }
}

export function legacyMemoryChecksum(row: LegacyMemoryRow): string {
  return checksum(row);
}
