import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { ExecutorClient } from "../src/adapters/executors/executor-client";
import { routedSandbox, routedDocuments } from "../src/composition/routed-resources";
import { SandboxManager, sandboxAllocationId } from "../src/capabilities/sandbox/sandbox";
import { DocumentRuntime } from "../src/platform/knowledge/document-runtime";
import { IngestionService } from "../src/platform/knowledge/ingestion-runtime";
import { KnowledgeStore } from "../src/platform/knowledge/knowledge";
import type { PrivateObjectStore } from "../src/infrastructure/object-store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const enabled = process.env.AGENTS_TEST_DATABASE_URL && process.env.AGENTS_EXECUTOR_VERIFY === "1";
(enabled ? describe : describe.skip)("independent real gVisor resource executor ownership and worker recovery", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, directory: string, databaseUrl: string, clientA: ExecutorClient, clientB: ExecutorClient;
  const database = `agents_executor_process_${randomUUID().replaceAll("-", "")}`, processes = new Map<string, ChildProcess>(), environments = new Map<string, NodeJS.ProcessEnv>();
  const root = resolve(__dirname, "../../../.."), sandboxCache = join(homedir(), ".cache/kasitek-agents-sandbox"), documentCache = process.env.AGENTS_DOCUMENT_RUNTIME_CACHE || join(homedir(), ".cache/kasitek-documents");
  const routes: { id: string; url: string; key: string }[] = [], objects = new Map<string, Uint8Array>();
  const objectStore: PrivateObjectStore = { async put(key, value) { objects.set(key, Buffer.from(value)); }, async get(key) { const value = objects.get(key); if (!value) throw Error("Fixture object missing"); return value; }, async delete(key) { objects.delete(key); } };
  async function eventually(check: () => Promise<boolean>, timeout = 30_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error("Executor process fixture timed out"); }
  async function privateDocumentCache(id: string) {
    const target = join(directory, id, "documents"); await mkdir(target, { recursive: true });
    const current = JSON.parse(await readFile(join(documentCache, "current-profile.json"), "utf8")), hash = current.profileRelease.split("@")[1], sourceProfile = join(documentCache, "profiles", hash), destination = join(target, "profiles", hash);
    await mkdir(destination, { recursive: true }); await symlink(join(documentCache, "rootfs"), join(target, "rootfs"));
    for (const name of await readdir(sourceProfile)) if (name !== "manifest.json") await cp(join(sourceProfile,name),join(destination,name),{recursive:true,verbatimSymlinks:true,preserveTimestamps:true,mode:constants.COPYFILE_FICLONE});
    const manifest = JSON.parse(await readFile(join(sourceProfile, "manifest.json"), "utf8")); manifest.rootfs = manifest.rootfs.replace(documentCache, target);
    await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest)); await copyFile(join(documentCache, "current-profile.json"), join(target, "current-profile.json"));
    return target;
  }
  async function start(id: string) {
    const environment = environments.get(id)!;
    const child = spawn(process.execPath, ["--import", "tsx", resolve(root, "products/agents/api/src/composition/executor.ts")], { cwd: resolve(root, "products/agents/api"), env: environment, stdio: ["ignore", "ignore", "pipe"] });
    processes.set(id, child); let failed = false; child.once("exit", () => { failed = true; });
    await eventually(async () => { if (failed) throw new Error(`Owned executor ${id} exited`); try { const response = await fetch(routes.find(route => route.id === id)!.url); return response.status === 404; } catch { return false; } });
  }
  async function stop(id: string, signal: NodeJS.Signals = "SIGTERM") {
    const child = processes.get(id); if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal); await new Promise<void>(resolve => child.once("exit", () => resolve()));
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.AGENTS_TEST_DATABASE_URL!); url.pathname = `/${database}`; databaseUrl = url.href; pool = new Pool({ connectionString: databaseUrl, max: 8 }); await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    directory = await mkdtemp(join(tmpdir(), "agents-executor-process-"));
    for (const id of ["executor-a", "executor-b"]) {
      const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve)); const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
      const key = randomBytes(32).toString("hex"); routes.push({ id, key, url: `http://127.0.0.1:${port}` });
      const environment = { ...process.env, AGENTS_DATABASE_URL: databaseUrl, AGENTS_EXECUTOR_ID: id, AGENTS_EXECUTOR_KEY: key, AGENTS_EXECUTOR_PORT: String(port), AGENTS_EXECUTOR_HOST: "127.0.0.1", AGENTS_EXECUTOR_JOURNAL_DIRECTORY: join(directory, id, "commands"),
        AGENTS_SANDBOX_ENABLED: "1", AGENTS_SANDBOX_DIRECTORY: join(directory, id, "sandbox"), AGENTS_SANDBOX_RUNSC: join(sandboxCache, "gvisor/runsc"), AGENTS_SANDBOX_ROOTFS: join(sandboxCache, "python-rootfs"), AGENTS_DOCUMENT_RUNTIME_ENABLED: "1", AGENTS_DOCUMENT_RUNTIME_CACHE: await privateDocumentCache(id) };
      delete environment.OPENROUTER_API_KEY; environments.set(id, environment); await start(id);
    }
    clientA = new ExecutorClient(pool, routes, "executor-a"); clientB = new ExecutorClient(pool, routes, "executor-b");
    expect(await routedSandbox(clientA).available()).toBe(true); expect(await routedDocuments(clientA).available()).toBe(true);
  }, 120_000);
  afterAll(async () => {
    for (const id of processes.keys()) await stop(id);
    if (pool) {
      for (const allocation of (await pool.query("SELECT a.*,o.executor_id FROM agents_platform.sandbox_allocations a LEFT JOIN agents_platform.resource_executor_owners o ON o.allocation_id=a.id AND o.resource_kind='sandbox' WHERE a.state<>'destroyed'")).rows) {
        const environment = environments.get(allocation.executor_id || "executor-a")!;
        const manager = new SandboxManager(pool, { directory: environment.AGENTS_SANDBOX_DIRECTORY!, runsc: environment.AGENTS_SANDBOX_RUNSC!, rootfs: environment.AGENTS_SANDBOX_ROOTFS! });
        await manager.destroy({ organizationId: allocation.organization_id, rootTaskId: allocation.root_task_id, taskId: allocation.task_id, deadlineAt: new Date(allocation.lease_expires_at) }, allocation.id);
      }
      for (const allocation of (await pool.query("SELECT a.id,o.executor_id FROM agents_platform.document_allocations a LEFT JOIN agents_platform.resource_executor_owners o ON o.allocation_id=a.id AND o.resource_kind='document' WHERE a.state<>'destroyed'")).rows) await new DocumentRuntime({ cache: environments.get(allocation.executor_id || "executor-a")!.AGENTS_DOCUMENT_RUNTIME_CACHE! }).destroy(allocation.id);
      await pool.end();
    }
    if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } if (directory) await rm(directory, { recursive: true, force: true });
  }, 60_000);
  async function task() {
    const account = await platform.ensureAccount({ issuer: "https://executor.test", subject: randomUUID(), email: "fixture@executor.test", displayName: "Owner" }), organization = await platform.createOrganization(account.id, "Executor fixtures");
    const configuration = defaultBusinessConfiguration(); configuration.capabilities.sandbox = { enabled: true, profileId: "python-analysis-v1" }; configuration.tools = ["sandbox.analyze"];
    const agent = await platform.createAgent({ accountId: account.id, organizationId: organization.id, name: "Analysis", configuration }), version = await platform.createVersion({ accountId: account.id, organizationId: organization.id, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: organization.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = { ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read", "sandbox.execute", "artifact.read", "artifact.write"], maxInputBytes: 16384, maxOutputTokens: 1024, maxContextTokens: 8192, rootTokenLimit: 32000, expiresAt: new Date(Date.now() + 600_000).toISOString(), revokedAt: null };
    await platform.createGrant({ accountId: account.id, grant: grant as any }); const result = await platform.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input: "Analyze fixture input" });
    return { organizationId: organization.id, taskId: result.task.id, rootTaskId: result.task.id, deadlineAt: new Date(Date.now() + 600_000) };
  }
  it("recovers on worker B through original executor A after process loss, without reading B's local files or relaunching", async () => {
    const scope = await task(), input = { operationId: randomUUID(), code: "import time\ntime.sleep(3)\nopen('/scratch/output/recovered.txt','w').write('original executor receipt')", inputs: [] }, id = sandboxAllocationId(scope.taskId, input.operationId);
    const original = routedSandbox(clientA).analyze(scope, input).catch(error => error);
    await eventually(async () => (await pool.query("SELECT state FROM agents_platform.sandbox_allocations WHERE id=$1", [id])).rows[0]?.state === "running");
    await eventually(async()=>{try{await access(join(directory,"executor-a","sandbox",id,"started"));return true;}catch{return false;}});
    await stop("executor-a", "SIGKILL"); await original;
    await expect(routedSandbox(clientB).status(scope, id)).rejects.toMatchObject({ code: "EXECUTOR_COMMAND_UNCERTAIN" });
    await expect(access(join(directory, "executor-b", "sandbox", id))).rejects.toMatchObject({ code: "ENOENT" });
    await start("executor-a"); const recovered = await routedSandbox(clientB).analyze(scope, input);
    expect(recovered.state).toBe("completed"); expect(Buffer.from(recovered.exports[0]!.content).toString()).toBe("original executor receipt");
    expect((await pool.query("SELECT count(*) FROM agents_platform.sandbox_commands WHERE allocation_id=$1", [id])).rows[0].count).toBe("1");
    await routedSandbox(clientB).finalize(scope, id, [{ id: randomUUID(), name: "recovered.txt" }]);
    expect((await routedSandbox(clientB).status(scope, id)).state).toBe("destroyed");
    const old = await clientB.owner("sandbox", id), moved = await clientB.transfer("sandbox", id, "executor-b"); expect(moved.generation).toBe("2");
    for (const command of ["analyze", "status", "destroy"] as const) await expect(clientA.call(old, command, null)).rejects.toMatchObject({ code: "EXECUTOR_GENERATION_STALE" });
    expect((await routedSandbox(clientB).status(scope, id)).state).toBe("destroyed");
  }, 120_000);
  it("routes document parsing and cleanup from another worker to its physical owner, retaining the private receipt", async () => {
    const runtimeA = routedDocuments(clientA), runtimeB = routedDocuments(clientB), release = (await runtimeA.profile()).profileRelease;
    const account = await platform.ensureAccount({ issuer: "https://document-executor.test", subject: randomUUID(), email: "document@executor.test", displayName: "Owner" }), scope = { accountId: account.id, organizationId: (await platform.createOrganization(account.id, "Document executor")).id };
    const knowledge = new KnowledgeStore(pool, objectStore), job = await knowledge.admitUpload(scope, { operationId: randomUUID(), title: "Private fixture", parserRelease: release, contentType: "text/plain", content: Buffer.from("Executor-owned evidence") });
    const serviceA = new IngestionService(pool, objectStore, runtimeA, knowledge), serviceB = new IngestionService(pool, objectStore, runtimeB, knowledge); await serviceA.begin(job.id);
    const receipt = await serviceA.stage(job.id, "parse", { kind: "parse", format: "text", content: Buffer.from("Executor-owned evidence") }, release);
    expect((await clientB.owner("document", receipt.allocationId)).executor_id).toBe("executor-a");
    expect((await serviceB.read(receipt)).kind).toBe("parse"); await expect(access(join(environments.get("executor-b")!.AGENTS_DOCUMENT_RUNTIME_CACHE!, "resources", receipt.allocationId))).rejects.toMatchObject({ code: "ENOENT" });
    await serviceB.cleanup(receipt.allocationId); expect((await runtimeB.status(receipt.allocationId)).state).toBe("destroyed");
    expect((await serviceB.stage(job.id, "parse", { kind: "parse", format: "text", content: Buffer.from("Executor-owned evidence") }, release))).toEqual(receipt);
    const old = await clientA.owner("document", receipt.allocationId); await clientB.transfer("document", receipt.allocationId, "executor-b");
    for (const command of ["start", "status", "destroy"] as const) await expect(clientA.call(old, command, null)).rejects.toMatchObject({ code: "EXECUTOR_GENERATION_STALE" });
  }, 120_000);
  it("reaps an expired pre-admission launch intent only after the original physical host confirms absence", async () => {
    const id = randomUUID(), owner = await clientA.claim("sandbox", id, { fixture: "crashed-before-native-admission" }, new Date(Date.now() + 60_000));
    await clientA.owners.claimStart(owner, 2);
    await pool.query("UPDATE agents_platform.resource_executor_owners SET lease_expires_at=now()-interval '1 second' WHERE allocation_id=$1", [id]);
    expect((await pool.query("SELECT 1 FROM agents_platform.sandbox_allocations WHERE id=$1", [id])).rowCount).toBe(0);
    await stop("executor-a", "SIGKILL");
    await expect(routedSandbox(clientB).reap()).rejects.toMatchObject({ code: "SANDBOX_CLEANUP_PENDING" });
    expect(await clientB.owner("sandbox", id)).toMatchObject({ executor_id: "executor-a", generation: "1", quiescent: false });
    await expect(access(join(directory, "executor-b", "sandbox", id))).rejects.toMatchObject({ code: "ENOENT" });
    await start("executor-a"); expect(await routedSandbox(clientB).reap()).toBe(1);
    expect(await clientB.owner("sandbox", id)).toMatchObject({ executor_id: "executor-a", generation: "1", quiescent: true });
    expect(await routedSandbox(clientB).reap()).toBe(0);
  }, 60_000);

});
