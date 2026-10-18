import {dropClosedTestDatabase} from "./support/database-cleanup";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeStore, type KnowledgeScope } from "../src/platform/knowledge";
import { PlatformStore } from "../src/platform/store";
import { setupPlatformSchema } from "../src/platform/setup";
import { textDigest, type IngestionJob } from "../src/platform/source-contracts";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("knowledge lifecycle with real PostgreSQL and fixture private objects", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, store: KnowledgeStore;
  const database = `agents_knowledge_${randomUUID().replaceAll("-", "")}`, objects = new Map<string, Uint8Array>();
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    store = new KnowledgeStore(pool, { async get(key) { const value = objects.get(key); if (!value) throw Error("Fixture object missing"); return value; },
      async put(key, content) { objects.set(key, Buffer.from(content)); }, async delete(key) { objects.delete(key); } });
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); } });
  async function fixture(): Promise<KnowledgeScope> {
    const account = await platform.ensureAccount({ issuer: "http://localhost:8080/realms/knowledge", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Knowledge");
    return { accountId: account.id, organizationId: organization.id };
  }
  const upload = () => ({ operationId: randomUUID(), title: "Guide", contentType: "text/markdown", content: Buffer.from("Decisive tail passage 🧪"), parserRelease: "document-v1" });
  function extraction(job: IngestionJob, text = "Decisive tail passage 🧪") {
    return { text, acquiredAt: "2026-10-17T00:00:00Z", normalizerRelease: "text-v1", chunks: [{ id: randomUUID(), revisionId: job.revisionId,
      ordinal: 0, start: 0, end: text.length, page: null, section: null, text, digest: textDigest(text), tokens: 12 }] };
  }
  async function start(job: IngestionJob) { await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1", [job.id]); }

  it("admits idempotently, seals complete immutable candidates, and requires owner approval", async () => {
    const scope = await fixture(), input = upload(), job = await store.admitUpload(scope, input);
    expect((await store.admitUpload(scope, input)).id).toBe(job.id);
    await expect(store.admitUpload(scope, { ...input, content: Buffer.from("changed") })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await pool.query("SELECT count(*) FROM agents_platform.ingestion_outbox WHERE job_id=$1", [job.id])).rows[0].count).toBe("1");
    expect((await store.list(scope))[0]?.visibility).toBe("private");
    const output = extraction(job); await start(job); await store.publishExtraction(job.id, output); await store.publishExtraction(job.id, output);
    expect((await store.list(scope))[0]?.revisions[0]?.state).toBe("candidate");
    const policy = { operationId: randomUUID(), expectedGeneration: 1, action: "approve" as const, revisionId: job.revisionId };
    await store.setPolicy(scope, job.sourceId, policy); await store.setPolicy(scope, job.sourceId, policy);
    expect((await store.list(scope))[0]?.revisions[0]?.state).toBe("approved");
    await expect(pool.query("UPDATE agents_platform.source_revisions SET text_digest=$2 WHERE id=$1", [job.revisionId, "0".repeat(64)])).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM agents_platform.source_chunks WHERE revision_id=$1", [job.revisionId])).rejects.toThrow("immutable");
    await expect(store.publishExtraction(job.id, extraction(job, "forged replay"))).rejects.toMatchObject({ code: "EXTRACTION_INTEGRITY" });
    const textKey = (await pool.query("SELECT text_key FROM agents_platform.source_revisions WHERE id=$1", [job.revisionId])).rows[0].text_key;
    expect(Buffer.from(objects.get(textKey)!).toString()).toBe(output.text);
  });

  it("rejects private candidate disclosure and publication by another member or tenant", async () => {
    const owner = await fixture(), member = await fixture(), outsider = await fixture();
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [owner.organizationId, member.accountId]);
    const memberScope = { ...owner, accountId: member.accountId }, job = await store.admitUpload(memberScope, upload());
    const ownerJob = await store.admitUpload(owner, upload());
    expect((await store.list(memberScope)).map(row => row.id)).toEqual([job.sourceId]);
    await expect(store.getJob(memberScope, ownerJob.id)).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    await expect(store.getJob(outsider, job.id)).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    await start(job); await store.publishExtraction(job.id, extraction(job));
    await expect(store.setPolicy(memberScope, job.sourceId, { operationId: randomUUID(), expectedGeneration: 1, action: "approve", revisionId: job.revisionId })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(store.cancel(memberScope, ownerJob.id)).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  it("prevents cancelled or withdrawn work from producing visible revisions", async () => {
    const scope = await fixture(), job = await store.admitUpload(scope, upload());
    await start(job); await store.cancel(scope, job.id);
    await expect(store.publishExtraction(job.id, extraction(job))).rejects.toMatchObject({ code: "INGESTION_INVALIDATED" });
    const second = await store.admitUpload(scope, upload()); await start(second);
    await store.setPolicy(scope, second.sourceId, { operationId: randomUUID(), expectedGeneration: 1, action: "withdraw" });
    await expect(store.publishExtraction(second.id, extraction(second))).rejects.toMatchObject({ code: "INGESTION_INVALIDATED" });
    expect((await pool.query("SELECT count(*) FROM agents_platform.source_revisions WHERE source_id=ANY($1::uuid[])", [[job.sourceId, second.sourceId]])).rows[0].count).toBe("0");
    expect((await store.getJob(scope, second.id)).state).toBe("cancelled");
  });

  it("bounds concurrent imports and refuses stale visibility changes", async () => {
    const scope = await fixture(), jobs = await Promise.all([store.admitUpload(scope, upload()), store.admitUpload(scope, upload())]);
    await expect(store.admitUpload(scope, upload())).rejects.toMatchObject({ code: "IMPORT_CONCURRENCY_LIMIT" });
    await store.cancel(scope, jobs[0]!.id); await store.admitUpload(scope, upload());
    await store.setPolicy(scope, jobs[1]!.sourceId, { operationId: randomUUID(), expectedGeneration: 1, action: "visibility", visibility: "public" });
    await expect(store.setPolicy(scope, jobs[1]!.sourceId, { operationId: randomUUID(), expectedGeneration: 1, action: "visibility", visibility: "private" })).rejects.toMatchObject({ code: "SOURCE_POLICY_CONFLICT" });
    await start(jobs[1]!);
    await expect(store.publishExtraction(jobs[1]!.id, extraction(jobs[1]!))).rejects.toMatchObject({ code: "INGESTION_INVALIDATED" });
  });
});
