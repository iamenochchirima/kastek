import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { assertIngestionPublication,SOURCE_LIMITS,sourceChunkSchema,textDigest,type IngestionJob,type Source,type SourceChunk } from "../../contracts/source-contracts";
import { transaction } from "../../infrastructure/database";
import { PrivateObjectStore } from "../../infrastructure/object-store";
import { writeSourceObject } from "./source-objects";
import { convertStructuredSource } from "./structured-source";
import { assertMcpJobAuthority } from "../../infrastructure/mcp-job-authority";
import { isProductResourceScope, requireProductResourceAccess, resourceAccountId, resourceService, resourceOwnership, resourceMatchesScope,
  knowledgeJobScope, type PersonalResourceScope, type ProductResourceScope } from "../products/resource-scope";
import { fitUtf8 } from "../../infrastructure/utf8";

export type KnowledgeScope = PersonalResourceScope | ProductResourceScope;
export interface KnowledgeSourceDTO extends Source { canApprove: boolean; revisions: { id: string; revision: number; state: "candidate" | "approved" | "withdrawn"; acquiredAt: string; embeddingRelease: string | null }[] }
export interface IngestionJobDTO extends IngestionJob { contentType: string; errorCode: string | null; createdAt: string }
const missing = () => new PlatformError("SOURCE_NOT_FOUND", 404, "Source is unavailable");
const sourceDTO = (row: Record<string, any>): Source => ({ id: row.id, organizationId: row.organization_id,
  importerAccountId: row.importer_account_id, ...(row.importer_service ? { importerService: row.importer_service } : {}), title: row.title, kind: row.kind, generation: row.generation,
  state: row.state, visibility: row.visibility, createdAt: new Date(row.created_at).toISOString() });
const jobDTO = (row: Record<string, any>): IngestionJobDTO => ({ id: row.id, sourceId: row.source_id, revisionId: row.revision_id,
  revision: row.revision, acceptedGeneration: row.accepted_generation, state: row.state, parserRelease: row.parser_release,
  deadline: new Date(row.deadline).toISOString(), contentType: row.content_type, errorCode: row.error_code, createdAt: new Date(row.created_at).toISOString() });

export async function requireKnowledgeMember(db: Pool | PoolClient, scope: KnowledgeScope, owner = false): Promise<string> {
  if (isProductResourceScope(scope)) { await requireProductResourceAccess(db, scope, owner); return "owner"; }
  const row = (await db.query("SELECT role FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [scope.organizationId, resourceAccountId(scope)])).rows[0];
  if (!row || owner && row.role !== "owner") throw new PlatformError("ACCESS_DENIED", 403, "Workspace access is unavailable");
  return row.role;
}

export class KnowledgeStore {
  constructor(readonly pool: Pool, readonly objects?: PrivateObjectStore) {}
  private async requireSourceScope(db: Pool | PoolClient, scope: KnowledgeScope, sourceId: string) {
    if (!isProductResourceScope(scope)) return;
    const row = (await db.query("SELECT importer_service FROM agents_platform.sources WHERE id=$1 AND organization_id=$2", [sourceId, scope.organizationId])).rows[0];
    if (!row || !resourceMatchesScope(row.importer_service, scope)) throw missing();
  }

  async list(scope: KnowledgeScope): Promise<KnowledgeSourceDTO[]> {
    return transaction(this.pool, async db => {
      const role = await requireKnowledgeMember(db, scope);
      const rows = (await db.query(`SELECT * FROM agents_platform.sources WHERE organization_id=$1
        AND ($2='owner' OR importer_account_id=$3) AND ($4::jsonb IS NULL OR importer_service @> $4::jsonb)
        ORDER BY created_at,id LIMIT 200`, [scope.organizationId, role, resourceAccountId(scope), isProductResourceScope(scope) ? resourceOwnership(scope) : null])).rows;
      const revisions = rows.length ? (await db.query(`SELECT r.source_id,r.id,r.revision,p.state,r.acquired_at,r.embedding_release
        FROM agents_platform.source_revisions r JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id
        JOIN agents_platform.ingestion_jobs j ON j.revision_id=r.id AND j.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.source_id=ANY($2::uuid[]) AND ($3='owner' OR j.importer_account_id=$4)
        ORDER BY r.revision`, [scope.organizationId, rows.map(row => row.id), role, resourceAccountId(scope)])).rows : [];
      return rows.map(row => ({ ...sourceDTO(row), canApprove: role === "owner" && (!isProductResourceScope(scope) || scope.authority === "manage"), revisions: revisions.filter(rev => rev.source_id === row.id).map(rev => ({ id: rev.id, revision: rev.revision, state: rev.state, acquiredAt: new Date(rev.acquired_at).toISOString(), embeddingRelease: rev.embedding_release })) }));
    });
  }

  /** Plain UTF-8 text needs no executable document parser; sealing and review stay shared. */
  async admitText(scope: KnowledgeScope, raw: { operationId: string; title: string; text: string; contentType?: "text/plain" | "text/markdown" | "application/json" | "text/csv"; sourceId?: string }): Promise<IngestionJobDTO> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    const input = z.strictObject({ operationId: z.string().min(1).max(128), title: z.string().trim().min(1).max(200),
      text: z.string().min(1).refine(value => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 262144),
      contentType: z.enum(["text/plain", "text/markdown", "application/json", "text/csv"]).default("text/plain"), sourceId: z.uuid().optional() }).parse(raw);
    const text = input.contentType === "application/json" || input.contentType === "text/csv"
      ? convertStructuredSource(input.contentType, Buffer.from(input.text, "utf8")) : input.text;
    const contentType = input.contentType === "application/json" || input.contentType === "text/csv" ? "text/markdown" : input.contentType;
    const bytes = Buffer.from(text, "utf8"), rawDigest = textDigest(bytes), parserRelease = "inline-text-v1";
    const admitted = await this.admit(scope, { operationId: input.operationId, title: input.title, sourceId: input.sourceId,
      contentType, rawDigest, rawBytes: bytes.length, parserRelease, kind: "upload" }, requestDigest({ ...input, parserRelease, rawDigest }), false);
    if (admitted.state === "ready") return jobDTO(admitted);
    if (["failed", "cancelled"].includes(admitted.state)) throw new PlatformError("INGESTION_INVALIDATED", 409, "The source import is unavailable");
    await writeSourceObject(this.pool, this.objects, { jobId: admitted.id, key: admitted.raw_key, bytes, contentType, kind: "raw" });
    await transaction(this.pool, async db => {
      await requireKnowledgeMember(db, scope, isProductResourceScope(scope));
      await assertMcpJobAuthority(db,{mcp_connection_id:admitted.mcp_connection_id,organization_id:admitted.organization_id,importer_account_id:admitted.importer_account_id});
      const changed = await db.query("UPDATE agents_platform.ingestion_jobs SET raw_state='available',state=CASE WHEN state='ready' THEN state ELSE 'extracting' END,updated_at=now() WHERE id=$1 AND state IN ('queued','extracting','ready')", [admitted.id]);
      if (!changed.rowCount) throw new PlatformError("INGESTION_INVALIDATED", 409, "The source import changed before sealing");
    });
    const chunks: SourceChunk[] = []; let offset = 0;
    while (offset < text.length) {
      const content = fitUtf8(text.slice(offset), 384), end = offset + content.length;
      const chunkDigest=requestDigest({revisionId:admitted.revision_id,ordinal:chunks.length,release:"source-chunk-v1"});
      const chunkId=`${chunkDigest.slice(0,8)}-${chunkDigest.slice(8,12)}-5${chunkDigest.slice(13,16)}-a${chunkDigest.slice(17,20)}-${chunkDigest.slice(20,32)}`;
      chunks.push({ id: chunkId, revisionId: admitted.revision_id, ordinal: chunks.length, start: offset, end,
        page: 1, section: null, text: content, digest: textDigest(content), tokens: Buffer.byteLength(content, "utf8") });
      offset = end;
    }
    await this.publishExtraction(admitted.id, { text, chunks, normalizerRelease: "utf8-verbatim-v1", acquiredAt: new Date(admitted.created_at).toISOString() });
    return this.getJob(scope, admitted.id);
  }

  async admitUpload(scope: KnowledgeScope, raw: { operationId: string; title: string; contentType: string; content: Uint8Array; parserRelease: string; embeddingRelease?: string; sourceId?: string }): Promise<IngestionJobDTO> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    const input = z.strictObject({ operationId: z.string().min(1).max(128), title: z.string().trim().min(1).max(200),
      contentType: z.enum(["text/plain", "text/markdown", "text/html", "application/pdf", "application/json", "text/csv"]), content: z.instanceof(Uint8Array),
      parserRelease: z.string().min(1).max(128), embeddingRelease: z.string().min(1).max(256).optional(), sourceId: z.uuid().optional() }).parse(raw);
    if (!input.content.byteLength || input.content.byteLength > SOURCE_LIMITS.rawBytes) throw new PlatformError("SOURCE_SIZE_INVALID", 413, "File exceeds the import limit");
    const rawDigest = textDigest(input.content), digest = requestDigest({ ...input, content: undefined, rawDigest });
    const content = input.contentType === "application/json" || input.contentType === "text/csv"
      ? Buffer.from(convertStructuredSource(input.contentType, input.content), "utf8") : input.content;
    const contentType = input.contentType === "application/json" || input.contentType === "text/csv" ? "text/markdown" : input.contentType;
    const admitted = await this.admit(scope, { ...input, contentType, rawDigest: textDigest(content), rawBytes: content.byteLength, kind: "upload" }, digest);
    if (["cancelled", "failed", "ready"].includes(admitted.state)) return jobDTO(admitted);
    await writeSourceObject(this.pool,this.objects,{jobId:admitted.id,key:admitted.raw_key,bytes:content,contentType,kind:"raw"});
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
    return jobDTO(current);
  }

  private async admit(scope: KnowledgeScope, input: { operationId: string; title: string; contentType: string; rawDigest: string | null; rawBytes: number; parserRelease: string; embeddingRelease?: string; sourceId?: string; kind: "upload" | "public_url"; authorizedUrl?: string }, digest: string, enqueue = true): Promise<Record<string, any>> {
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      await requireKnowledgeMember(db, scope, isProductResourceScope(scope));
      const connectionId=(scope as KnowledgeScope & {connectionId?:string}).connectionId??null;
      await assertMcpJobAuthority(db,{mcp_connection_id:connectionId,organization_id:scope.organizationId,importer_account_id:resourceAccountId(scope)});
      const existing = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE organization_id=$1 AND importer_account_id IS NOT DISTINCT FROM $2::uuid AND operation_id=$3 AND importer_service IS NOT DISTINCT FROM $4::jsonb", [scope.organizationId, resourceAccountId(scope), input.operationId, resourceService(scope)])).rows[0];
      if (existing) {
        if (existing.request_digest !== digest || existing.mcp_connection_id!==connectionId) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request identity conflict");
        return existing;
      }
      const active = Number((await db.query("SELECT count(*) FROM agents_platform.ingestion_jobs WHERE organization_id=$1 AND state NOT IN ('ready','failed','cancelled')", [scope.organizationId])).rows[0].count);
      if (active >= SOURCE_LIMITS.concurrentImports) throw new PlatformError("IMPORT_CONCURRENCY_LIMIT", 429, "Too many active imports");
      let source: Record<string, any>;
      if (input.sourceId) {
        await requireKnowledgeMember(db, scope, true);
        await this.requireSourceScope(db, scope, input.sourceId);
        source = (await db.query("SELECT * FROM agents_platform.sources WHERE id=$1 AND organization_id=$2 FOR UPDATE", [input.sourceId, scope.organizationId])).rows[0];
        if (!source || source.state !== "active") throw missing();
      } else {
        const count = Number((await db.query("SELECT count(*) FROM agents_platform.sources WHERE organization_id=$1 AND state='active'", [scope.organizationId])).rows[0].count);
        if (count >= SOURCE_LIMITS.organizationSources) throw new PlatformError("SOURCE_QUOTA", 429, "Source limit reached");
        source = (await db.query("INSERT INTO agents_platform.sources(id,organization_id,importer_account_id,title,kind,importer_service) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [randomUUID(), scope.organizationId, resourceAccountId(scope), input.title, input.kind, resourceService(scope)])).rows[0];
      }
      const jobId = randomUUID(), revisionId = randomUUID();
      const revision = Number((await db.query("SELECT coalesce(max(revision),0)+1 AS next FROM agents_platform.ingestion_jobs WHERE source_id=$1", [source.id])).rows[0].next);
      const row = (await db.query(`INSERT INTO agents_platform.ingestion_jobs(id,organization_id,source_id,importer_account_id,operation_id,request_digest,revision_id,revision,accepted_generation,
        content_type,raw_key,raw_digest,raw_bytes,parser_release,embedding_release,deadline,authorized_url,importer_service,mcp_connection_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [jobId, scope.organizationId, source.id, resourceAccountId(scope), input.operationId, digest, revisionId, revision, source.generation,
        input.contentType, `knowledge/${scope.organizationId}/${source.id}/${revisionId}/raw`, input.rawDigest, input.rawBytes,
        input.parserRelease, input.embeddingRelease ?? null, new Date(Date.now() + SOURCE_LIMITS.importWallMs), input.authorizedUrl ?? null, resourceService(scope),connectionId])).rows[0];
      if (enqueue) await db.query("INSERT INTO agents_platform.ingestion_outbox(job_id) VALUES($1)", [jobId]);
      return row;
    });
  }

  async admitUrl(scope: KnowledgeScope, raw: { operationId: string; title: string; url: string; parserRelease: string; embeddingRelease?: string; sourceId?: string }): Promise<IngestionJobDTO> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    const input = z.strictObject({ operationId: z.string().min(1).max(128), title: z.string().trim().min(1).max(200), url: z.url().max(2048),
      parserRelease: z.string().min(1).max(128), embeddingRelease: z.string().min(1).max(256).optional(), sourceId: z.uuid().optional() }).parse(raw);
    const url = new URL(input.url);
    if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash) throw new PlatformError("DESTINATION_DENIED", 400, "Select a public HTTPS source");
    const admitted = await this.admit(scope, { ...input, contentType: "application/octet-stream", rawDigest: null, rawBytes: 0, kind: "public_url", authorizedUrl: url.href }, requestDigest({ ...input, url: url.href, kind: "public_url" }));
    return jobDTO(admitted);
  }

  async getJob(scope: KnowledgeScope, jobId: string): Promise<IngestionJobDTO> {
    z.uuid().parse(jobId);
    return transaction(this.pool, async db => {
      const role = await requireKnowledgeMember(db, scope);
      const row = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1 AND organization_id=$2 AND ($3='owner' OR importer_account_id=$4)", [jobId, scope.organizationId, role, resourceAccountId(scope)])).rows[0];
      if (!row) throw missing();
      await this.requireSourceScope(db, scope, row.source_id);
      return jobDTO(row);
    });
  }

  async listImports(scope: KnowledgeScope): Promise<IngestionJobDTO[]> {
    return transaction(this.pool, async db => {
      const role = await requireKnowledgeMember(db, scope);
      return (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE organization_id=$1 AND ($2='owner' OR importer_account_id=$3) AND ($4::jsonb IS NULL OR importer_service @> $4::jsonb) ORDER BY created_at DESC,id LIMIT 200", [scope.organizationId, role, resourceAccountId(scope), isProductResourceScope(scope) ? resourceOwnership(scope) : null])).rows.map(jobDTO);
    });
  }

  async preview(scope: KnowledgeScope, sourceId: string, revisionId: string) {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    z.uuid().parse(sourceId); z.uuid().parse(revisionId);
    const metadata = await transaction(this.pool, async db => {
      const role = await requireKnowledgeMember(db, scope);
      await this.requireSourceScope(db, scope, sourceId);
      const row = (await db.query(`SELECT r.*,s.generation FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id
        JOIN agents_platform.ingestion_jobs j ON j.revision_id=r.id AND j.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND s.id=$2 AND r.id=$3 AND s.state='active' AND ($4='owner' OR j.importer_account_id=$5)`, [scope.organizationId, sourceId, revisionId, role, resourceAccountId(scope)])).rows[0];
      if (!row) throw missing();
      return row;
    });
    const bytes = await this.objects.get(metadata.text_key);
    if (textDigest(bytes) !== metadata.text_digest) throw new PlatformError("SOURCE_INTEGRITY", 409, "Source content is unavailable");
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR SHARE", [scope.organizationId]);
      const role = await requireKnowledgeMember(db, scope);
      await this.requireSourceScope(db, scope, sourceId);
      const current = await db.query(`SELECT s.id FROM agents_platform.sources s JOIN agents_platform.ingestion_jobs j ON j.source_id=s.id AND j.organization_id=s.organization_id
        WHERE s.organization_id=$1 AND s.id=$2 AND s.generation=$3 AND s.state='active' AND j.revision_id=$6 AND ($4='owner' OR j.importer_account_id=$5)`, [scope.organizationId, sourceId, metadata.generation, role, resourceAccountId(scope), revisionId]);
      if (!current.rowCount) throw missing();
      const chunks = (await db.query("SELECT id,page,start_offset,end_offset,content FROM agents_platform.source_chunks WHERE organization_id=$1 AND revision_id=$2 ORDER BY ordinal", [scope.organizationId, revisionId])).rows;
      return { revisionId, revision: metadata.revision, acquiredAt: new Date(metadata.acquired_at).toISOString(), text: Buffer.from(bytes).toString("utf8"),
        chunks: chunks.map(chunk => ({ id: chunk.id, page: chunk.page, start: chunk.start_offset, end: chunk.end_offset, text: chunk.content })) };
    });
  }

  async cancel(scope: KnowledgeScope, jobId: string): Promise<IngestionJobDTO> {
    z.uuid().parse(jobId);
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      const role = await requireKnowledgeMember(db, scope);
      const row = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1 AND organization_id=$2 AND ($3='owner' OR importer_account_id=$4) FOR UPDATE", [jobId, scope.organizationId, role, resourceAccountId(scope)])).rows[0];
      if (!row) throw missing();
      await this.requireSourceScope(db, scope, row.source_id);
      if (["ready", "failed", "cancelled"].includes(row.state)) return jobDTO(row);
      const next = (await db.query("UPDATE agents_platform.ingestion_jobs SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *", [jobId])).rows[0];
      return jobDTO(next);
    });
  }

  async setPolicy(scope: KnowledgeScope, sourceId: string, raw: { operationId: string; expectedGeneration: number; action: "approve" | "withdraw" | "visibility"; revisionId?: string; visibility?: "private" | "public" }): Promise<Source> {
    return transaction(this.pool, db => this.setPolicyInTransaction(db,scope,sourceId,raw));
  }
  async setPolicyInTransaction(db: PoolClient, scope: KnowledgeScope, sourceId: string, raw: { operationId: string; expectedGeneration: number; action: "approve" | "withdraw" | "visibility"; revisionId?: string; visibility?: "private" | "public" }): Promise<Source> {
    z.uuid().parse(sourceId);
    const input = z.strictObject({ operationId: z.string().min(1).max(128), expectedGeneration: z.number().int().positive(),
      action: z.enum(["approve", "withdraw", "visibility"]), revisionId: z.uuid().optional(), visibility: z.enum(["private", "public"]).optional() }).parse(raw);
    if (input.action === "approve" && !input.revisionId || input.action === "visibility" && !input.visibility) throw new PlatformError("INVALID_INPUT", 400, "Select a revision or visibility");
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      await requireKnowledgeMember(db, scope, true);
      const digest = requestDigest({ sourceId, ...input });
      const old = (await db.query("SELECT * FROM agents_platform.source_mutations WHERE organization_id=$1 AND account_id IS NOT DISTINCT FROM $2::uuid AND operation_id=$3 AND actor_service IS NOT DISTINCT FROM $4::jsonb", [scope.organizationId, resourceAccountId(scope), input.operationId, resourceService(scope)])).rows[0];
      if (old) {
        if (old.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request identity conflict");
        return old.result as Source;
      }
      const row = (await db.query("SELECT * FROM agents_platform.sources WHERE id=$1 AND organization_id=$2 FOR UPDATE", [sourceId, scope.organizationId])).rows[0];
      if (!row) throw missing();
      await this.requireSourceScope(db, scope, sourceId);
      if (row.generation !== input.expectedGeneration || row.state !== "active") throw new PlatformError("SOURCE_POLICY_CONFLICT", 409, "Source changed; refresh and try again");
      if (input.action === "approve") {
        const approved = await db.query("UPDATE agents_platform.source_revision_policy SET state='approved',approved_by=$3,approved_by_service=$5,approved_at=now() WHERE source_id=$1 AND revision_id=$2 AND organization_id=$4 AND state='candidate' RETURNING revision_id", [sourceId, input.revisionId, resourceAccountId(scope), scope.organizationId, resourceService(scope)]);
        if (!approved.rowCount) throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "Select an available candidate revision");
      } else {
        await db.query("UPDATE agents_platform.sources SET generation=generation+1,state=$2,visibility=$3 WHERE id=$1", [sourceId, input.action === "withdraw" ? "withdrawn" : "active", input.visibility ?? row.visibility]);
        if (input.action === "withdraw") {
          await db.query("UPDATE agents_platform.source_revision_policy SET state='withdrawn' WHERE source_id=$1", [sourceId]);
          await db.query("UPDATE agents_platform.ingestion_jobs SET state='cancelled',updated_at=now() WHERE source_id=$1 AND state NOT IN ('ready','failed','cancelled')", [sourceId]);
        }
      }
      const result = sourceDTO((await db.query("SELECT * FROM agents_platform.sources WHERE id=$1", [sourceId])).rows[0]);
      await db.query("INSERT INTO agents_platform.source_mutations(organization_id,account_id,operation_id,request_digest,result,actor_service) VALUES($1,$2,$3,$4,$5,$6)", [scope.organizationId, resourceAccountId(scope), input.operationId, digest, JSON.stringify(result), resourceService(scope)]);
      return result;

  }

  async publishExtraction(jobId: string, output: { text: string; chunks: SourceChunk[]; normalizerRelease: string; acquiredAt: string; embeddings?: number[][] }): Promise<void> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    z.uuid().parse(jobId); z.iso.datetime().parse(output.acquiredAt); z.string().min(1).max(128).parse(output.normalizerRelease);
    const bytes = Buffer.from(output.text);
    if (!bytes.length || bytes.length > SOURCE_LIMITS.textBytes || output.chunks.length < 1 || output.chunks.length > SOURCE_LIMITS.chunks) throw new PlatformError("EXTRACTION_LIMIT", 413, "Extracted content exceeds its limit");
    const chunks = output.chunks.map(chunk => sourceChunkSchema.parse(chunk));
    const before = (await this.pool.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1", [jobId])).rows[0];
    if (!before) throw missing();
    if (before.embedding_release) {
      if (output.embeddings?.length !== chunks.length) throw new PlatformError("EMBEDDING_INCOMPLETE", 409, "Embedding index is incomplete");
      for (const vector of output.embeddings) assertEmbeddingVector(vector);
    } else if (output.embeddings) throw new PlatformError("EMBEDDING_PROFILE_CONFLICT", 409, "Embedding profile does not match the import");
    const textKey = `knowledge/${before.organization_id}/${before.source_id}/${before.revision_id}/${textDigest(bytes)}`;
    for (const [ordinal, chunk] of chunks.entries()) if (chunk.revisionId !== before.revision_id || chunk.ordinal !== ordinal || output.text.slice(chunk.start, chunk.end) !== chunk.text) throw new PlatformError("EXTRACTION_INTEGRITY", 409, "Extracted chunks are invalid");
    await writeSourceObject(this.pool,this.objects,{jobId,key:textKey,bytes,contentType:"text/plain; charset=utf-8",kind:"text"});
    await transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [before.organization_id]);
      await requireKnowledgeMember(db, knowledgeJobScope(before));
      await assertMcpJobAuthority(db,before);
      const source = (await db.query("SELECT * FROM agents_platform.sources WHERE id=$1 FOR UPDATE", [before.source_id])).rows[0];
      const job = (await db.query("SELECT * FROM agents_platform.ingestion_jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0];
      if (job.state === "ready") {
        const existing = (await db.query("SELECT text_digest,chunk_set_digest,embedding_digest FROM agents_platform.source_revisions WHERE id=$1", [job.revision_id])).rows[0];
        if (!existing || existing.text_digest !== textDigest(bytes) || existing.chunk_set_digest !== requestDigest(chunks) || existing.embedding_digest !== (output.embeddings ? requestDigest(output.embeddings) : null)) throw new PlatformError("EXTRACTION_INTEGRITY", 409, "Import replay changed its content");
        return;
      }
      assertIngestionPublication(jobDTO(job), sourceDTO(source));
      const count = Number((await db.query("SELECT count(*) FROM agents_platform.source_chunks WHERE organization_id=$1", [job.organization_id])).rows[0].count);
      if (count + chunks.length > SOURCE_LIMITS.organizationChunks) throw new PlatformError("SOURCE_CHUNK_QUOTA", 429, "Knowledge index limit reached");
      await db.query(`INSERT INTO agents_platform.source_revisions(id,organization_id,source_id,revision,raw_key,text_key,raw_digest,text_digest,chunk_set_digest,raw_bytes,text_bytes,chunk_count,parser_release,normalizer_release,embedding_release,acquired_at,embedding_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [job.revision_id, job.organization_id, job.source_id, job.revision, job.raw_key, textKey, job.raw_digest,
        textDigest(bytes), requestDigest(chunks), job.raw_bytes, bytes.length, chunks.length, job.parser_release, output.normalizerRelease, job.embedding_release, output.acquiredAt, output.embeddings ? requestDigest(output.embeddings) : null]);
      for (const chunk of chunks) await db.query(`INSERT INTO agents_platform.source_chunks(id,organization_id,revision_id,ordinal,start_offset,end_offset,page,section,content,content_digest,token_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [chunk.id, job.organization_id, job.revision_id, chunk.ordinal, chunk.start, chunk.end, chunk.page, chunk.section, chunk.text, chunk.digest, chunk.tokens]);
      if (output.embeddings) for (const [index, vector] of output.embeddings.entries()) await db.query(
        "INSERT INTO agents_platform.chunk_embeddings(organization_id,chunk_id,embedding_release,embedding) VALUES($1,$2,$3,$4::public.vector)",
        [job.organization_id, chunks[index]!.id, job.embedding_release, `[${vector.join(",")}]`]);
      await db.query("INSERT INTO agents_platform.source_revision_policy(organization_id,source_id,revision_id) VALUES($1,$2,$3)", [job.organization_id, job.source_id, job.revision_id]);
      await db.query("UPDATE agents_platform.ingestion_jobs SET state='ready',updated_at=now() WHERE id=$1", [jobId]);
    });
  }
}

export function assertEmbeddingVector(vector: number[]): void {
  if (!Array.isArray(vector) || vector.length !== 384 || vector.some(value => !Number.isFinite(value) || Math.abs(value) > 1.00001) || Math.abs(Math.hypot(...vector) - 1) > 0.0001) {
    throw new PlatformError("EMBEDDING_INVALID", 409, "Embedding vector is invalid");
  }
}
