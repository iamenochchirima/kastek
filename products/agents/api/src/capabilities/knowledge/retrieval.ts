import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { assertEmbeddingVector } from "./knowledge";

export interface RetrievalScope { organizationId: string; versionId: string; sourceRevisionIds: string[]; publicOnly: boolean }
export type RetrievalProfile = { kind: "lexical-v1" } | { kind: "hybrid-v1"; embeddingRelease: string; queryVector: number[] };
export interface RetrievalHit { chunkId: string; sourceId: string; revisionId: string; sourceGeneration: number; visibility: "private" | "public";
  title: string; start: number; end: number; page: number | null; text: string; contentDigest: string; acquiredAt: string; rankScore: number }
export const RETRIEVAL_PROFILE = Object.freeze({ fusionK: 60, candidatesPerMethod: 20, maxHits: 5, semanticMinSimilarity: 0.5, version: "hybrid-rrf60-v1" });

export class KnowledgeRetrieval {
  constructor(readonly pool: Pool) {}
  async search(scope: RetrievalScope, query: string, profile: RetrievalProfile,
    authorize: (db: PoolClient) => Promise<void>): Promise<RetrievalHit[]> {
    z.uuid().parse(scope.organizationId); z.uuid().parse(scope.versionId);
    z.array(z.uuid()).max(20).parse(scope.sourceRevisionIds);
    z.string().min(1).max(1024).refine(value => !!value.trim() && Buffer.byteLength(value) <= 1024).parse(query);
    if (profile.kind === "hybrid-v1") { assertEmbeddingVector(profile.queryVector); z.string().min(1).max(256).parse(profile.embeddingRelease); }
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR SHARE", [scope.organizationId]);
      await authorize(db);
      const params: unknown[] = [scope.organizationId, scope.versionId, scope.sourceRevisionIds, scope.publicOnly, query];
      const scoped = `WITH eligible AS MATERIALIZED (
        SELECT c.*,s.id AS source_id,s.generation,s.visibility,s.title,r.acquired_at,r.embedding_release
        FROM agents_platform.source_chunks c
        JOIN agents_platform.source_revisions r ON r.id=c.revision_id AND r.organization_id=c.organization_id
        JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id
        JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.organization_id=r.organization_id
        JOIN agents_platform.version_sources v ON v.revision_id=r.id AND v.source_id=s.id AND v.organization_id=s.organization_id
        WHERE c.organization_id=$1 AND v.version_id=$2 AND r.id=ANY($3::uuid[]) AND s.state='active' AND p.state='approved'
          AND (NOT $4::boolean OR s.visibility='public')
      ), lexical_candidates AS (
        SELECT id,ts_rank_cd(search_document,websearch_to_tsquery('english',$5)) AS score FROM eligible
        WHERE search_document @@ websearch_to_tsquery('english',$5)
        ORDER BY score DESC,id LIMIT 20
      ), lexical AS (SELECT id,row_number() OVER(ORDER BY score DESC,id) AS rank FROM lexical_candidates)`;
      let sql: string;
      if (profile.kind === "hybrid-v1") {
        params.push(profile.embeddingRelease, `[${profile.queryVector.join(",")}]`, RETRIEVAL_PROFILE.semanticMinSimilarity);
        const available = (await db.query(`SELECT count(*) AS missing FROM agents_platform.version_sources v
          JOIN agents_platform.source_revisions r ON r.id=v.revision_id WHERE v.organization_id=$1 AND v.version_id=$2
          AND r.id=ANY($3::uuid[]) AND (r.embedding_release IS DISTINCT FROM $4 OR EXISTS(
            SELECT 1 FROM agents_platform.source_chunks c LEFT JOIN agents_platform.chunk_embeddings e ON e.chunk_id=c.id
            WHERE c.revision_id=r.id AND (e.chunk_id IS NULL OR e.embedding_release<>$4)))`, [scope.organizationId, scope.versionId, scope.sourceRevisionIds, profile.embeddingRelease])).rows[0];
        if (Number(available.missing)) throw new PlatformError("RETRIEVAL_BACKEND_UNAVAILABLE", 503, "The selected knowledge index is unavailable");
        sql = `${scoped}, semantic_candidates AS (
          SELECT c.id,(e.embedding <=> $7::public.vector) AS distance FROM eligible c
          JOIN agents_platform.chunk_embeddings e ON e.chunk_id=c.id AND e.organization_id=c.organization_id
          WHERE e.embedding_release=$6 AND c.embedding_release=$6 AND (e.embedding <=> $7::public.vector)<=1-$8::double precision
          ORDER BY distance,c.id LIMIT 20
        ), semantic AS (SELECT id,row_number() OVER(ORDER BY distance,id) AS rank FROM semantic_candidates),
        fused AS (SELECT id,sum(score) AS score FROM (
          SELECT id,1.0/(60+rank) AS score FROM lexical UNION ALL SELECT id,1.0/(60+rank) AS score FROM semantic
        ) candidates GROUP BY id)
        SELECT c.*,f.score AS rank_score FROM fused f JOIN eligible c ON c.id=f.id ORDER BY f.score DESC,c.id LIMIT 5`;
      } else sql = `${scoped} SELECT c.*,1.0/(60+l.rank) AS rank_score FROM lexical l JOIN eligible c ON c.id=l.id ORDER BY l.rank,c.id LIMIT 5`;
      const rows = (await db.query(sql, params)).rows;
      return rows.map(row => ({ chunkId: row.id, sourceId: row.source_id, revisionId: row.revision_id, sourceGeneration: row.generation,
        visibility: row.visibility, title: row.title, start: row.start_offset, end: row.end_offset, page: row.page,
        text: row.content, contentDigest: row.content_digest, acquiredAt: new Date(row.acquired_at).toISOString(), rankScore: Number(row.rank_score) }));
    });
  }
}
