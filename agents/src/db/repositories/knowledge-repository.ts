import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import { assertNoActiveLegalHold } from "./legacy-memory-cleanup";
import type { MemoryScope } from "../../memory/legacy-contracts";
import { recordMemoryDeletion } from "../../telemetry/spans";
import { createEnvironmentEmbeddingProvider, embedSafely, formatPgVector, MIN_VECTOR_SIMILARITY, type EmbeddingProvider } from "../../memory/embeddings";
import { buildLexicalSearchQuery } from "../../memory/search-query";

export interface KnowledgeSourceRecord {
  id: string;
  organization_id: string;
  agent_definition_id: string | null;
  installation_id: string | null;
  name: string;
  source_type: string;
  source_uri: string | null;
  provenance: Record<string, unknown>;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunkRecord {
  id: string;
  source_id: string;
  organization_id: string;
  agent_definition_id: string | null;
  installation_id: string | null;
  revision: number;
  chunk_index: number;
  canonical_text: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
  created_at: string;
  embedding_vector?: number[] | null;
  embedding_model?: string | null;
  relevance_score?: number;
  lexical_score?: number;
  vector_score?: number;
}

export interface KnowledgeSourceDocument {
  source: KnowledgeSourceRecord;
  text: string;
}

export interface KnowledgeEmbeddingRepairResult {
  attempted: number;
  embedded: number;
}

export class KnowledgeRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly embeddingProvider: EmbeddingProvider | undefined = createEnvironmentEmbeddingProvider(),
  ) {}

  public async createSource(input: MemoryScope & {
    name: string;
    sourceType: "upload" | "url" | "platform" | "manual";
    sourceUri?: string;
    provenance?: Record<string, unknown>;
    actorId: string;
  }): Promise<KnowledgeSourceRecord> {
    const result = await query<KnowledgeSourceRecord>(
      this.pool,
      `INSERT INTO knowledge_sources
        (organization_id, agent_definition_id, installation_id, name, source_type, source_uri, provenance, created_by)
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8
       WHERE EXISTS (
         SELECT 1 FROM agent_definitions
         WHERE id = $2 AND organization_id = $1 AND status = 'active'
       )
         AND (
           $3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM agent_installations
             WHERE id = $3 AND organization_id = $1 AND agent_definition_id = $2 AND status <> 'disabled'
           )
         )
       RETURNING *`,
      [input.organizationId, input.agentId, input.installationId ?? null, input.name, input.sourceType, input.sourceUri ?? null, JSON.stringify(input.provenance ?? {}), input.actorId],
    );
    if (!result.rows[0]) throw new Error("Agent or installation not found");
    return result.rows[0]!;
  }

  public async getSource(scope: { organizationId: string; agentId?: string; installationId?: string }, sourceId: string): Promise<KnowledgeSourceRecord | null> {
    const result = await query<KnowledgeSourceRecord>(
      this.pool,
      `SELECT * FROM knowledge_sources
       WHERE id = $1 AND organization_id = $2 AND status <> 'deleted'
         AND ($3::uuid IS NULL OR agent_definition_id = $3)
         AND ($4::uuid IS NULL OR installation_id IS NULL OR installation_id = $4)`,
      [sourceId, scope.organizationId, scope.agentId ?? null, scope.installationId ?? null],
    );
    return result.rows[0] ?? null;
  }

  public async updateSource(input: {
    sourceId: string;
    scope: MemoryScope;
    status?: "active" | "processing" | "failed";
    provenance?: Record<string, unknown>;
  }): Promise<KnowledgeSourceRecord> {
    const result = await query<KnowledgeSourceRecord>(
      this.pool,
      `UPDATE knowledge_sources
       SET status = COALESCE($4, status),
           provenance = provenance || $5::jsonb,
           updated_at = now()
       WHERE id = $1 AND organization_id = $2
         AND agent_definition_id = $3
         AND (installation_id IS NULL OR installation_id = $6)
         AND status <> 'deleted'
       RETURNING *`,
      [input.sourceId, input.scope.organizationId, input.scope.agentId, input.status ?? null, JSON.stringify(input.provenance ?? {}), input.scope.installationId ?? null],
    );
    if (!result.rows[0]) throw new Error("Knowledge source not found");
    return result.rows[0];
  }

  public async getSourceDocument(scope: { organizationId: string; agentId?: string; installationId?: string }, sourceId: string): Promise<KnowledgeSourceDocument | null> {
    const source = await this.getSource(scope, sourceId);
    if (!source) return null;
    const chunks = await query<{ canonical_text: string }>(
      this.pool,
      `SELECT canonical_text FROM knowledge_chunks
       WHERE source_id = $1 AND organization_id = $2 AND revision = $3
       ORDER BY chunk_index ASC`,
      [source.id, scope.organizationId, source.revision],
    );
    return { source, text: chunks.rows.map((chunk) => chunk.canonical_text).join("\n\n") };
  }

  public async addChunks(input: {
    sourceId: string;
    scope: MemoryScope;
    revision: number;
    chunks: Array<{ text: string; metadata?: Record<string, unknown>; provenance?: Record<string, unknown> }>;
  }): Promise<KnowledgeChunkRecord[]> {
    const embeddings = await embedSafely(this.embeddingProvider, input.chunks.map((chunk) => chunk.text));
    return withTransaction(this.pool, async (client) => {
      const source = await client.query<KnowledgeSourceRecord>(
        `SELECT * FROM knowledge_sources
         WHERE id = $1 AND organization_id = $2 AND status <> 'deleted'
           AND ($3::uuid IS NULL OR agent_definition_id = $3)
           AND ($4::uuid IS NULL OR installation_id IS NULL OR installation_id = $4)
         FOR UPDATE`,
        [input.sourceId, input.scope.organizationId, input.scope.agentId ?? null, input.scope.installationId ?? null],
      );
      if (!source.rows[0]) throw new Error("Knowledge source not found");
      const chunks: KnowledgeChunkRecord[] = [];
      for (const [index, chunk] of input.chunks.entries()) {
        const created = await client.query<KnowledgeChunkRecord>(
          `INSERT INTO knowledge_chunks
            (source_id, organization_id, agent_definition_id, installation_id, revision, chunk_index, canonical_text, metadata, provenance, embedding_vector, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::vector, $11)
           ON CONFLICT (source_id, revision, chunk_index) DO UPDATE
             SET canonical_text = EXCLUDED.canonical_text, metadata = EXCLUDED.metadata, provenance = EXCLUDED.provenance,
                 embedding_vector = EXCLUDED.embedding_vector, embedding_model = EXCLUDED.embedding_model
           RETURNING *`,
          [input.sourceId, input.scope.organizationId, input.scope.agentId, input.scope.installationId ?? null, input.revision, index, chunk.text, JSON.stringify(chunk.metadata ?? {}), JSON.stringify(chunk.provenance ?? {}), formatPgVector(embeddings?.[index]), embeddings?.[index] ? this.embeddingProvider?.model ?? null : null],
        );
        chunks.push(created.rows[0]!);
      }
      await client.query(
        `UPDATE knowledge_sources
         SET revision = $2,
             provenance = provenance || $3::jsonb,
             updated_at = now()
         WHERE id = $1`,
        [
          input.sourceId,
          input.revision,
          JSON.stringify({
            indexing: {
              status: embeddings?.length === input.chunks.length ? "ready" : "lexical_only",
              embeddedChunkCount: embeddings?.length ?? 0,
              chunkCount: input.chunks.length,
              embeddingModel: this.embeddingProvider?.model ?? null,
              checkedAt: new Date().toISOString(),
            },
          }),
        ],
      );
      return chunks;
    });
  }

  /**
   * Repairs chunks written before embeddings were enabled. This is deliberately
   * safe to call from retrieval: canonical text remains available through the
   * lexical path if the provider is unavailable, while the next run can retry.
   */
  public async ensureEmbeddings(scope: MemoryScope, limit = 50): Promise<KnowledgeEmbeddingRepairResult> {
    const embeddingProvider = this.embeddingProvider;
    if (!embeddingProvider) return { attempted: 0, embedded: 0 };
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const candidates = await query<Pick<KnowledgeChunkRecord, "id" | "source_id" | "revision" | "canonical_text">>(
      this.pool,
      `SELECT kc.id, kc.source_id, kc.revision, kc.canonical_text
       FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON ks.id = kc.source_id AND ks.status = 'active'
       WHERE kc.organization_id = $1
         AND kc.agent_definition_id = $2
         AND (kc.installation_id IS NULL OR kc.installation_id = $3)
         AND kc.revision = ks.revision
         AND (kc.embedding_vector IS NULL OR kc.embedding_model IS DISTINCT FROM $4)
       ORDER BY kc.created_at ASC
       LIMIT $5`,
      [scope.organizationId, scope.agentId, scope.installationId ?? null, embeddingProvider.model, boundedLimit],
    );
    if (!candidates.rows.length) return { attempted: 0, embedded: 0 };
    const embeddings = await embedSafely(embeddingProvider, candidates.rows.map((candidate) => candidate.canonical_text));
    if (!embeddings?.length) return { attempted: candidates.rows.length, embedded: 0 };
    let embedded = 0;
    const sourceIds = [...new Set(candidates.rows.map((candidate) => candidate.source_id))];
    await withTransaction(this.pool, async (client) => {
      for (const [index, candidate] of candidates.rows.entries()) {
        const vector = formatPgVector(embeddings[index]);
        if (!vector) continue;
        const updated = await client.query(
          `UPDATE knowledge_chunks kc
           SET embedding_vector = $2::vector, embedding_model = $3
           FROM knowledge_sources ks
           WHERE kc.id = $1
             AND ks.id = kc.source_id
             AND ks.status = 'active'
             AND kc.organization_id = $4
             AND kc.agent_definition_id = $5
             AND (kc.installation_id IS NULL OR kc.installation_id = $6)
             AND kc.revision = ks.revision
           RETURNING kc.id`,
          [candidate.id, vector, embeddingProvider.model, scope.organizationId, scope.agentId, scope.installationId ?? null],
        );
        embedded += updated.rowCount ?? 0;
      }
      await client.query(
        `UPDATE knowledge_sources ks
         SET provenance = COALESCE(ks.provenance, '{}'::jsonb) || jsonb_build_object(
           'indexing',
           COALESCE(ks.provenance->'indexing', '{}'::jsonb) || jsonb_build_object(
             'status', CASE WHEN NOT EXISTS (
               SELECT 1 FROM knowledge_chunks kc
               WHERE kc.source_id = ks.id
                 AND kc.revision = ks.revision
                 AND (kc.embedding_vector IS NULL OR kc.embedding_model IS DISTINCT FROM $2)
             ) THEN 'ready' ELSE 'lexical_only' END,
             'embeddedChunkCount', (SELECT COUNT(*) FROM knowledge_chunks kc WHERE kc.source_id = ks.id AND kc.revision = ks.revision AND kc.embedding_model = $2 AND kc.embedding_vector IS NOT NULL),
             'chunkCount', (SELECT COUNT(*) FROM knowledge_chunks kc WHERE kc.source_id = ks.id AND kc.revision = ks.revision),
             'embeddingModel', $2,
             'checkedAt', to_jsonb(now())
           )
         ),
         updated_at = now()
         WHERE ks.id = ANY($1::uuid[])
           AND ks.organization_id = $3
           AND ks.agent_definition_id = $4
           AND (ks.installation_id IS NULL OR ks.installation_id = $5)
           AND ks.status = 'active'`,
        [sourceIds, embeddingProvider.model, scope.organizationId, scope.agentId, scope.installationId ?? null],
      );
    });
    return { attempted: candidates.rows.length, embedded };
  }

  public async search(scope: MemoryScope, searchText: string, limit = 8, queryEmbedding?: readonly number[]): Promise<KnowledgeChunkRecord[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const lexicalQuery = buildLexicalSearchQuery(searchText);
    const lexical = query<KnowledgeChunkRecord & { lexical_score: number }>(
      this.pool,
      `SELECT kc.*, LEAST(1, ts_rank_cd(kc.search_vector, to_tsquery('simple', $4))) AS lexical_score FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON ks.id = kc.source_id AND ks.status = 'active'
       WHERE kc.organization_id = $1
         AND kc.agent_definition_id = $2
         AND (kc.installation_id IS NULL OR kc.installation_id = $3)
         AND kc.revision = ks.revision
         AND kc.search_vector @@ to_tsquery('simple', $4)
       ORDER BY lexical_score DESC, kc.created_at DESC
       LIMIT $5`,
      [scope.organizationId, scope.agentId, scope.installationId ?? null, lexicalQuery ?? "", boundedLimit],
    );
    const vectorText = formatPgVector(queryEmbedding);
    const vector = query<KnowledgeChunkRecord & { vector_score: number }>(
      this.pool,
      `SELECT kc.*, GREATEST(0, 1 - (kc.embedding_vector <=> $4::vector)) AS vector_score FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON ks.id = kc.source_id AND ks.status = 'active'
       WHERE kc.organization_id = $1
         AND kc.agent_definition_id = $2
         AND (kc.installation_id IS NULL OR kc.installation_id = $3)
         AND kc.revision = ks.revision
         AND kc.embedding_model = $6
         AND $4::vector IS NOT NULL
         AND kc.embedding_vector IS NOT NULL
         AND 1 - (kc.embedding_vector <=> $4::vector) >= $7
       ORDER BY kc.embedding_vector <=> $4::vector ASC, kc.created_at DESC
       LIMIT $5`,
      [scope.organizationId, scope.agentId, scope.installationId ?? null, vectorText, boundedLimit, this.embeddingProvider?.model ?? null, MIN_VECTOR_SIMILARITY],
    );
    const [lexicalResult, vectorResult] = await Promise.all([lexical, vector]);
    const merged = new Map<string, KnowledgeChunkRecord & { lexical_score?: number; vector_score?: number }>();
    for (const row of lexicalResult.rows) merged.set(row.id, { ...row, lexical_score: Number(row.lexical_score) });
    for (const row of vectorResult.rows) {
      const existing = merged.get(row.id);
      merged.set(row.id, { ...(existing ?? row), vector_score: Number(row.vector_score) });
    }
    return [...merged.values()]
      .map((row) => {
        const lexicalScore = Number(row.lexical_score ?? 0);
        const vectorScore = Number(row.vector_score ?? 0);
        return { ...row, relevance_score: vectorText ? lexicalScore * 0.55 + vectorScore * 0.45 : lexicalScore };
      })
      .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0) || right.created_at.localeCompare(left.created_at));
  }

  public async listSources(scope: { organizationId: string; agentId?: string; installationId?: string }, limit = 100): Promise<KnowledgeSourceRecord[]> {
    const result = await query<KnowledgeSourceRecord>(this.pool, `SELECT * FROM knowledge_sources WHERE organization_id = $1 AND status <> 'deleted' AND ($2::uuid IS NULL OR agent_definition_id = $2) AND ($3::uuid IS NULL OR installation_id IS NULL OR installation_id = $3) ORDER BY created_at DESC LIMIT $4`, [scope.organizationId, scope.agentId ?? null, scope.installationId ?? null, Math.max(1, Math.min(limit, 500))]);
    return result.rows;
  }

  public async deleteSource(scope: MemoryScope, sourceId: string, requestedBy: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<Pick<KnowledgeSourceRecord, "id" | "installation_id">>(
        `SELECT id, installation_id
         FROM knowledge_sources
         WHERE id = $1 AND organization_id = $2
           AND agent_definition_id = $3
           AND (installation_id IS NULL OR installation_id = $4)
         FOR UPDATE`,
        [sourceId, scope.organizationId, scope.agentId, scope.installationId ?? null],
      );
      if (!result.rows[0]) throw new Error("Knowledge source not found");
      await assertNoActiveLegalHold(client, {
        organizationId: scope.organizationId,
        installationIds: result.rows[0].installation_id ? [result.rows[0].installation_id] : [],
      });
      const chunks = await client.query<{ id: string }>(
        "DELETE FROM knowledge_chunks WHERE source_id = $1 AND organization_id = $2 RETURNING id",
        [sourceId, scope.organizationId],
      );
      await client.query(
        "DELETE FROM knowledge_sources WHERE id = $1 AND organization_id = $2",
        [sourceId, scope.organizationId],
      );
      await client.query(
        `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status)
         VALUES ($1, $2, 'knowledge_source', $3, 'completed')`,
        [scope.organizationId, requestedBy, sourceId],
      );
      recordMemoryDeletion({ outcome: "completed", target: "knowledge_source", count: chunks.rowCount ?? 0 });
    });
  }
}
