import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrivateObjectStore } from "../src/platform/artifacts";
import type { DocumentAllocation, DocumentOutput, DocumentRuntime, DocumentRuntimeResult } from "../src/platform/document-runtime";
import { IngestionService, stableChunkId } from "../src/platform/ingestion-runtime";
import { KnowledgeStore, type KnowledgeScope } from "../src/platform/knowledge";
import { PlatformStore } from "../src/platform/store";
import { setupPlatformSchema } from "../src/platform/setup";
import { textDigest } from "../src/platform/source-contracts";

const dbUrl = process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl ? describe : describe.skip)("durable ingestion resource accounting with real PostgreSQL and explicit runtime/object fixtures", () => {
  let pool: Pool, admin: Pool, platform: PlatformStore, store: KnowledgeStore, service: IngestionService;
  const database = `agents_ingestion_${randomUUID().replaceAll("-", "")}`, objects = new Map<string, Uint8Array>(), results = new Map<string, DocumentRuntimeResult>();
  let starts = 0, cleanupPending = false, beforeStart: (() => Promise<void>) | undefined;
  const objectStore: PrivateObjectStore = { async get(key) { const value = objects.get(key); if (!value) throw Error("Fixture object missing"); return value; },
    async put(key, value) { objects.set(key, Buffer.from(value)); }, async delete(key) { objects.delete(key); } };
  const runtime: Pick<DocumentRuntime, "start" | "status" | "result" | "destroy"> = {
    async start(input: DocumentAllocation) {
      if (!results.has(input.allocationId)) {
        starts++; await beforeStart?.();
        const result: DocumentOutput = input.input.kind === "parse" ? { kind: "parse", text: "Evidence", textDigest: textDigest("Evidence"), offsetEncoding: "utf16", pages: [{ page: 1, start: 0, end: 8, text: "Evidence" }] }
          : input.input.kind === "chunk" ? { kind: "chunk", chunks: [{ page: 1, start: 0, end: 8, text: "Evidence", tokenCount: 3 }], offsetEncoding: "utf16", maxTokens: 384, overlap: 48 }
          : { kind: "embed", vectors: [Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0)], tokenCounts: [3], dimensions: 384, pooling: "cls", normalization: "l2", mode: "document" };
        results.set(input.allocationId, { ok: true, result, receipt: { allocationId: input.allocationId, jobId: input.jobId,
          profileRelease: input.profileRelease, inputDigest: "0".repeat(64), durationMs: 1, memoryPeakBytes: 1024 } });
      }
      return { allocationId: input.allocationId, state: "completed" };
    },
    async status(id) { return { allocationId: id, state: "completed" }; }, async result(id) { return results.get(id); },
    async destroy(id) { return { allocationId: id, state: cleanupPending ? "destroying" : "destroyed" }; },
  };
  beforeAll(async () => {
    admin = new Pool({ connectionString: dbUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(dbUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href, max: 10 });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool); store = new KnowledgeStore(pool, objectStore); service = new IngestionService(pool, objectStore, runtime, store);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); } });
  async function fixture(): Promise<KnowledgeScope> {
    const account = await platform.ensureAccount({ issuer: "http://localhost:8080/realms/import", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    return { accountId: account.id, organizationId: (await platform.createOrganization(account.id, "Import")).id };
  }
  const input = () => ({ operationId: randomUUID(), title: "Evidence", contentType: "text/plain", content: Buffer.from("Evidence"), parserRelease: "document-test-v1" });

  it("recovers a completed stage from its private receipt after resource destruction without repeating execution", async () => {
    const scope = await fixture(), job = await store.admitUpload(scope, input()); await service.begin(job.id);
    const request = { kind: "parse" as const, format: "text" as const, content: Buffer.from("Evidence") }, before = starts;
    const receipt = await service.stage(job.id, "parse", request, "document-test-v1");
    await service.cleanup(receipt.allocationId);
    expect((await service.stage(job.id, "parse", request, "document-test-v1"))).toEqual(receipt);
    expect((await service.read(receipt)).kind).toBe("parse"); expect(starts - before).toBe(1);
    await expect(service.stage(job.id, "parse", { ...request, content: Buffer.from("Changed") }, "document-test-v1")).rejects.toMatchObject({ code: "DOCUMENT_STAGE_CONFLICT" });
    objects.set(receipt.key, Buffer.from("corrupt")); await expect(service.read(receipt)).rejects.toMatchObject({ code: "DOCUMENT_RECEIPT_INVALID" });
  });

  it("commits a reapable allocation before physical start and prevents cancelled work publishing a receipt", async () => {
    const scope = await fixture(), job = await store.admitUpload(scope, input()); await service.begin(job.id);
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    beforeStart = async () => { entered(); await released; };
    const running = service.stage(job.id, "parse", { kind: "parse", format: "text", content: Buffer.from("Evidence") }, "document-test-v1");
    const rejection = expect(running).rejects.toMatchObject({ code: "INGESTION_INVALIDATED" });
    await entering;
    const allocation = (await pool.query("SELECT * FROM agents_platform.document_allocations WHERE job_id=$1", [job.id])).rows[0];
    expect(allocation.state).toBe("admitted");
    const cancellation = store.cancel(scope, job.id); release(); await cancellation; await rejection; beforeStart = undefined;
    await service.reap();
    expect((await pool.query("SELECT state,result_key FROM agents_platform.document_allocations WHERE id=$1", [allocation.id])).rows[0]).toMatchObject({ state: "destroyed", result_key: null });
  });

  it("retains capacity when physical cleanup is uncertain", async () => {
    const scope = await fixture(), job = await store.admitUpload(scope, input()); await service.begin(job.id);
    const receipt = await service.stage(job.id, "parse", { kind: "parse", format: "text", content: Buffer.from("Evidence") }, "document-test-v1");
    cleanupPending = true;
    await expect(service.cleanup(receipt.allocationId)).rejects.toMatchObject({ code: "DOCUMENT_CLEANUP_PENDING" });
    expect((await pool.query("SELECT state FROM agents_platform.document_allocations WHERE id=$1", [receipt.allocationId])).rows[0].state).toBe("completed");
    cleanupPending = false; await service.reap();
    expect((await pool.query("SELECT state FROM agents_platform.document_allocations WHERE id=$1", [receipt.allocationId])).rows[0].state).toBe("destroyed");
  });

  it("recovers a lost upload acknowledgement and does not repeat an uncertain URL acquisition", async () => {
    const scope = await fixture(), raw = input(); let lost = true;
    const broken = new KnowledgeStore(pool, { ...objectStore, async put(key, value, type) { await objectStore.put(key, value, type); if (lost) { lost = false; throw Error("lost fixture acknowledgement"); } } });
    await expect(broken.admitUpload(scope, raw)).rejects.toThrow("lost fixture acknowledgement");
    const job = await store.admitUpload(scope, raw); expect((await service.begin(job.id)).rawDigest).toBe(textDigest(raw.content)); await store.cancel(scope, job.id);
    const url = await store.admitUrl(scope, { operationId: randomUUID(), title: "Page", url: "https://example.com/approved?exact=1", parserRelease: "document-test-v1" });
    await pool.query("UPDATE agents_platform.ingestion_jobs SET acquisition_claimed_at=now(),state='acquiring' WHERE id=$1", [url.id]);
    await expect(service.acquire(url.id)).rejects.toMatchObject({ code: "SOURCE_ACQUISITION_UNCERTAIN" });
    expect((await store.list(scope)).every(source => source.visibility === "private")).toBe(true);
    expect(stableChunkId(job.revisionId, 2)).toBe(stableChunkId(job.revisionId, 2));
  });
});
