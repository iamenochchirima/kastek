import type { KnowledgeContextReader } from "../../execution/context/readers";
import type { KnowledgeObservation, KnowledgeRuntimePort } from "../../contracts/knowledge";
import type { Pool } from "pg";
import { z } from "zod";
import { isCustomerPrincipal, PlatformError } from "../../contracts/contracts";
import { EvidenceStore,type EvidencePassage } from "../../execution/context/evidence";
import { assertCurrentAuthority,loadExecution } from "../../execution/lifecycle/execution";
import type { QueryEmbeddingService } from "./query-embedding";
import { KnowledgeRetrieval,type RetrievalHit } from "./retrieval";

export interface EvidenceSnippet { evidenceId: string; label: string; citation: string; sourceId: string | null; revisionId: string | null;
  title: string; page: number | null; acquiredAt: string; start: number; end: number; text: string;
  sectionId?: string; headingPath?: string; sectionPart?: number }
export type { KnowledgeObservation } from "../../contracts/knowledge";
export const snippetDTO = (passage: EvidencePassage): EvidenceSnippet => ({ evidenceId: passage.reference.id, label: passage.label, citation: `[${passage.label}]`,
  sourceId: passage.reference.sourceId, revisionId: passage.reference.revisionId, title: fit(passage.title, 120), page: passage.page,
  acquiredAt: passage.reference.acquiredAt, start: passage.reference.start, end: passage.reference.end, text: passage.text });
function fit(text: string, bytes: number): string {
  let used = 0, result = "";
  for (const char of text) { const size = Buffer.byteLength(char); if (used + size > bytes) break; result += char; used += size; }
  return result;
}
function relevantSpan(hit: RetrievalHit, query: string, bytes: number) {
  const stop = new Set(["what", "when", "where", "which", "this", "that", "with", "from", "about", "does", "have", "the", "and", "are", "for"]);
  let position = 0;
  for (const word of (query.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !stop.has(word.toLowerCase())).sort((a, b) => b.length - a.length)) {
    const match = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(hit.text);
    if (match) { position = match.index; break; }
  }
  let start = Math.max(0, position - 120);
  if (start && /[\uDC00-\uDFFF]/.test(hit.text[start]!)) start--;
  const text = fit(hit.text.slice(start), bytes);
  return { start: hit.start + start, end: hit.start + start + text.length };
}

export class KnowledgeRuntime implements KnowledgeContextReader, KnowledgeRuntimePort {
  readonly retrieval: KnowledgeRetrieval;
  constructor(readonly pool: Pool, readonly evidence: EvidenceStore, readonly embeddings?: QueryEmbeddingService) { this.retrieval = new KnowledgeRetrieval(pool); }

  async search(taskId: string, operationId: string, query: string): Promise<KnowledgeObservation> {
    if (!z.string().min(1).max(1024).refine(value=>!!value.trim() && Buffer.byteLength(value)<=1024).safeParse(query).success) throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Use a bounded knowledge query");
    const execution = await loadExecution(this.pool, taskId), config = execution.configuration;
    let profile = config.retrievalProfile.kind === "hybrid-v1" ? undefined : { kind: "lexical-v1" as const };
    let vector: number[] | undefined;
    if (config.retrievalProfile.kind === "hybrid-v1") {
      if (!this.embeddings) throw new PlatformError("RETRIEVAL_BACKEND_UNAVAILABLE", 503, "Semantic retrieval is unavailable");
      vector = (await this.embeddings.embed({ taskId, operationId, profileRelease: config.retrievalProfile.embeddingRelease, query })).vector;
    }
    const hits = await this.retrieval.search({ organizationId: execution.task.organization_id, versionId: execution.task.version_id,
      sourceRevisionIds: config.sourceRevisionIds }, query,
    profile ?? { kind: "hybrid-v1", embeddingRelease: config.retrievalProfile.kind === "hybrid-v1" ? config.retrievalProfile.embeddingRelease : "", queryVector: vector! },
    async db => { await assertCurrentAuthority(db, await loadExecution(db, taskId)); });
    const observation: KnowledgeObservation = { profile: config.retrievalProfile.kind, passages: [], omitted: hits.length };
    for (const [index, hit] of hits.entries()) {
      const remaining = 8192 - Buffer.byteLength(JSON.stringify(observation));
      if (remaining < 900) break;
      const span = hit.sectionId !== null
        ? { start: hit.start, end: hit.start + Math.min(hit.text.length, Math.max(0, remaining - 700)) }
        : relevantSpan(hit, query, Math.min(index === 0 ? 1800 : 600, remaining - 700));
      const passage = await this.evidence.recordChunk(taskId, operationId, hit.chunkId, span), dto = snippetDTO(passage);
      observation.passages.push(dto); observation.omitted--;
      if (Buffer.byteLength(JSON.stringify(observation)) > 8192) throw new PlatformError("TOOL_RESULT_LIMIT", 413, "Knowledge result exceeds its bound");
    }
    return observation;
  }

  async read(taskId: string, operationId: string, evidenceId: string, offset = 0): Promise<{ passage: EvidenceSnippet; nextOffset: number | null }> {
    z.uuid().parse(evidenceId); z.number().int().nonnegative().parse(offset);
    const source = await this.evidence.readPassage(taskId, evidenceId);
    if (!source.reference.chunkId) throw new PlatformError("EVIDENCE_SCOPE_DENIED", 403, "Select a knowledge passage");
    const row = (await this.pool.query("SELECT start_offset,content,revision_id,section_id,ordinal FROM agents_platform.source_chunks WHERE id=$1 AND organization_id=$2", [source.reference.chunkId, source.reference.organizationId])).rows[0];
    if (!row) throw new PlatformError("EVIDENCE_SPAN_INVALID", 400, "Select a valid passage offset");
    // A continuation past this chunk means "the next part of the section", not an error.
    if (offset >= row.content.length) {
      const next = row.section_id
        ? (await this.pool.query(`SELECT id,start_offset,content FROM agents_platform.source_chunks
            WHERE organization_id=$1 AND revision_id=$2 AND section_id=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 1`,
          [source.reference.organizationId, row.revision_id, row.section_id, row.ordinal])).rows[0]
        : undefined;
      if (next) {
        const passage = await this.evidence.recordChunk(taskId, operationId, next.id, { start: next.start_offset, end: next.start_offset + next.content.length });
        return { passage: snippetDTO(passage), nextOffset: null };
      }
      const end = row.start_offset + row.content.length;
      const passage = await this.evidence.recordChunk(taskId, operationId, source.reference.chunkId, { start: row.start_offset, end });
      return { passage: snippetDTO(passage), nextOffset: null };
    }
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(row.content[offset])) throw new PlatformError("EVIDENCE_SPAN_INVALID", 400, "Select a valid passage offset");
    const text = fit(row.content.slice(offset), 4096), start = row.start_offset + offset, end = start + text.length;
    const passage = await this.evidence.recordChunk(taskId, operationId, source.reference.chunkId, { start, end });
    return { passage: snippetDTO(passage), nextOffset: offset + text.length < row.content.length ? offset + text.length : null };
  }

  /** A legacy pinned agent stays pinned only when the whole leaf set fits pinned-core. */
  async pinnedEligible(taskId: string, maxSections = 8, maxChars = 6_000): Promise<boolean> {
    const execution = await loadExecution(this.pool, taskId), config = execution.configuration;
    const row = (await this.pool.query(`SELECT count(*)::int AS sections,coalesce(sum(sec.chars),0)::int AS chars
      FROM agents_platform.version_sources v
      JOIN agents_platform.source_revisions r ON r.id=v.revision_id AND r.organization_id=v.organization_id
      JOIN agents_platform.sources s ON s.id=v.source_id AND s.organization_id=v.organization_id
      JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.organization_id=r.organization_id
      JOIN agents_platform.source_sections sec ON sec.revision_id=r.id AND sec.organization_id=r.organization_id
      WHERE v.organization_id=$1 AND v.version_id=$2 AND v.revision_id=ANY($3::uuid[]) AND s.state='active' AND p.state='approved'
        AND NOT EXISTS(SELECT 1 FROM agents_platform.source_sections child WHERE child.revision_id=sec.revision_id AND child.parent_ordinal=sec.ordinal)`,
    [execution.task.organization_id, execution.task.version_id, config.sourceRevisionIds])).rows[0];
    return Boolean(row && row.sections > 0 && row.sections <= maxSections && row.chars <= maxChars);
  }

  /** Explicit pinned knowledge is reduced to pinned-core: at most eight leaf sections and about 2,000 rendered tokens. */
  async pinnedSources(taskId: string, budgetChars = 6_000): Promise<Array<{ id: string; revisionId: string; sourceId: string; title: string; headingPath: string; content: string }>> {
    const execution = await loadExecution(this.pool, taskId), config = execution.configuration;
    const rows = (await this.pool.query(`SELECT sec.id,sec.revision_id,r.source_id,s.title,sec.heading_path,sec.content
      FROM agents_platform.version_sources v
      JOIN agents_platform.source_revisions r ON r.id=v.revision_id AND r.organization_id=v.organization_id
      JOIN agents_platform.sources s ON s.id=v.source_id AND s.organization_id=v.organization_id
      JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.organization_id=r.organization_id
      JOIN agents_platform.source_sections sec ON sec.revision_id=r.id AND sec.organization_id=r.organization_id
      WHERE v.organization_id=$1 AND v.version_id=$2 AND v.revision_id=ANY($3::uuid[]) AND s.state='active' AND p.state='approved'
        AND NOT EXISTS(SELECT 1 FROM agents_platform.source_sections child WHERE child.revision_id=sec.revision_id AND child.parent_ordinal=sec.ordinal)
      ORDER BY s.title,r.revision,sec.ordinal,sec.part`, [execution.task.organization_id, execution.task.version_id,
      config.sourceRevisionIds])).rows;
    const selected: Array<{ id: string; revisionId: string; sourceId: string; title: string; headingPath: string; content: string }> = [];
    let used = 0;
    for (const row of rows) {
      if (selected.length >= 8) break;
      const content = String(row.content);
      if (used + content.length > budgetChars) break;
      used += content.length;
      selected.push({ id: String(row.id), revisionId: String(row.revision_id), sourceId: String(row.source_id),
        title: String(row.title), headingPath: String(row.heading_path), content });
    }
    return selected;
  }
}
