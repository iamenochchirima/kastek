import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "./contracts";
import { loadExecution, assertCurrentAuthority } from "./execution";
import { EvidenceStore, type EvidencePassage } from "./evidence";
import { KnowledgeRetrieval, type RetrievalHit } from "./retrieval";
import type { QueryEmbeddingService } from "./query-embedding";

export interface EvidenceSnippet { evidenceId: string; label: string; citation: string; sourceId: string | null; revisionId: string | null;
  title: string; page: number | null; acquiredAt: string; start: number; end: number; text: string }
export interface KnowledgeObservation { profile: "lexical-v1" | "hybrid-v1"; passages: EvidenceSnippet[]; omitted: number }
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

export class KnowledgeRuntime {
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
      sourceRevisionIds: config.sourceRevisionIds, publicOnly: execution.task.principal.kind === "visitor" }, query,
    profile ?? { kind: "hybrid-v1", embeddingRelease: config.retrievalProfile.kind === "hybrid-v1" ? config.retrievalProfile.embeddingRelease : "", queryVector: vector! },
    async db => { await assertCurrentAuthority(db, await loadExecution(db, taskId)); });
    const observation: KnowledgeObservation = { profile: config.retrievalProfile.kind, passages: [], omitted: hits.length };
    for (const [index, hit] of hits.entries()) {
      const remaining = 8192 - Buffer.byteLength(JSON.stringify(observation));
      if (remaining < 900) break;
      const span = relevantSpan(hit, query, Math.min(index === 0 ? 1800 : 600, remaining - 700));
      const passage = await this.evidence.recordChunk(taskId, operationId, hit.chunkId, span), dto = snippetDTO(passage);
      if (Buffer.byteLength(JSON.stringify({ ...observation, passages: [...observation.passages, dto] })) > 8192) throw new PlatformError("TOOL_RESULT_LIMIT", 413, "Knowledge result exceeds its bound");
      observation.passages.push(dto); observation.omitted--;
    }
    return observation;
  }

  async read(taskId: string, operationId: string, evidenceId: string, offset = 0): Promise<{ passage: EvidenceSnippet; nextOffset: number | null }> {
    z.uuid().parse(evidenceId); z.number().int().nonnegative().parse(offset);
    const source = await this.evidence.readPassage(taskId, evidenceId);
    if (!source.reference.chunkId) throw new PlatformError("EVIDENCE_SCOPE_DENIED", 403, "Select a knowledge passage");
    const row = (await this.pool.query("SELECT start_offset,content FROM agents_platform.source_chunks WHERE id=$1 AND organization_id=$2", [source.reference.chunkId, source.reference.organizationId])).rows[0];
    if (!row || offset >= row.content.length || offset > 0 && /[\uDC00-\uDFFF]/.test(row.content[offset])) throw new PlatformError("EVIDENCE_SPAN_INVALID", 400, "Select a valid passage offset");
    const text = fit(row.content.slice(offset), 4096), start = row.start_offset + offset, end = start + text.length;
    const passage = await this.evidence.recordChunk(taskId, operationId, source.reference.chunkId, { start, end });
    return { passage: snippetDTO(passage), nextOffset: offset + text.length < row.content.length ? offset + text.length : null };
  }
}
