import type { Pool } from "pg";
import { query } from "../db/pool";
import { MemoryDeletionJobRepository } from "../db/repositories/memory-deletion-job-repository";
import { MemoryRevisionCommandService } from "./revision-command-service";

type LegacyNamespace = "conversation" | "user_private" | "organization_shared" | "agent_private";
type LegacySourceType = "explicit" | "imported" | "inferred";
type CanonicalLifecycle = "observed" | "candidate" | "active" | "review_pending" | "quarantined" | "superseded" | "expired" | "rejected" | "deleted";

export interface MemoryHttpRecord {
  id: string;
  namespace: LegacyNamespace;
  memory_type: "semantic" | "episodic";
  canonical_text: string;
  content: Record<string, unknown>;
  source_type: LegacySourceType;
  provenance: Record<string, unknown>;
  sensitivity: "normal" | "sensitive" | "restricted";
  confidence: number | null;
  fact_key: string;
  supersedes_memory_id: string | null;
  superseded_at: string | null;
  status: CanonicalLifecycle | "rejected";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  fact_id: string;
  revision_id: string;
}

export interface MemoryHttpAdmin {
  list(input: {
    organizationId: string;
    agentId: string;
    installationId?: string;
    limit?: number;
    reviewable?: boolean;
  }): Promise<MemoryHttpRecord[]>;
  delete(input: {
    organizationId: string;
    actorId: string;
    memoryId: string;
    agentId: string;
    installationId?: string;
    conversationId?: string;
  }): Promise<void>;
  revalidate(input: {
    organizationId: string;
    actorId: string;
    memoryId: string;
    agentId: string;
    installationId?: string;
    conversationId?: string;
    expiresAt?: string | null;
    operationId: string;
  }): Promise<MemoryHttpRecord>;
  review(input: {
    organizationId: string;
    actorId: string;
    memoryId: string;
    agentId: string;
    installationId?: string;
    conversationId?: string;
    decision: "approve" | "reject";
    operationId: string;
  }): Promise<MemoryHttpRecord>;
}

interface CanonicalMemoryRow {
  fact_id: string;
  revision_id: string;
  organization_id: string;
  workspace_id: string;
  agent_definition_id: string;
  installation_id: string;
  agent_version_id: string | null;
  conversation_id: string | null;
  end_user_id: string | null;
  namespace: "conversation" | "end_user_private" | "workspace_shared" | "agent_private";
  memory_type: "semantic" | "episodic";
  fact_key: string;
  lifecycle_state: CanonicalLifecycle;
  canonical_text: string;
  typed_value: unknown;
  valid_from: string | Date;
  valid_to: string | Date | null;
  confidence: number | string | null;
  sensitivity: "normal" | "sensitive" | "restricted";
  source_trust: "user_explicit" | "platform_curated" | "model_inferred" | "imported" | "system_observed";
  provenance: unknown;
  created_at: string | Date;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function legacyNamespace(value: CanonicalMemoryRow["namespace"]): LegacyNamespace {
  switch (value) {
    case "end_user_private": return "user_private";
    case "workspace_shared": return "organization_shared";
    default: return value;
  }
}

function legacySourceType(value: CanonicalMemoryRow["source_trust"]): LegacySourceType {
  if (value === "imported") return "imported";
  if (value === "model_inferred") return "inferred";
  return "explicit";
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toRecord(row: CanonicalMemoryRow): MemoryHttpRecord {
  return {
    id: row.revision_id,
    namespace: legacyNamespace(row.namespace),
    memory_type: row.memory_type,
    canonical_text: row.canonical_text,
    content: asRecord(row.typed_value),
    source_type: legacySourceType(row.source_trust),
    provenance: asRecord(row.provenance),
    sensitivity: row.sensitivity,
    confidence: row.confidence === null ? null : Number(row.confidence),
    fact_key: row.fact_key,
    supersedes_memory_id: null,
    superseded_at: null,
    status: row.lifecycle_state,
    expires_at: iso(row.valid_to),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.created_at).toISOString(),
    fact_id: row.fact_id,
    revision_id: row.revision_id,
  };
}

const rowColumns = `
  fact.id::text AS fact_id,
  revision.id::text AS revision_id,
  fact.organization_id,
  fact.workspace_id,
  fact.agent_definition_id::text AS agent_definition_id,
  fact.installation_id::text AS installation_id,
  fact.agent_version_id::text AS agent_version_id,
  fact.conversation_id::text AS conversation_id,
  fact.end_user_id,
  fact.namespace,
  fact.memory_type,
  fact.fact_key,
  revision.lifecycle_state,
  revision.canonical_text,
  revision.typed_value,
  revision.valid_from,
  revision.valid_to,
  revision.confidence,
  revision.sensitivity,
  revision.source_trust,
  revision.provenance,
  revision.created_at`;

export class CanonicalMemoryHttpAdmin implements MemoryHttpAdmin {
  public constructor(
    private readonly pool: Pool,
    private readonly deletionJobs: MemoryDeletionJobRepository,
    private readonly revisionCommands: MemoryRevisionCommandService,
  ) {}

  public async list(input: Parameters<MemoryHttpAdmin["list"]>[0]): Promise<MemoryHttpRecord[]> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500));
    const lifecycle: CanonicalLifecycle[] = input.reviewable ? ["active", "review_pending", "quarantined"] : ["active"];
    const result = await query<CanonicalMemoryRow>(
      this.pool,
      `SELECT ${rowColumns}
       FROM agent_memory_facts fact
       JOIN LATERAL (
         SELECT revision.*
         FROM agent_memory_revisions revision
         WHERE revision.fact_id = fact.id
         ORDER BY revision.revision_number DESC
         LIMIT 1
       ) revision ON TRUE
       WHERE fact.organization_id = $1
         AND fact.agent_definition_id = $2
         AND ($3::uuid IS NULL OR fact.installation_id = $3::uuid)
         AND revision.lifecycle_state = ANY($4::text[])
       ORDER BY revision.created_at DESC, revision.id DESC
       LIMIT $5`,
      [input.organizationId, input.agentId, input.installationId ?? null, lifecycle, limit],
    );
    return result.rows.map(toRecord);
  }

  private async target(input: {
    organizationId: string;
    memoryId: string;
    agentId: string;
    installationId?: string;
    conversationId?: string;
  }): Promise<CanonicalMemoryRow> {
    const result = await query<CanonicalMemoryRow>(
      this.pool,
      `SELECT ${rowColumns}
       FROM agent_memory_facts fact
       JOIN agent_memory_revisions revision ON revision.fact_id = fact.id
       WHERE fact.organization_id = $1
         AND fact.agent_definition_id = $2
         AND ($3::uuid IS NULL OR fact.installation_id = $3::uuid)
         AND ($4::uuid IS NULL OR fact.conversation_id = $4::uuid)
         AND (fact.id::text = $5 OR revision.id::text = $5)
       ORDER BY CASE WHEN revision.id::text = $5 THEN 0 ELSE 1 END,
                revision.revision_number DESC
       LIMIT 1`,
      [input.organizationId, input.agentId, input.installationId ?? null, input.conversationId ?? null, input.memoryId],
    );
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Memory revision not found"), { statusCode: 404 });
    return row;
  }

  public async delete(input: Parameters<MemoryHttpAdmin["delete"]>[0]): Promise<void> {
    const row = await this.target(input);
    if (row.lifecycle_state !== "active") {
      throw Object.assign(new Error("Only active canonical memory revisions can be deleted"), { statusCode: 409 });
    }
    await this.deletionJobs.enqueue({
      organizationId: input.organizationId,
      requestedBy: input.actorId,
      targetType: "memory",
      targetId: row.fact_id,
    });
  }

  public async revalidate(input: Parameters<MemoryHttpAdmin["revalidate"]>[0]): Promise<MemoryHttpRecord> {
    const row = await this.target(input);
    const result = await this.revisionCommands.operatorTransition({
      organizationId: input.organizationId,
      revisionId: row.revision_id,
      actorId: input.actorId,
      operationId: input.operationId,
      command: "revalidate",
      validTo: input.expiresAt,
    });
    return toRecord({ ...row, revision_id: result.revision.id, lifecycle_state: "active", valid_to: result.revision.validTo ? result.revision.validTo : null, created_at: result.revision.createdAt });
  }

  public async review(input: Parameters<MemoryHttpAdmin["review"]>[0]): Promise<MemoryHttpRecord> {
    const row = await this.target(input);
    if (row.lifecycle_state !== "review_pending" && row.lifecycle_state !== "quarantined") {
      throw Object.assign(new Error("Only review-pending or quarantined canonical memory revisions can be reviewed"), { statusCode: 409 });
    }
    const result = await this.revisionCommands.operatorTransition({
      organizationId: input.organizationId,
      revisionId: row.revision_id,
      actorId: input.actorId,
      operationId: input.operationId,
      command: input.decision,
    });
    return toRecord({ ...row, revision_id: result.revision.id, lifecycle_state: input.decision === "approve" ? "active" : "rejected" as CanonicalLifecycle, created_at: result.revision.createdAt });
  }
}
