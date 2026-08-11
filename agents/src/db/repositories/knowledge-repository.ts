import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import type { MemoryScope } from "./memory-repository";

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
}

export class KnowledgeRepository {
  public constructor(private readonly pool: Pool) {}

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
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING *`,
      [input.organizationId, input.agentId, input.installationId ?? null, input.name, input.sourceType, input.sourceUri ?? null, JSON.stringify(input.provenance ?? {}), input.actorId],
    );
    return result.rows[0]!;
  }

  public async getSource(scope: { organizationId: string; agentId?: string; installationId?: string }, sourceId: string): Promise<KnowledgeSourceRecord | null> {
    const result = await query<KnowledgeSourceRecord>(
      this.pool,
      `SELECT * FROM knowledge_sources
       WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [sourceId, scope.organizationId],
    );
    return result.rows[0] ?? null;
  }

  public async addChunks(input: {
    sourceId: string;
    scope: MemoryScope;
    revision: number;
    chunks: Array<{ text: string; metadata?: Record<string, unknown>; provenance?: Record<string, unknown> }>;
  }): Promise<KnowledgeChunkRecord[]> {
    return withTransaction(this.pool, async (client) => {
      const source = await client.query<KnowledgeSourceRecord>(
        `SELECT * FROM knowledge_sources WHERE id = $1 AND organization_id = $2 AND status = 'active' FOR UPDATE`,
        [input.sourceId, input.scope.organizationId],
      );
      if (!source.rows[0]) throw new Error("Knowledge source not found");
      const chunks: KnowledgeChunkRecord[] = [];
      for (const [index, chunk] of input.chunks.entries()) {
        const created = await client.query<KnowledgeChunkRecord>(
          `INSERT INTO knowledge_chunks
            (source_id, organization_id, agent_definition_id, installation_id, revision, chunk_index, canonical_text, metadata, provenance)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
           ON CONFLICT (source_id, revision, chunk_index) DO UPDATE
             SET canonical_text = EXCLUDED.canonical_text, metadata = EXCLUDED.metadata, provenance = EXCLUDED.provenance
           RETURNING *`,
          [input.sourceId, input.scope.organizationId, input.scope.agentId, input.scope.installationId ?? null, input.revision, index, chunk.text, JSON.stringify(chunk.metadata ?? {}), JSON.stringify(chunk.provenance ?? {})],
        );
        chunks.push(created.rows[0]!);
      }
      await client.query("UPDATE knowledge_sources SET revision = $2, updated_at = now() WHERE id = $1", [input.sourceId, input.revision]);
      return chunks;
    });
  }

  public async search(scope: MemoryScope, searchText: string, limit = 8): Promise<KnowledgeChunkRecord[]> {
    const result = await query<KnowledgeChunkRecord>(
      this.pool,
      `SELECT kc.* FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON ks.id = kc.source_id AND ks.status = 'active'
       WHERE kc.organization_id = $1
         AND (kc.agent_definition_id IS NULL OR kc.agent_definition_id = $2)
         AND (kc.installation_id IS NULL OR kc.installation_id = $3)
         AND kc.search_vector @@ plainto_tsquery('simple', $4)
       ORDER BY ts_rank_cd(kc.search_vector, plainto_tsquery('simple', $4)) DESC, kc.created_at DESC
       LIMIT $5`,
      [scope.organizationId, scope.agentId, scope.installationId ?? null, searchText, limit],
    );
    return result.rows;
  }

  public async listSources(scope: { organizationId: string; agentId?: string; installationId?: string }, limit = 100): Promise<KnowledgeSourceRecord[]> {
    const result = await query<KnowledgeSourceRecord>(this.pool, `SELECT * FROM knowledge_sources WHERE organization_id = $1 AND status <> 'deleted' AND ($2::uuid IS NULL OR agent_definition_id = $2) AND ($3::uuid IS NULL OR installation_id = $3) ORDER BY created_at DESC LIMIT $4`, [scope.organizationId, scope.agentId ?? null, scope.installationId ?? null, Math.max(1, Math.min(limit, 500))]);
    return result.rows;
  }

  public async deleteSource(scope: MemoryScope, sourceId: string, requestedBy: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<KnowledgeSourceRecord>(
        `UPDATE knowledge_sources SET status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND (agent_definition_id IS NULL OR agent_definition_id = $3)
         RETURNING *`,
        [sourceId, scope.organizationId, scope.agentId],
      );
      if (!result.rows[0]) throw new Error("Knowledge source not found");
      await client.query(
        `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status)
         VALUES ($1, $2, 'knowledge_source', $3, 'completed')`,
        [scope.organizationId, requestedBy, sourceId],
      );
    });
  }
}
