import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { PrivateObjectStore } from "./artifacts";
import { PlatformError, requestDigest } from "./contracts";
import { transaction } from "./database";
import { assertIngestionPublication, SOURCE_LIMITS, sourceChunkSchema, textDigest, type IngestionJob, type Source, type SourceChunk } from "./source-contracts";

export interface KnowledgeScope { organizationId: string; accountId: string }
export interface KnowledgeSourceDTO extends Source { revisions: { id: string; revision: number; state: "candidate" | "approved" | "withdrawn"; acquiredAt: string }[] }
export interface IngestionJobDTO extends IngestionJob { contentType: string; errorCode: string | null; createdAt: string }
const missing = () => new PlatformError("SOURCE_NOT_FOUND", 404, "Source is unavailable");
const sourceDTO = (row: Record<string, any>): Source => ({ id: row.id, organizationId: row.organization_id,
  importerAccountId: row.importer_account_id, title: row.title, kind: row.kind, generation: row.generation,
  state: row.state, visibility: row.visibility, createdAt: new Date(row.created_at).toISOString() });
const jobDTO = (row: Record<string, any>): IngestionJobDTO => ({ id: row.id, sourceId: row.source_id, revisionId: row.revision_id,
  revision: row.revision, acceptedGeneration: row.accepted_generation, state: row.state, parserRelease: row.parser_release,
  deadline: new Date(row.deadline).toISOString(), contentType: row.content_type, errorCode: row.error_code, createdAt: new Date(row.created_at).toISOString() });

export async function requireKnowledgeMember(db: Pool | PoolClient, scope: KnowledgeScope, owner = false): Promise<string> {
  const row = (await db.query("SELECT role FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [scope.organizationId, scope.accountId])).rows[0];
  if (!row || owner && row.role !== "owner") throw new PlatformError("ACCESS_DENIED", 403, "Workspace access is unavailable");
  return row.role;
}

export class KnowledgeStore {
  constructor(readonly pool: Pool, readonly objects?: PrivateObjectStore) {}

  async list(scope: KnowledgeScope): Promise<KnowledgeSourceDTO[]> {
    return transaction(this.pool, async db => {
      const role = await requireKnowledgeMember(db, scope);
      const rows = (await db.query(`SELECT * FROM agents_platform.sources WHERE organization_id=$1
        AND ($2='owner' OR importer_account_id=$3) ORDER BY created_at,id LIMIT 200`, [scope.organizationId, role, scope.accountId])).rows;
      const revisions = rows.length ? (await db.query(`SELECT r.source_id,r.id,r.revision,p.state,r.acquired_at
        FROM agents_platform.source_revisions r JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id
        WHERE r.organization_id=$1 AND r.source_id=ANY($2::uuid[]) ORDER BY r.revision`, [scope.organizationId, rows.map(row => row.id)])).rows : [];
      return rows.map(row => ({ ...sourceDTO(row), revisions: revisions.filter(rev => rev.source_id === row.id).map(rev => ({ id: rev.id, revision: rev.revision, state: rev.state, acquiredAt: new Date(rev.acquired_at).toISOString() })) }));
    });
  }

  async admitUpload(scope: KnowledgeScope, raw: { operationId: string; title: string; contentType: string; content: Uint8Array; parserRelease: string; embeddingRelease?: string; sourceId?: string }): Promise<IngestionJobDTO> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    const input = z.strictObject({ operationId: z.string().min(1).max(128), title: z.string().trim().min(1).max(200),
      contentType: z.enum(["text/plain", "text/markdown", "text/html", "application/pdf"]), content: z.instanceof(Uint8Array),
      parserRelease: z.string().min(1).max(128), embeddingRelease: z.string().min(1).max(256).optional(), sourceId: z.uuid().optional() }).parse(raw);
    if (!input.content.byteLength || input.content.byteLength > SOURCE_LIMITS.rawBytes) throw new PlatformError("SOURCE_SIZE_INVALID", 413, "File exceeds the import limit");
    const rawDigest = textDigest(input.content), digest = requestDigest({ ...input, content: undefined, rawDigest });
    const admitted = await transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      await requireKnowledgeMember(db, scope);
      const existing = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE organization_id=$1 AND importer_account_id=$2 AND operation_id=$3", [scope.organizationId, scope.accountId, input.operationId])).rows[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request identity conflict");
        return existing;
      }
      const active = Number((await db.query("SELECT count(*) FROM agents_platform.ingestion_jobs WHERE organization_id=$1 AND state NOT IN ('ready','failed','cancelled')", [scope.organizationId])).rows[0].count);
      if (active >= SOURCE_LIMITS.concurrentImports) throw new PlatformError("IMPORT_CONCURRENCY_LIMIT", 429, "Too many active imports");
      let source: Record<string, any>;
      if (input.sourceId) {
        await requireKnowledgeMember(db, scope, true);
        source = (await db.query("SELECT * FROM agents_platform.sources WHERE id=$1 AND organization_id=$2 FOR UPDATE", [input.sourceId, scope.organizationId])).rows[0];
        if (!source || source.state !== "active") throw missing();
      } else {
        const count = Number((await db.query("SELECT count(*) FROM agents_platform.sources WHERE organization_id=$1 AND state='active'", [scope.organizationId])).rows[0].count);
        if (count >= SOURCE_LIMITS.organizationSources) throw new PlatformError("SOURCE_QUOTA", 429, "Source limit reached");
        source = (await db.query("INSERT INTO agents_platform.sources(id,organization_id,importer_account_id,title,kind) VALUES($1,$2,$3,$4,'upload') RETURNING *", [randomUUID(), scope.organizationId, scope.accountId, input.title])).rows[0];
      }
      const jobId = randomUUID(), revisionId = randomUUID();
      const revision = Number((await db.query("SELECT coalesce(max(revision),0)+1 AS next FROM agents_platform.ingestion_jobs WHERE source_id=$1", [source.id])).rows[0].next);
      const row = (await db.query(`INSERT INTO agents_platform.ingestion_jobs(id,organization_id,source_id,importer_account_id,operation_id,request_digest,revision_id,revision,accepted_generation,
        content_type,raw_key,raw_digest,raw_bytes,parser_release,embedding_release,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [jobId, scope.organizationId, source.id, scope.accountId, input.operationId, digest, revisionId, revision, source.generation,
        input.contentType, `knowledge/${scope.organizationId}/${source.id}/${revisionId}/raw`, rawDigest, input.content.byteLength,
        input.parserRelease, input.embeddingRelease ?? null, new Date(Date.now() + SOURCE_LIMITS.importWallMs)])).rows[0];
      await db.query("INSERT INTO agents_platform.ingestion_outbox(job_id) VALUES($1)", [jobId]);
      return row;
    });
    if (["cancelled", "failed", "ready"].includes(admitted.state)) return jobDTO(admitted);
    await this.objects.put(admitted.raw_key, input.content, input.contentType);
    const current = await transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      const row = (await db.query(`SELECT j.*,s.state AS source_state,s.generation AS current_generation FROM agents_platform.ingestion_jobs j
        JOIN agents_platform.sources s ON s.id=j.source_id WHERE j.id=$1 FOR UPDATE OF j,s`, [admitted.id])).rows[0];
      if (["cancelled", "failed"].includes(row.state) || row.source_state !== "active" || row.accepted_generation !== row.current_generation) {
        if (!["ready", "failed", "cancelled"].includes(row.state)) await db.query("UPDATE agents_platform.ingestion_jobs SET state='cancelled',updated_at=now() WHERE id=$1", [row.id]);
        return { ...row, state: row.state === "ready" ? "ready" : row.state === "failed" ? "failed" : "cancelled" };
      }
      await db.query("UPDATE agents_platform.ingestion_jobs SET raw_state='available',updated_at=now() WHERE id=$1", [row.id]);
      return row;
    });
    if (["cancelled", "failed"].includes(current.state)) await this.objects.delete(admitted.raw_key);
    return jobDTO(current);
  }

  async getJob(scope: KnowledgeScope, jobId: string): Promise<IngestionJobDTO> {
    z.uuid().parse(jobId);
    return transaction(this.pool, async db => {
      const role = await requireKnowledgeMember(db, scope);
      const row = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1 AND organization_id=$2 AND ($3='owner' OR importer_account_id=$4)", [jobId, scope.organizationId, role, scope.accountId])).rows[0];
      if (!row) throw missing();
      return jobDTO(row);
    });
  }

  async cancel(scope: KnowledgeScope, jobId: string): Promise<IngestionJobDTO> {
    z.uuid().parse(jobId);
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      const role = await requireKnowledgeMember(db, scope);
      const row = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1 AND organization_id=$2 AND ($3='owner' OR importer_account_id=$4) FOR UPDATE", [jobId, scope.organizationId, role, scope.accountId])).rows[0];
      if (!row) throw missing();
      if (["ready", "failed", "cancelled"].includes(row.state)) return jobDTO(row);
      const next = (await db.query("UPDATE agents_platform.ingestion_jobs SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *", [jobId])).rows[0];
      return jobDTO(next);
    });
  }

  async setPolicy(scope: KnowledgeScope, sourceId: string, raw: { operationId: string; expectedGeneration: number; action: "approve" | "withdraw" | "visibility"; revisionId?: string; visibility?: "private" | "public" }): Promise<Source> {
    z.uuid().parse(sourceId);
    const input = z.strictObject({ operationId: z.string().min(1).max(128), expectedGeneration: z.number().int().positive(),
      action: z.enum(["approve", "withdraw", "visibility"]), revisionId: z.uuid().optional(), visibility: z.enum(["private", "public"]).optional() }).parse(raw);
    if (input.action === "approve" && !input.revisionId || input.action === "visibility" && !input.visibility) throw new PlatformError("INVALID_INPUT", 400, "Select a revision or visibility");
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      await requireKnowledgeMember(db, scope, true);
      const digest = requestDigest({ sourceId, ...input });
      const old = (await db.query("SELECT * FROM agents_platform.source_mutations WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3", [scope.organizationId, scope.accountId, input.operationId])).rows[0];
      if (old) {
        if (old.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request identity conflict");
        return old.result as Source;
      }
      const row = (await db.query("SELECT * FROM agents_platform.sources WHERE id=$1 AND organization_id=$2 FOR UPDATE", [sourceId, scope.organizationId])).rows[0];
      if (!row) throw missing();
      if (row.generation !== input.expectedGeneration || row.state !== "active") throw new PlatformError("SOURCE_POLICY_CONFLICT", 409, "Source changed; refresh and try again");
      if (input.action === "approve") {
        const approved = await db.query("UPDATE agents_platform.source_revision_policy SET state='approved',approved_by=$3,approved_at=now() WHERE source_id=$1 AND revision_id=$2 AND organization_id=$4 AND state='candidate' RETURNING revision_id", [sourceId, input.revisionId, scope.accountId, scope.organizationId]);
        if (!approved.rowCount) throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "Select an available candidate revision");
      } else {
        await db.query("UPDATE agents_platform.sources SET generation=generation+1,state=$2,visibility=$3 WHERE id=$1", [sourceId, input.action === "withdraw" ? "withdrawn" : "active", input.visibility ?? row.visibility]);
        if (input.action === "withdraw") {
          await db.query("UPDATE agents_platform.source_revision_policy SET state='withdrawn' WHERE source_id=$1", [sourceId]);
          await db.query("UPDATE agents_platform.ingestion_jobs SET state='cancelled',updated_at=now() WHERE source_id=$1 AND state NOT IN ('ready','failed','cancelled')", [sourceId]);
        }
      }
      const result = sourceDTO((await db.query("SELECT * FROM agents_platform.sources WHERE id=$1", [sourceId])).rows[0]);
      await db.query("INSERT INTO agents_platform.source_mutations(organization_id,account_id,operation_id,request_digest,result) VALUES($1,$2,$3,$4,$5)", [scope.organizationId, scope.accountId, input.operationId, digest, JSON.stringify(result)]);
      return result;
    });
  }

  async publishExtraction(jobId: string, output: { text: string; chunks: SourceChunk[]; normalizerRelease: string; acquiredAt: string }): Promise<void> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    z.uuid().parse(jobId); z.iso.datetime().parse(output.acquiredAt); z.string().min(1).max(128).parse(output.normalizerRelease);
    const bytes = Buffer.from(output.text);
    if (!bytes.length || bytes.length > SOURCE_LIMITS.textBytes || output.chunks.length < 1 || output.chunks.length > SOURCE_LIMITS.chunks) throw new PlatformError("EXTRACTION_LIMIT", 413, "Extracted content exceeds its limit");
    const chunks = output.chunks.map(chunk => sourceChunkSchema.parse(chunk));
    const before = (await this.pool.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1", [jobId])).rows[0];
    if (!before) throw missing();
    const textKey = `knowledge/${before.organization_id}/${before.source_id}/${before.revision_id}/${textDigest(bytes)}`;
    for (const [ordinal, chunk] of chunks.entries()) if (chunk.revisionId !== before.revision_id || chunk.ordinal !== ordinal || output.text.slice(chunk.start, chunk.end) !== chunk.text) throw new PlatformError("EXTRACTION_INTEGRITY", 409, "Extracted chunks are invalid");
    await this.objects.put(textKey, bytes, "text/plain; charset=utf-8");
    await transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [before.organization_id]);
      await requireKnowledgeMember(db, { organizationId: before.organization_id, accountId: before.importer_account_id });
      const source = (await db.query("SELECT * FROM agents_platform.sources WHERE id=$1 FOR UPDATE", [before.source_id])).rows[0];
      const job = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0];
      if (job.state === "ready") {
        const existing = (await db.query("SELECT text_digest,chunk_set_digest FROM agents_platform.source_revisions WHERE id=$1", [job.revision_id])).rows[0];
        if (!existing || existing.text_digest !== textDigest(bytes) || existing.chunk_set_digest !== requestDigest(chunks)) throw new PlatformError("EXTRACTION_INTEGRITY", 409, "Import replay changed its content");
        return;
      }
      assertIngestionPublication(jobDTO(job), sourceDTO(source));
      const count = Number((await db.query("SELECT count(*) FROM agents_platform.source_chunks WHERE organization_id=$1", [job.organization_id])).rows[0].count);
      if (count + chunks.length > SOURCE_LIMITS.organizationChunks) throw new PlatformError("SOURCE_CHUNK_QUOTA", 429, "Knowledge index limit reached");
      await db.query(`INSERT INTO agents_platform.source_revisions(id,organization_id,source_id,revision,raw_key,text_key,raw_digest,text_digest,chunk_set_digest,raw_bytes,text_bytes,chunk_count,parser_release,normalizer_release,embedding_release,acquired_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [job.revision_id, job.organization_id, job.source_id, job.revision, job.raw_key, textKey, job.raw_digest,
        textDigest(bytes), requestDigest(chunks), job.raw_bytes, bytes.length, chunks.length, job.parser_release, output.normalizerRelease, job.embedding_release, output.acquiredAt]);
      for (const chunk of chunks) await db.query(`INSERT INTO agents_platform.source_chunks(id,organization_id,revision_id,ordinal,start_offset,end_offset,page,section,content,content_digest,token_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [chunk.id, job.organization_id, job.revision_id, chunk.ordinal, chunk.start, chunk.end, chunk.page, chunk.section, chunk.text, chunk.digest, chunk.tokens]);
      await db.query("INSERT INTO agents_platform.source_revision_policy(organization_id,source_id,revision_id) VALUES($1,$2,$3)", [job.organization_id, job.source_id, job.revision_id]);
      await db.query("UPDATE agents_platform.ingestion_jobs SET state='ready',updated_at=now() WHERE id=$1", [jobId]);
    });
  }
}
