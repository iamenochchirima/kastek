import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { assertEmbeddingVector } from "./knowledge";

export interface RetrievalScope { organizationId: string; versionId: string; sourceRevisionIds: string[]; publicOnly: boolean }
export type RetrievalProfile = { kind: "lexical-v1" } | { kind: "hybrid-v1"; embeddingRelease: string; queryVector: number[] };
export interface RetrievalHit { chunkId: string; sourceId: string; revisionId: string; sourceGeneration: number; visibility: "private" | "public";
  title: string; start: number; end: number; page: number | null; text: string; contentDigest: string; acquiredAt: string; rankScore: number;
  sectionId: string | null; sectionOrdinal: number | null; sectionPart: number | null; headingPath: string | null }
/** Sections are returned whole: a hit list is a section list, not a window list. */
export const RETRIEVAL_PROFILE = Object.freeze({ fusionK: 60, candidatesPerMethod: 20, candidateChunks: 40, maxSections: 4, maxPassages: 8,
  maxBytes: 8192, perSectionBytes: 4096, maxHits: 5, semanticMinSimilarity: 0.5, version: "hybrid-rrf60-v2" });

interface CandidateRow { id: string; revision_id: string; rank_score: number; section_id: string | null; section_ordinal: number | null;
  parent_ordinal: number | null; heading_path: string | null; part: number | null; chars: number | null; parent_chars: number | null }

const sectionKey = (revisionId: string, ordinal: number) => `${revisionId}:${ordinal}`;

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
        AND ($4::boolean OR true)
      ), lexical_query AS (
        SELECT string_agg(quote_literal(term),' | ')::tsquery AS expression
        FROM unnest(tsvector_to_array(to_tsvector('english',$5))) AS terms(term)
      ), lexical_candidates AS (
        SELECT id,ts_rank_cd(search_document,q.expression) AS score FROM eligible CROSS JOIN lexical_query q
        WHERE search_document @@ q.expression
        ORDER BY score DESC,id LIMIT 20
      ), lexical AS (SELECT id,row_number() OVER(ORDER BY score DESC,id) AS rank FROM lexical_candidates)`;
      const headingBoost = `CROSS JOIN LATERAL (SELECT CASE WHEN sec.heading_path IS NULL THEN 0::float8 ELSE
        0.05 * (SELECT count(*) FROM unnest(tsvector_to_array(to_tsvector('english',$5))) t(term)
          WHERE to_tsvector('english',sec.heading_path) @@ to_tsquery('english',t.term))::float8
        / greatest(1,(SELECT count(*) FROM unnest(tsvector_to_array(to_tsvector('english',$5)))))::float8 END AS boost) hb`;
      let sql: string;
      if (profile.kind === "hybrid-v1") {
        params.push(profile.embeddingRelease, `[${profile.queryVector.join(",")}]`, RETRIEVAL_PROFILE.semanticMinSimilarity);
        const available = (await db.query(`SELECT count(*) AS missing FROM agents_platform.version_sources v
          JOIN agents_platform.source_revisions r ON r.id=v.revision_id AND r.organization_id=v.organization_id
          JOIN agents_platform.sources s ON s.id=r.source_id AND s.id=v.source_id AND s.organization_id=r.organization_id
          JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.source_id=s.id AND p.organization_id=r.organization_id
          WHERE v.organization_id=$1 AND v.version_id=$2 AND s.state='active' AND p.state='approved'
          AND r.id=ANY($3::uuid[]) AND ($5::boolean OR true) AND (r.embedding_release IS DISTINCT FROM $4 OR EXISTS(
            SELECT 1 FROM agents_platform.source_chunks c LEFT JOIN agents_platform.chunk_embeddings e ON e.chunk_id=c.id
            WHERE c.revision_id=r.id AND (e.chunk_id IS NULL OR e.embedding_release<>$4)))`, [scope.organizationId, scope.versionId, scope.sourceRevisionIds, profile.embeddingRelease, scope.publicOnly])).rows[0];
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
        SELECT c.id,c.revision_id,f.score + hb.boost AS rank_score,
          sec.id AS section_id,sec.ordinal AS section_ordinal,sec.parent_ordinal,sec.heading_path,sec.part,sec.chars,
          par.chars AS parent_chars
        FROM fused f JOIN eligible c ON c.id=f.id
        LEFT JOIN LATERAL (SELECT s.id,s.revision_id,s.ordinal,s.parent_ordinal,s.heading_path,s.part,s.chars
          FROM agents_platform.source_sections s
          WHERE s.organization_id=c.organization_id AND s.revision_id=c.revision_id
            AND c.start_offset>=s.start_offset AND c.start_offset<s.end_offset
          ORDER BY s.level DESC,s.start_offset DESC LIMIT 1) sec ON true
        LEFT JOIN agents_platform.source_sections par ON par.revision_id=sec.revision_id AND par.ordinal=sec.parent_ordinal AND par.part=1
        ${headingBoost}
        ORDER BY rank_score DESC,c.id LIMIT ${RETRIEVAL_PROFILE.candidateChunks}`;
      } else sql = `${scoped}
        SELECT c.id,c.revision_id,1.0/(60+l.rank) + hb.boost AS rank_score,
          sec.id AS section_id,sec.ordinal AS section_ordinal,sec.parent_ordinal,sec.heading_path,sec.part,sec.chars,
          par.chars AS parent_chars
        FROM lexical l JOIN eligible c ON c.id=l.id
        LEFT JOIN LATERAL (SELECT s.id,s.revision_id,s.ordinal,s.parent_ordinal,s.heading_path,s.part,s.chars
          FROM agents_platform.source_sections s
          WHERE s.organization_id=c.organization_id AND s.revision_id=c.revision_id
            AND c.start_offset>=s.start_offset AND c.start_offset<s.end_offset
          ORDER BY s.level DESC,s.start_offset DESC LIMIT 1) sec ON true
        LEFT JOIN agents_platform.source_sections par ON par.revision_id=sec.revision_id AND par.ordinal=sec.parent_ordinal AND par.part=1
        ${headingBoost}
        ORDER BY rank_score DESC,c.id LIMIT ${RETRIEVAL_PROFILE.candidateChunks}`;
      const candidates = (await db.query(sql, params)).rows as CandidateRow[];
      const leafScore = new Map<string, number>(), leafParent = new Map<string, string | null>(), parentFits = new Map<string, boolean>();
      for (const row of candidates) {
        if (!row.section_id || row.section_ordinal === null) continue;
        const key = sectionKey(row.revision_id, row.section_ordinal);
        leafScore.set(key, Math.max(leafScore.get(key) ?? 0, Number(row.rank_score)));
        const parent = row.parent_ordinal === null ? null : sectionKey(row.revision_id, row.parent_ordinal);
        leafParent.set(key, parent);
        if (parent) {
          const fits = row.parent_chars === null || Number(row.parent_chars) <= RETRIEVAL_PROFILE.maxBytes;
          parentFits.set(parent, (parentFits.get(parent) ?? true) && fits);
        }
      }
      const parentCounts = new Map<string, number>();
      for (const parent of leafParent.values()) if (parent) parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
      const selected = new Map<string, number>();
      for (const [key, score] of leafScore) {
        const parent = leafParent.get(key) ?? null;
        const promote = parent !== null && (parentCounts.get(parent) ?? 0) >= 2 && (parentFits.get(parent) ?? false);
        if (promote) selected.set(parent, Math.max(selected.get(parent) ?? 0, score));
        else selected.set(key, Math.max(selected.get(key) ?? 0, score));
      }
      for (const key of [...selected.keys()]) {
        const parent = leafParent.get(key);
        if (parent && parent !== key && selected.has(parent)) selected.delete(key);
      }
      const chosen = [...selected.entries()].sort((left, right) => right[1] - left[1]).slice(0, RETRIEVAL_PROFILE.maxSections);
      if (!chosen.length) {
        const ids = candidates.slice(0, RETRIEVAL_PROFILE.maxHits).map(row => row.id);
        if (!ids.length) return [];
        const rows = (await db.query(`SELECT c.id,r.source_id,c.revision_id,src.generation,src.visibility,src.title,
            c.start_offset,c.end_offset,c.page,c.content,c.content_digest,r.acquired_at
          FROM agents_platform.source_chunks c
          JOIN agents_platform.source_revisions r ON r.id=c.revision_id AND r.organization_id=c.organization_id
          JOIN agents_platform.sources src ON src.id=r.source_id AND src.organization_id=r.organization_id
          WHERE c.organization_id=$1 AND c.id=ANY($2::uuid[])`, [scope.organizationId, ids])).rows;
        const order = new Map(ids.map((id, index) => [id, index]));
        const score = new Map(candidates.map(row => [row.id, Number(row.rank_score)]));
        return rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)).map(row => ({
          chunkId: row.id, sourceId: row.source_id, revisionId: row.revision_id, sourceGeneration: Number(row.generation),
          visibility: row.visibility, title: row.title, start: Number(row.start_offset), end: Number(row.end_offset),
          page: row.page === null ? null : Number(row.page), text: row.content, contentDigest: row.content_digest,
          acquiredAt: new Date(row.acquired_at).toISOString(), rankScore: score.get(row.id) ?? 0,
          sectionId: null, sectionOrdinal: null, sectionPart: null, headingPath: null,
        }));
      }
      const revisionIds = chosen.map(([key]) => key.slice(0, key.lastIndexOf(":")));
      const ordinals = chosen.map(([key]) => Number(key.slice(key.lastIndexOf(":") + 1)));
      const rows = (await db.query(`SELECT c.id,r.source_id,c.revision_id,src.generation,src.visibility,src.title,
          c.start_offset,c.end_offset,c.page,c.content,c.content_digest,r.acquired_at,
          c.section_id,c.section_ordinal,sec.heading_path,sec.part,want.ordinal AS selected_ordinal,
          sec.id AS selected_section_id,sec.part AS selected_part
        FROM agents_platform.source_chunks c
        JOIN agents_platform.source_revisions r ON r.id=c.revision_id AND r.organization_id=c.organization_id
        JOIN agents_platform.sources src ON src.id=r.source_id AND src.organization_id=r.organization_id
        JOIN agents_platform.source_sections sec ON sec.revision_id=c.revision_id AND sec.organization_id=c.organization_id
          AND c.start_offset>=sec.start_offset AND c.start_offset<sec.end_offset
        JOIN unnest($2::uuid[],$3::int[]) want(revision_id,ordinal) ON want.revision_id=sec.revision_id AND want.ordinal=sec.ordinal
        WHERE c.organization_id=$1 AND src.state='active'
        ORDER BY c.ordinal`, [scope.organizationId, revisionIds, ordinals])).rows;
      const bySection = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = sectionKey(row.revision_id, Number(row.selected_ordinal));
        const bucket = bySection.get(key) ?? [];
        if (!bucket.some(existing => existing.id === row.id)) bucket.push(row);
        bySection.set(key, bucket);
      }
      const hits: RetrievalHit[] = [];
      const seenChunks = new Set<string>();
      let bytes = 0;
      for (const [key, score] of chosen) {
        let sectionBytes = 0;
        for (const row of bySection.get(key) ?? []) {
          if (hits.length >= RETRIEVAL_PROFILE.maxPassages) break;
          if (seenChunks.has(row.id)) continue;
          const size = Buffer.byteLength(row.content);
          if (sectionBytes + size > RETRIEVAL_PROFILE.perSectionBytes) break;
          if (bytes + size > RETRIEVAL_PROFILE.maxBytes) break;
          sectionBytes += size; bytes += size; seenChunks.add(row.id);
          hits.push({ chunkId: row.id, sourceId: row.source_id, revisionId: row.revision_id, sourceGeneration: Number(row.generation),
            visibility: row.visibility, title: row.title, start: Number(row.start_offset), end: Number(row.end_offset),
            page: row.page === null ? null : Number(row.page), text: row.content, contentDigest: row.content_digest,
            acquiredAt: new Date(row.acquired_at).toISOString(), rankScore: score,
            sectionId: row.selected_section_id, sectionOrdinal: Number(row.selected_ordinal), sectionPart: Number(row.selected_part), headingPath: row.heading_path });
        }
      }
      return hits;
    });
  }
}
