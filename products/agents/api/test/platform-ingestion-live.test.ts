import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3PrivateStore } from "../src/platform/artifacts";
import { DocumentRuntime } from "../src/platform/document-runtime";
import { KnowledgeStore, type KnowledgeScope } from "../src/platform/knowledge";
import { PlatformStore } from "../src/platform/store";
import { setupPlatformSchema } from "../src/platform/setup";
import { privateFixtureBucketRequest } from "./support/private-s3-fixture";

const enabled = process.env.AGENTS_INGESTION_LIVE === "1" && process.env.AGENTS_TEST_DATABASE_URL;
(enabled ? describe : describe.skip)("actual compiled ingestion worker with Restate, gVisor, private S3 and pgvector", () => {
  const suffix = randomUUID().replaceAll("-", ""), database = `agents_ingestion_live_${suffix}`, container = `agents-ingestion-live-${suffix}`;
  const s3 = { endpoint: "http://127.0.0.1:19000", region: "us-east-1", bucket: `agents-ingestion-${suffix}`,
    accessKeyId: "connected-fixture-user", secretAccessKey: "connected-fixture-secret", maxBytes: 10485760 };
  const cache = process.env.AGENTS_DOCUMENT_RUNTIME_CACHE ?? join(homedir(), ".cache/kasitek-documents"), runtime = new DocumentRuntime({ cache });
  let admin: Pool, pool: Pool, knowledge: KnowledgeStore, platform: PlatformStore, objects: S3PrivateStore;
  let scope: KnowledgeScope, profileRelease: string, ingress: string, adminUrl: string, workerPort: number, worker: ChildProcess | undefined;
  let startedContainer = false, createdBucket = false, databaseUrl = "", logs = "";
  const evidence: Record<string, unknown> = { kind: "actual-compiled-ingestion", modelCalls: 0, cases: [] };
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
  async function eventually<T>(check: () => Promise<T | false>, label: string, timeout = 90000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await check(); if (value !== false) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(`Timed out: ${label}`);
  }
  async function startWorker() {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", AGENTS_DATABASE_URL: databaseUrl,
      RESTATE_WORKER_PORT: String(workerPort), RESTATE_WORKER_HOST: "0.0.0.0", AGENTS_ALLOW_UNSIGNED_WORKER: "1", RESTATE_INGRESS_URL: ingress, RESTATE_ADMIN_URL: adminUrl,
      AGENTS_DOCUMENT_RUNTIME_ENABLED: "1", AGENTS_DOCUMENT_RUNTIME_CACHE: cache, AGENTS_S3_ENDPOINT: s3.endpoint, AGENTS_S3_REGION: s3.region,
      AGENTS_S3_BUCKET: s3.bucket, AGENTS_S3_ACCESS_KEY_ID: s3.accessKeyId, AGENTS_S3_SECRET_ACCESS_KEY: s3.secretAccessKey };
    delete env.OPENROUTER_API_KEY; delete env.AGENTS_REPORT_DELIVERY_TARGETS; delete env.AGENTS_CONNECTION_KEYS; delete env.AGENTS_CONNECTION_ACTIVE_KEY;
    delete env.AGENTS_SANDBOX_ENABLED; delete env.RESTATE_REQUEST_IDENTITY_KEYS;
    let ready = false;
    worker = spawn(process.execPath, ["dist/platform/worker.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    for (const output of [worker.stdout, worker.stderr]) output!.on("data", value => { logs = (logs + value.toString()).slice(-262144); if (value.toString().includes('"event":"ready"')) ready = true; });
    await eventually(async () => { if (worker?.exitCode !== null) throw new Error("Compiled worker exited before readiness"); return ready; }, "compiled worker readiness", 20000);
  }
  async function killWorker(signal: NodeJS.Signals = "SIGKILL") {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = once(worker, "exit"); worker.kill(signal); await exited;
  }
  beforeAll(async () => {
    expect(await runtime.available(), "Real document runtime must already be prepared").toBe(true); profileRelease = (await runtime.profile()).profileRelease;
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.AGENTS_TEST_DATABASE_URL!); url.pathname = `/${database}`; databaseUrl = url.href;
    pool = new Pool({ connectionString: databaseUrl, max: 10 }); await setupPlatformSchema(pool);
    const created = await privateFixtureBucketRequest(s3, "PUT"); expect(created.ok).toBe(true); createdBucket = true;
    objects = new S3PrivateStore(s3); knowledge = new KnowledgeStore(pool, objects); platform = new PlatformStore(pool);
    const account = await platform.ensureAccount({ issuer: "http://localhost/ingestion-live", subject: suffix, email: "owner@example.test", displayName: "Owner" });
    scope = { accountId: account.id, organizationId: (await platform.createOrganization(account.id, "Ingestion acceptance")).id };
    const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "0.0.0.0", resolve)); workerPort = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
    docker("run", "-d", "--name", container, "--cpus", "2", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13");
    startedContainer = true; ingress = `http://${docker("port", container, "8080/tcp")}`; adminUrl = `http://${docker("port", container, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${adminUrl}/health`)).ok; } catch { return false; } }, "owned Restate health", 30000);
    await startWorker();
    const registration = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${workerPort}`, force: false }) });
    expect(registration.ok, await registration.text()).toBe(true);
    evidence.profileRelease = profileRelease;
  }, 60000);
  afterAll(async () => {
    await killWorker();
    if (pool) {
      const allocations = (await pool.query("SELECT id FROM agents_platform.document_allocations")).rows;
      for (const allocation of allocations) await runtime.destroy(allocation.id);
    }
    if (startedContainer) docker("rm", "-f", container);
    if (createdBucket) {
      const response = await privateFixtureBucketRequest(s3, "GET", "list-type=2");
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) await objects.delete(match[1]!);
      expect((await privateFixtureBucketRequest(s3, "DELETE")).ok).toBe(true);
    }
    await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
    const directory = resolve(process.cwd(), "../../../.audit"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "agents-ingestion-live.json"), JSON.stringify(evidence, null, 2));
    await writeFile(join(directory, "agents-ingestion-live-worker.log"), logs);
  }, 60000);
  async function upload(contentType: string, content: Buffer, title: string, operationId = randomUUID()) {
    return knowledge.admitUpload(scope, { operationId, title, contentType, content, parserRelease: profileRelease, embeddingRelease: profileRelease });
  }
  async function ready(jobId: string) {
    return eventually(async () => { const job = await knowledge.getJob(scope, jobId); if (job.state === "failed" || job.state === "cancelled") throw new Error(`Actual import ended ${job.state}: ${job.errorCode}`); return job.state === "ready" ? job : false; }, `sealed import ${jobId}`, 180000);
  }
  async function inspect(jobId: string) {
    const job = await ready(jobId), source = (await knowledge.list(scope)).find(source => source.id === job.sourceId)!;
    expect(source.visibility).toBe("private"); expect(source.revisions.find(revision => revision.id === job.revisionId)?.state).toBe("candidate");
    const preview = await knowledge.preview(scope, job.sourceId, job.revisionId);
    const allocationRows = (await pool.query("SELECT id,stage,stage_index,state,receipt,result_digest FROM agents_platform.document_allocations WHERE job_id=$1 ORDER BY stage,stage_index", [jobId])).rows;
    expect(allocationRows.every(row => row.state === "destroyed" && row.result_digest && row.receipt)).toBe(true);
    for (const row of allocationRows) { expect(row.receipt.durationMs).toBeGreaterThanOrEqual(0); expect(row.receipt.memoryPeakBytes).toBeLessThanOrEqual(536870912); }
    const vectors = Number((await pool.query("SELECT count(*) FROM agents_platform.chunk_embeddings e JOIN agents_platform.source_chunks c ON c.id=e.chunk_id WHERE c.revision_id=$1", [job.revisionId])).rows[0].count);
    expect(vectors).toBe(preview.chunks.length);
    await knowledge.setPolicy(scope, source.id, { operationId: randomUUID(), expectedGeneration: source.generation, action: "approve", revisionId: job.revisionId });
    expect((await knowledge.list(scope)).find(item => item.id === source.id)!.revisions[0]!.state).toBe("approved");
    (evidence.cases as unknown[]).push({ title: source.title, jobId, revisionId: job.revisionId, chunks: preview.chunks.length, vectors, allocationRows });
    return { job, preview, allocationRows };
  }
  it("imports private text and Markdown through the compiled worker and preserves exact duplicate admission", async () => {
    const content = Buffer.from("Café 😀\r\nBookings require the public code MINT-420.\n"), operationId = randomUUID();
    const [a, b] = await Promise.all([upload("text/plain", content, "Text evidence", operationId), upload("text/plain", content, "Text evidence", operationId)]);
    expect(a.id).toBe(b.id); const text = await inspect(a.id); expect(text.preview.text).toContain("Café 😀\nBookings");
    expect((await pool.query("SELECT count(*) FROM agents_platform.source_revisions WHERE id=$1", [a.revisionId])).rows[0].count).toBe("1");
    const raw = (await pool.query("SELECT raw_key FROM agents_platform.ingestion_jobs WHERE id=$1", [a.id])).rows[0].raw_key;
    expect((await fetch(`${s3.endpoint}/${s3.bucket}/${raw}`)).status).toBe(403);
    const markdown = await upload("text/markdown", Buffer.from("# Public policy\n\nResearch follows the approval code MAPLE-631.\n"), "Markdown evidence");
    expect((await inspect(markdown.id)).preview.text).toContain("MAPLE-631");
  }, 180000);
  it("keeps decisive tail-page PDF evidence with page and UTF16 source spans", async () => {
    const job = await upload("application/pdf", pdf(["Introduction to the public research policy.", "General information is on this page.", "The final-page approval code is QUARTZ-7399."]), "Three-page policy");
    const result = await inspect(job.id), chunk = result.preview.chunks.find(chunk => chunk.text.includes("QUARTZ-7399"));
    expect(chunk?.page).toBe(3); expect(result.preview.text.slice(chunk!.start, chunk!.end)).toBe(chunk!.text);
  }, 180000);
  it.each(["parse", "embed"] as const)("survives actual SIGKILL during %s, preserving allocation IDs and one sealed publication", async stage => {
    const job = await upload("text/plain", Buffer.from("The recovery evidence code is PINE-947.\n".repeat(8)), `Worker recovery during ${stage}`);
    const allocation = await eventually(async () => { const row = (await pool.query("SELECT id,state FROM agents_platform.document_allocations WHERE job_id=$1 AND stage=$2", [job.id, stage])).rows[0]; return row?.state === "running" ? row : false; }, `${stage} physically launched`, 30000);
    await killWorker(); const physical = await runtime.status(allocation.id); expect(["running", "completed"]).toContain(physical.state);
    await startWorker(); const result = await inspect(job.id);
    expect(result.allocationRows.filter(row => row.stage === stage).map(row => row.id)).toEqual([allocation.id]);
    expect(result.allocationRows).toHaveLength(3);
    expect((await pool.query("SELECT count(*) FROM agents_platform.source_revisions WHERE id=$1", [job.revisionId])).rows[0].count).toBe("1");
    const before = JSON.stringify(result.allocationRows);
    await fetch(`${ingress}/restate/send/AgentsKnowledgeImportV1/${job.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id }) });
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = (await pool.query("SELECT id,stage,stage_index,state,receipt,result_digest FROM agents_platform.document_allocations WHERE job_id=$1 ORDER BY stage,stage_index", [job.id])).rows;
    expect(JSON.stringify(after)).toBe(before);
  }, 180000);
  it("acquires an exact approved public static page before isolated extraction", async () => {
    const job = await knowledge.admitUrl(scope, { operationId: randomUUID(), title: "Public static page", url: "https://example.com/", parserRelease: profileRelease, embeddingRelease: profileRelease });
    expect((await inspect(job.id)).preview.text).toContain("documentation examples");
    const receipt = (await pool.query("SELECT acquisition_receipt FROM agents_platform.ingestion_jobs WHERE id=$1", [job.id])).rows[0].acquisition_receipt;
    expect(receipt.finalUrl).toBe("https://example.com/"); expect(receipt.attempts.length).toBeGreaterThan(0);
  }, 180000);
});

function pdf(pages: string[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`], font = 3 + pages.length * 2;
  for (const [index, text] of pages.entries()) {
    const content = `BT /F1 12 Tf 40 750 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); let body = "%PDF-1.4\n"; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}
