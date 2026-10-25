import {dropClosedTestDatabase} from "./support/database-cleanup";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {ArtifactStore} from "../src/execution/artifacts/artifacts";
import {S3PrivateStore, privateStoreFromEnvironment} from "../src/infrastructure/object-store";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";

const dbUrl = process.env.AGENTS_TEST_DATABASE_URL, endpoint = process.env.AGENTS_TEST_S3_ENDPOINT;
const suite = dbUrl && endpoint ? describe : describe.skip;
suite("private S3-compatible content with real PostgreSQL metadata", () => {
  let pool: Pool, admin: Pool, platform: PlatformStore, objects: S3PrivateStore, artifacts: ArtifactStore;
  const database = `agents_artifacts_${randomUUID().replaceAll("-", "")}`, bucket = `agents-test-${randomUUID()}`;
  const accessKeyId = process.env.AGENTS_TEST_S3_ACCESS_KEY_ID ?? "memory-fixture-user", secretAccessKey = process.env.AGENTS_TEST_S3_SECRET_ACCESS_KEY ?? "memory-fixture-secret";
  beforeAll(async () => {
    admin = new Pool({ connectionString: dbUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(dbUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    for (const file of (await readdir(resolve(__dirname, "../schema"))).filter(file => file.endsWith(".sql")).sort()) await pool.query(await readFile(resolve(__dirname, "../schema", file), "utf8"));
    platform = new PlatformStore(pool);
    const base = new URL(endpoint!), date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8), path = `/${bucket}`, hash = createHash("sha256").update("").digest("hex");
    const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
    const scope = `${day}/us-east-1/s3/aws4_request`, canonical = ["PUT", path, "", `host:${base.host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n`, "host;x-amz-content-sha256;x-amz-date", hash].join("\n");
    const signature = createHmac("sha256", hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`,day),"us-east-1"),"s3"),"aws4_request")).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`).digest("hex");
    const response = await fetch(new URL(path,base), { method: "PUT", headers: { "x-amz-date": date, "x-amz-content-sha256": hash, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}` } });
    if (!response.ok) throw new Error(`S3 bucket setup failed (${response.status})`);
    objects = new S3PrivateStore({ endpoint: endpoint!, region: "us-east-1", bucket, accessKeyId, secretAccessKey }); artifacts = new ArtifactStore(pool, objects);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "http://localhost:8080/realms/artifacts", subject: randomUUID(), email: "artifact@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Artifact tests");
    const agent = await platform.createAgent({ accountId: account.id, organizationId: organization.id, name: "Report", configuration: defaultBusinessConfiguration() });
    return { accountId: account.id, organizationId: organization.id, agentId: agent.id };
  }
  it("signs actual PUT/GET/DELETE and scopes immutable verified content", async () => {
    const scope = await fixture(), other = await fixture(), input = { operationId: randomUUID(), contentType: "text/markdown", content: Buffer.from("# Private report\nVerified source.") };
    const created = await artifacts.put(scope, input); expect(created.state).toBe("available");
    expect((await artifacts.put(scope,input)).id).toBe(created.id);
    expect(Buffer.from((await artifacts.get(scope,created.id)).content).toString()).toBe(input.content.toString());
    expect((await artifacts.list(scope)).map(value => value.id)).toContain(created.id);
    await expect(artifacts.get(other,created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(artifacts.put(scope,{ ...input, content: Buffer.from("different") })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const key = (await pool.query("SELECT object_key FROM agents_platform.artifacts WHERE id=$1",[created.id])).rows[0].object_key;
    const anonymous = await fetch(new URL(`/${bucket}/${key}`, endpoint)); expect(anonymous.status).toBe(403);
    await artifacts.forget(scope,created.id);
    await expect(artifacts.get(scope,created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(objects.get(key)).rejects.toMatchObject({ code: "ARTIFACT_CONTENT_MISSING" });
    await expect(artifacts.put(scope,input)).rejects.toMatchObject({ code: "ARTIFACT_DELETED" });
  });
  it("recovers lost PUT receipts under the same key and rejects corrupted objects", async () => {
    const scope = await fixture(), input = { operationId: randomUUID(), contentType: "text/plain", content: Buffer.from("Stable operation content") };
    let first = true;
    const interrupted = new ArtifactStore(pool, { get: key => objects.get(key), delete: key => objects.delete(key), put: async (key,content,type) => { await objects.put(key,content,type); if (first) { first=false; throw new Error("simulated response loss after real S3 acceptance"); } } });
    await expect(interrupted.put(scope,input)).rejects.toThrow("simulated response loss");
    const result = await artifacts.put(scope,input);
    expect((await pool.query("SELECT count(*) FROM agents_platform.artifacts WHERE operation_id=$1",[input.operationId])).rows[0].count).toBe("1");
    const key = (await pool.query("SELECT object_key FROM agents_platform.artifacts WHERE id=$1",[result.id])).rows[0].object_key;
    await objects.put(key,Buffer.from("corruption"),"text/plain");
    await expect(artifacts.get(scope,result.id)).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY" });
    await artifacts.forget(scope,result.id);
  });
  it("cleans an allocation when deletion races an in-flight PUT", async () => {
    const scope = await fixture(), operationId=randomUUID();
    let entered!:()=>void, release!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
    const releasedPromise=new Promise<void>(resolve=>{release=resolve;});
    const racing=new ArtifactStore(pool,{get:key=>objects.get(key),delete:key=>objects.delete(key),put:async(key,content,type)=>{await objects.put(key,content,type);entered();await releasedPromise;}});
    const writing=racing.put(scope,{operationId,contentType:"text/plain",content:Buffer.from("racing output")});
    const rejected=expect(writing).rejects.toMatchObject({code:"ARTIFACT_DELETED"});
    await enteredPromise;
    const row=(await pool.query("SELECT id,object_key FROM agents_platform.artifacts WHERE operation_id=$1",[operationId])).rows[0];
    await artifacts.forget(scope,row.id);release();await rejected;
    await expect(objects.get(row.object_key)).rejects.toMatchObject({code:"ARTIFACT_CONTENT_MISSING"});
  });
  it("denies revoked access and has no filesystem fallback", async () => {
    const scope = await fixture();
    await expect(new ArtifactStore(pool).put(scope,{ operationId:randomUUID(),contentType:"text/plain",content:Buffer.from("unavailable") })).rejects.toMatchObject({ code:"OBJECT_STORE_UNAVAILABLE" });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[scope.organizationId,scope.accountId]);
    await expect(artifacts.list(scope)).rejects.toMatchObject({ code:"ACCESS_DENIED" });
    expect(privateStoreFromEnvironment({})).toBeUndefined();
    expect(() => privateStoreFromEnvironment({ AGENTS_S3_ENDPOINT:endpoint })).toThrow("incomplete");
    await expect(objects.put("../forbidden",Buffer.from("x"),"text/plain")).rejects.toMatchObject({ code:"ARTIFACT_KEY_INVALID" });
  });
});
