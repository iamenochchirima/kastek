import * as restate from "@restatedev/restate-sdk";
import { restateServiceName } from "../../contracts/restate-names";
import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { textDigest,type SourceChunk } from "../../contracts/source-contracts";
import { transaction } from "../../infrastructure/database";
import { PrivateObjectStore } from "../../infrastructure/object-store";
import { type DocumentInput,type DocumentOutput,type DocumentRuntime } from "./document-runtime";
import { KnowledgeStore,requireKnowledgeMember } from "./knowledge";
import { acquirePublicSource,SourceAcquisitionError } from "./source-acquisition";
import { writeSourceObject } from "./source-objects";
import { knowledgeJobScope } from "../products/resource-scope";
import { assertMcpJobAuthority } from "../../infrastructure/mcp-job-authority";

export const INGESTION_WORKFLOW = "AgentsKnowledgeImportV1";
type Runtime = Pick<DocumentRuntime, "start" | "status" | "result" | "destroy">;
type Stage = "parse" | "chunk" | "embed";
export interface StageReceipt { allocationId: string; key: string; digest: string }
const failure = (code: string) => new PlatformError(code, 409, "Import cannot continue");

export class IngestionService {
  constructor(readonly pool: Pool, readonly objects: PrivateObjectStore, readonly runtime: Runtime, readonly knowledge: KnowledgeStore) {}

  async acquire(jobId: string): Promise<void> {
    const input = await transaction(this.pool, async db => {
      const job = await this.lockJob(db, jobId);
      if (job.raw_state === "available") return null;
      if (!job.authorized_url) throw failure("SOURCE_UPLOAD_UNAVAILABLE");
      if (job.acquisition_claimed_at) throw failure("SOURCE_ACQUISITION_UNCERTAIN");
      await db.query("UPDATE agents_platform.ingestion_jobs SET state='acquiring',acquisition_claimed_at=now(),updated_at=now() WHERE id=$1", [jobId]);
      return job;
    });
    if (!input) return;
    const abort = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void transaction(this.pool, db => this.lockJob(db, jobId)).catch(() => abort.abort()).finally(() => { checking = false; });
    }, 250);
    try {
      const result = await acquirePublicSource({ url: input.authorized_url, deadlineAt: Math.min(Date.now() + 30_000, new Date(input.deadline).getTime()) }, abort.signal);
      await writeSourceObject(this.pool,this.objects,{jobId,key:input.raw_key,bytes:result.bytes,contentType:result.contentType,kind:"raw"});
      await transaction(this.pool, async db => {
        await this.lockJob(db, jobId);
        await db.query(`UPDATE agents_platform.ingestion_jobs SET raw_state='available',raw_digest=$2,raw_bytes=$3,content_type=$4,acquired_at=$5,acquisition_receipt=$6,updated_at=now()
          WHERE id=$1`, [jobId, result.rawDigest, result.bytes.length, result.contentType, result.acquiredAt,
          JSON.stringify({ attempts: result.attempts, finalUrl: result.finalUrl, etag: result.etag, lastModified: result.lastModified })]);
      });
    } catch (error) {
      if (error instanceof SourceAcquisitionError) {
        await this.pool.query("UPDATE agents_platform.ingestion_jobs SET acquisition_receipt=$2 WHERE id=$1", [jobId, JSON.stringify({ attempts: error.attempts, errorCode: error.code })]);
        throw failure(error.code);
      }
      throw error;
    } finally { clearInterval(timer); }
  }

  private async lockJob(db: PoolClient, jobId: string): Promise<Record<string, any>> {
    const initial = (await db.query("SELECT organization_id FROM agents_platform.ingestion_jobs WHERE id=$1", [jobId])).rows[0];
    if (!initial) throw failure("SOURCE_NOT_FOUND");
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [initial.organization_id]);
    const job = (await db.query(`SELECT j.*,s.state AS source_state,s.generation AS current_generation FROM agents_platform.ingestion_jobs j
      JOIN agents_platform.sources s ON s.id=j.source_id WHERE j.id=$1 FOR UPDATE OF s,j`, [jobId])).rows[0];
    await requireKnowledgeMember(db, knowledgeJobScope(job));
    await assertMcpJobAuthority(db,job);
    if (["cancelled", "failed"].includes(job.state) || job.source_state !== "active" || job.accepted_generation !== job.current_generation || new Date(job.deadline).getTime() <= Date.now()) throw failure("INGESTION_INVALIDATED");
    return job;
  }

  async begin(jobId: string): Promise<{ profileRelease: string; embeddingRelease: string | null; format: "pdf" | "html" | "text" | "markdown"; rawKey: string; rawDigest: string; revisionId: string; acquiredAt: string }> {
    return transaction(this.pool, async db => {
      const job = await this.lockJob(db, jobId);
      if (job.raw_state !== "available") throw failure("SOURCE_UPLOAD_UNAVAILABLE");
      const formats = { "application/pdf": "pdf", "text/html": "html", "text/plain": "text", "text/markdown": "markdown" } as const;
      const format = formats[job.content_type as keyof typeof formats];
      if (!format) throw failure("DOCUMENT_UNSUPPORTED");
      if (job.state === "queued" || job.state === "acquiring") await db.query("UPDATE agents_platform.ingestion_jobs SET state='extracting',updated_at=now() WHERE id=$1", [jobId]);
      if (job.embedding_release && job.embedding_release !== job.parser_release) throw failure("EMBEDDING_PROFILE_UNAVAILABLE");
      return { profileRelease: job.parser_release, embeddingRelease: job.embedding_release, format, rawKey: job.raw_key, rawDigest: job.raw_digest, revisionId: job.revision_id, acquiredAt: new Date(job.acquired_at ?? job.created_at).toISOString() };
    });
  }

  async stage(jobId: string, stage: Stage, input: DocumentInput, profileRelease: string, stageIndex = 0): Promise<StageReceipt> {
    if (input.kind !== stage || !Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 63) throw failure("DOCUMENT_STAGE_INVALID");
    const inputDigest = requestDigest(input.kind === "parse" ? { ...input, content: textDigest(input.content) } : input);
    const allocation = await transaction(this.pool, async db => {
      const job = await this.lockJob(db, jobId);
      if (job.parser_release !== profileRelease) throw failure("DOCUMENT_PROFILE_UNAVAILABLE");
      let row = (await db.query("SELECT * FROM agents_platform.document_allocations WHERE job_id=$1 AND stage=$2 AND stage_index=$3 FOR UPDATE", [jobId, stage, stageIndex])).rows[0];
      if (row) {
        if (row.input_digest !== inputDigest || row.profile_release !== profileRelease) throw failure("DOCUMENT_STAGE_CONFLICT");
        if (row.result_key) return row;
        if (["destroyed", "failed"].includes(row.state)) throw failure("DOCUMENT_RESOURCE_EXPIRED");
      } else {
        if (job.state === "ready") throw failure("INGESTION_ALREADY_SEALED");
        const live = Number((await db.query(`SELECT (SELECT count(*) FROM agents_platform.document_allocations WHERE organization_id=$1 AND state<>'destroyed')+
          (SELECT count(*) FROM agents_platform.query_embedding_allocations WHERE organization_id=$1 AND state<>'destroyed') AS count`, [job.organization_id])).rows[0].count);
        if (live >= 2) throw failure("DOCUMENT_CAPACITY");
        row = (await db.query(`INSERT INTO agents_platform.document_allocations(id,organization_id,job_id,stage,stage_index,profile_release,input_digest,state,lease_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'admitted',$8) RETURNING *`, [randomUUID(), job.organization_id, jobId, stage, stageIndex, profileRelease, inputDigest,
          new Date(Math.min(Date.now() + 90_000, new Date(job.deadline).getTime()))])).rows[0];
      }
      return row;
    });
    if (allocation.result_key) return { allocationId: allocation.id, key: allocation.result_key, digest: allocation.result_digest };
    // Commit admission before the external start, so a killed worker leaves a reapable allocation.
    const startClaim = await transaction(this.pool, async db => {
      await this.lockJob(db, jobId);
      const row = (await db.query("SELECT * FROM agents_platform.document_allocations WHERE id=$1 FOR UPDATE", [allocation.id])).rows[0];
      if (["destroyed", "failed"].includes(row.state) || row.cleanup_requested_at || new Date(row.lease_expires_at).getTime() <= Date.now()) throw failure("DOCUMENT_RESOURCE_EXPIRED");
      if (row.result_key) return false;
      await db.query("UPDATE agents_platform.document_allocations SET launch_claimed_at=coalesce(launch_claimed_at,now()) WHERE id=$1",[row.id]);return true;
    });
    if(startClaim){
      await this.runtime.start({ allocationId: allocation.id, jobId, profileRelease, input });
      await this.pool.query("UPDATE agents_platform.document_allocations SET state='running',updated_at=now() WHERE id=$1 AND state='admitted' AND cleanup_requested_at IS NULL", [allocation.id]);
      if(stage==="embed")await this.pool.query("UPDATE agents_platform.ingestion_jobs SET state='indexing',updated_at=now() WHERE id=$1 AND state='extracting'",[jobId]);
    }
    while (Date.now() < new Date(allocation.lease_expires_at).getTime()) {
      await transaction(this.pool, db => this.lockJob(db, jobId));
      const state = await this.runtime.status(allocation.id);
      const cached = async (): Promise<StageReceipt | undefined> => {
        const row = (await this.pool.query("SELECT result_key,result_digest FROM agents_platform.document_allocations WHERE id=$1", [allocation.id])).rows[0];
        return row?.result_key ? { allocationId: allocation.id, key: row.result_key, digest: row.result_digest } : undefined;
      };
      if (["completed", "failed"].includes(state.state)) {
        let output;
        try { output = await this.runtime.result(allocation.id); }
        catch (error) { const receipt = await cached(); if (receipt) return receipt; throw error; }
        if (!output) { const receipt = await cached(); if (receipt) return receipt; }
        if (!output || output.receipt.jobId !== jobId || output.receipt.profileRelease !== profileRelease || output.receipt.allocationId !== allocation.id) throw failure("DOCUMENT_RECEIPT_INVALID");
        if (!output.ok) throw failure(output.errorCode);
        if (output.result.kind !== stage) throw failure("DOCUMENT_STAGE_INVALID");
        const bytes = Buffer.from(JSON.stringify(output.result)), digest = textDigest(bytes);
        const key = `knowledge/${allocation.organization_id}/${jobId}/stages/${allocation.id}/${digest}`;
        await writeSourceObject(this.pool,this.objects,{jobId,key,bytes,contentType:"application/json",kind:"stage"});
        await transaction(this.pool, async db => {
          await this.lockJob(db, jobId);
          const current = (await db.query("SELECT * FROM agents_platform.document_allocations WHERE id=$1 FOR UPDATE", [allocation.id])).rows[0];
          if (current.result_digest && current.result_digest !== digest) throw failure("DOCUMENT_RECEIPT_INVALID");
          if (current.result_digest === digest && current.result_key === key) return;
          if (["destroyed", "failed"].includes(current.state)) throw failure("DOCUMENT_RESOURCE_EXPIRED");
          await db.query("UPDATE agents_platform.document_allocations SET state='completed',result_key=$2,result_digest=$3,receipt=$4,updated_at=now() WHERE id=$1", [allocation.id, key, digest, JSON.stringify(output.receipt)]);
        });
        return { allocationId: allocation.id, key, digest };
      }
      if (["uncertain", "destroying", "destroyed"].includes(state.state)) {
        const receipt = await cached(); if (receipt) return receipt;
        throw failure("DOCUMENT_RESOURCE_EXPIRED");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw failure("DOCUMENT_STAGE_DEADLINE");
  }

  async read(receipt: StageReceipt): Promise<DocumentOutput> {
    const bytes = await this.objects.get(receipt.key);
    if (textDigest(bytes) !== receipt.digest) throw failure("DOCUMENT_RECEIPT_INVALID");
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as DocumentOutput;
  }
  async cleanup(allocationId: string): Promise<void> { await cleanupDocumentAllocation(this.pool, this.runtime, allocationId); }
  async fail(jobId: string, code: string): Promise<void> {
    const safeCode = /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : "DOCUMENT_RUNTIME_FAILED";
    await this.pool.query("UPDATE agents_platform.ingestion_jobs SET state='failed',error_code=$2,updated_at=now() WHERE id=$1 AND state NOT IN ('ready','cancelled','failed')", [jobId, safeCode]);
    const rows = (await this.pool.query("SELECT id FROM agents_platform.document_allocations WHERE job_id=$1 AND state<>'destroyed'", [jobId])).rows;
    for (const row of rows) await this.cleanup(row.id);
  }
  async reap(): Promise<void> { await reapDocumentResources(this.pool, this.runtime); }
}

export function createIngestionWorkflow(service: IngestionService) {
  return restate.workflow({ name: restateServiceName(INGESTION_WORKFLOW), options: { workflowRetention: { days: 7 }, journalRetention: { days: 7 } }, handlers: {
    run: async (ctx: restate.WorkflowContext, input: { jobId: string }) => {
      if (ctx.key !== input.jobId) throw new restate.TerminalError("Import identity mismatch", { errorCode: 400 });
      const jobId = input.jobId;
      const bounded = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
        const result = await ctx.run(name, async () => {
          try { return { ok: true as const, value: await action() }; }
          catch (error) { if (error instanceof PlatformError) return { ok: false as const, code: error.code }; throw error; }
        });
        if (!result.ok) throw failure(result.code);
        return result.value;
      };
      try {
        await bounded("acquire", () => service.acquire(jobId));
        const job = await bounded("begin", () => service.begin(jobId));
        const parsedReceipt = await bounded("parse", async () => {
          const content = await service.objects.get(job.rawKey);
          if (textDigest(content) !== job.rawDigest) throw failure("SOURCE_INTEGRITY");
          return service.stage(jobId, "parse", { kind: "parse", format: job.format, content }, job.profileRelease);
        });
        await bounded("parse-cleanup", () => service.cleanup(parsedReceipt.allocationId));
        const chunksReceipt = await bounded("chunk", async () => {
          const parsed = await service.read(parsedReceipt);
          if (parsed.kind !== "parse") throw failure("DOCUMENT_STAGE_INVALID");
          return service.stage(jobId, "chunk", { kind: "chunk", pages: parsed.pages, maxTokens: 384, overlap: 48 }, job.profileRelease);
        });
        await bounded("chunk-cleanup", () => service.cleanup(chunksReceipt.allocationId));
        const embeddings: StageReceipt[] = [];
        if (job.embeddingRelease) {
          const batches = await bounded("embedding-batches", async () => {
            const chunked = await service.read(chunksReceipt);
            if (chunked.kind !== "chunk") throw failure("DOCUMENT_STAGE_INVALID");
            return Math.ceil(chunked.chunks.length / 16);
          });
          for (let index = 0; index < batches; index++) {
            const receipt = await bounded(`embed:${index}`, async () => {
              const chunked = await service.read(chunksReceipt);
              if (chunked.kind !== "chunk") throw failure("DOCUMENT_STAGE_INVALID");
              return service.stage(jobId, "embed", { kind: "embed", mode: "document", texts: chunked.chunks.slice(index * 16, (index + 1) * 16).map(chunk => chunk.text) }, job.profileRelease, index);
            });
            embeddings.push(receipt);
            await bounded(`embed-cleanup:${index}`, () => service.cleanup(receipt.allocationId));
          }
        }
        await bounded("publish", async () => {
          const parsed = await service.read(parsedReceipt), chunked = await service.read(chunksReceipt);
          if (parsed.kind !== "parse" || chunked.kind !== "chunk") throw failure("DOCUMENT_STAGE_INVALID");
          const chunks: SourceChunk[] = chunked.chunks.map((chunk, ordinal) => ({ id: stableChunkId(job.revisionId, ordinal), revisionId: job.revisionId,
            ordinal, start: chunk.start, end: chunk.end, page: chunk.page, section: null, text: chunk.text, digest: textDigest(chunk.text), tokens: chunk.tokenCount }));
          const vectors: number[][] = [];
          for (const receipt of embeddings) {
            const output = await service.read(receipt);
            if (output.kind !== "embed" || output.mode !== "document") throw failure("DOCUMENT_STAGE_INVALID");
            vectors.push(...output.vectors);
          }
          await service.knowledge.publishExtraction(jobId, { text: parsed.text, chunks, normalizerRelease: "nfc-lf-utf16-v1", acquiredAt: job.acquiredAt,
            ...(job.embeddingRelease ? { embeddings: vectors } : {}) });
        });
        return { state: "ready" as const };
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        await ctx.run("fail", () => service.fail(jobId, error.code));
        return { state: "failed" as const, errorCode: error.code };
      }
    },
  } });
}

export function stableChunkId(revisionId: string, ordinal: number): string {
  const hash = requestDigest({ revisionId, ordinal, release: "source-chunk-v1" });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function dispatchImportsOnce(pool: Pool, ingressUrl: string, request: typeof fetch = fetch): Promise<void> {
  await pool.query(`UPDATE agents_platform.ingestion_outbox o SET dispatched_at=now() FROM agents_platform.ingestion_jobs j
    WHERE o.job_id=j.id AND o.dispatched_at IS NULL AND j.state IN ('ready','failed','cancelled')`);
  const rows = (await pool.query(`SELECT o.job_id FROM agents_platform.ingestion_outbox o JOIN agents_platform.ingestion_jobs j ON j.id=o.job_id
    WHERE o.dispatched_at IS NULL AND o.available_at<=now() AND j.deadline>now() AND o.dispatch_attempts<20
    AND (j.raw_state='available' OR j.authorized_url IS NOT NULL) ORDER BY j.created_at LIMIT 10`)).rows;
  for (const row of rows) {
    await pool.query("UPDATE agents_platform.ingestion_outbox SET dispatch_attempts=dispatch_attempts+1,available_at=now()+interval '5 seconds' WHERE job_id=$1", [row.job_id]);
    const response = await request(`${ingressUrl.replace(/\/$/, "")}/restate/send/${restateServiceName(INGESTION_WORKFLOW)}/${row.job_id}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: row.job_id }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw failure("INGESTION_DISPATCH_FAILED");
    const result = await response.json() as { invocationId?: unknown };
    if (typeof result.invocationId !== "string" || !result.invocationId.startsWith("inv_")) throw failure("INGESTION_DISPATCH_FAILED");
    const bound = await pool.query("UPDATE agents_platform.ingestion_outbox SET invocation_id=$2,dispatched_at=now() WHERE job_id=$1 AND (invocation_id IS NULL OR invocation_id=$2)", [row.job_id, result.invocationId]);
    if (!bound.rowCount) throw failure("INGESTION_INVOCATION_CONFLICT");
  }
}

export function startIngestionDispatcher(service: IngestionService, ingressUrl: string, onError: (code: string) => void) {
  let stopped = false, timer: NodeJS.Timeout | undefined, wake: (() => void) | undefined;
  const done = (async () => {
    while (!stopped) {
      try { await dispatchImportsOnce(service.pool, ingressUrl); await service.reap(); }
      catch { onError("INGESTION_PUBLISHER_FAILED"); }
      if (!stopped) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1000); });
    }
  })();
  return { stop: async () => { stopped = true; if (timer) clearTimeout(timer); wake?.(); await done; } };
}

export async function cleanupDocumentAllocation(pool: Pool, runtime: Runtime, allocationId: string): Promise<void> {
    const row = (await pool.query("SELECT organization_id FROM agents_platform.document_allocations WHERE id=$1", [allocationId])).rows[0];
    if (!row) return;
    const pending=await transaction(pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [row.organization_id]);
      const current = (await db.query("SELECT * FROM agents_platform.document_allocations WHERE id=$1 FOR UPDATE", [allocationId])).rows[0];
      if (!current || current.state === "destroyed") return false;
      await db.query("UPDATE agents_platform.document_allocations SET cleanup_requested_at=coalesce(cleanup_requested_at,now()) WHERE id=$1",[allocationId]);return true;
    });
    if(!pending)return;
    const stopped=await runtime.destroy(allocationId);
    if(stopped.state!=="destroyed")throw failure("DOCUMENT_CLEANUP_PENDING");
    await pool.query("UPDATE agents_platform.document_allocations SET state='destroyed',updated_at=now() WHERE id=$1",[allocationId]);
  }

export async function reapDocumentResources(pool: Pool, runtime: Runtime): Promise<void> {
    await pool.query(`UPDATE agents_platform.ingestion_jobs j SET state='failed',error_code=CASE WHEN deadline<=now() THEN 'INGESTION_DEADLINE' ELSE 'INGESTION_INVALIDATED' END,updated_at=now()
      WHERE state NOT IN ('ready','failed','cancelled') AND (deadline<=now()
        OR EXISTS(SELECT 1 FROM agents_platform.sources s WHERE s.id=j.source_id AND (s.state='withdrawn' OR s.generation<>j.accepted_generation))
        OR NOT agents_platform.knowledge_import_authorized(j))`);
    await pool.query(`UPDATE agents_platform.ingestion_jobs j SET state='failed',error_code='SOURCE_WRITE_UNCERTAIN',updated_at=now()
      WHERE j.state NOT IN ('ready','failed','cancelled') AND j.raw_state='pending'
      AND EXISTS(SELECT 1 FROM agents_platform.source_objects o WHERE o.job_id=j.id AND o.kind='raw' AND o.state IN ('delete_pending','deleted'))`);
    const rows = (await pool.query(`SELECT a.id FROM agents_platform.document_allocations a JOIN agents_platform.ingestion_jobs j ON j.id=a.job_id
      JOIN agents_platform.sources s ON s.id=j.source_id WHERE a.state<>'destroyed'
      AND (a.state='completed' OR a.lease_expires_at<=now() OR j.deadline<=now() OR j.state IN ('cancelled','failed','ready') OR s.state='withdrawn' OR s.generation<>j.accepted_generation
      OR NOT agents_platform.knowledge_import_authorized(j)) LIMIT 20`)).rows;
    for (const row of rows) await cleanupDocumentAllocation(pool, runtime, row.id);
    await pool.query("UPDATE agents_platform.ingestion_jobs SET state='failed',error_code='INGESTION_DEADLINE',updated_at=now() WHERE state NOT IN ('ready','failed','cancelled') AND deadline<=now()");
  }
