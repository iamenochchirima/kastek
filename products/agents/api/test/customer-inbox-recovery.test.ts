import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer as reservePort } from "node:net";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const enabled = process.env.AGENTS_TEST_DATABASE_URL && process.env.AGENTS_INBOX_RECOVERY === "1";
(enabled ? describe : describe.skip)("actual grounded website ownership across worker SIGKILL, queued roots and restart", () => {
  let admin: Pool, pool: Pool, app: Awaited<ReturnType<typeof buildPlatformApp>>, model: ReturnType<typeof httpServer>, worker: ChildProcess | undefined;
  let apiOrigin = "", modelUrl = "", databaseUrl = "", workerPort = 0, ingress = "", runtimeAdmin = "", started = false;
  let modelCalls = 0, releaseFirst: (() => void) | undefined;
  const database = `agents_channel_recovery_${randomUUID().replaceAll("-", "")}`, container = `agents-channel-recovery-${randomUUID()}`, requests: any[] = [], workerPids: number[] = [];
  const root = resolve(__dirname, "../../../.."), shop = "https://owned-shop.fixture.test";
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
  async function freePort() { const server = reservePort(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
  async function eventually(check: () => Promise<boolean>, timeout = 30_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Owned channel recovery checkpoint timed out"); }
  async function startWorker() {
    worker = spawn(process.execPath, ["--import", "tsx", resolve(__dirname, "customer-inbox-recovery-worker.ts")], { cwd: resolve(root, "products/agents/api"), env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OTEL_SDK_DISABLED: "true", AGENTS_DATABASE_URL: databaseUrl, CHANNEL_RECOVERY_MODEL_URL: modelUrl, CHANNEL_RECOVERY_ORIGIN: apiOrigin, CHANNEL_RECOVERY_PORT: String(workerPort) }, stdio: ["ignore", "pipe", "pipe"] });
    const owned = worker; let output = "", failed = false; owned.stdout!.on("data", chunk => { output = (output + String(chunk)).slice(-8000); }); owned.stderr!.on("data", () => undefined); owned.once("exit", () => { failed = true; });
    await eventually(async () => { if (failed) throw new Error("Owned recovery worker exited during startup"); return output.includes("CHANNEL_RECOVERY_WORKER_READY"); }); workerPids.push(owned.pid!);
  }
  async function stopWorker(signal: NodeJS.Signals = "SIGTERM") { const owned = worker; if (!owned || owned.exitCode !== null || owned.signalCode !== null) return; owned.kill(signal); await new Promise<void>(resolve => owned.once("exit", () => resolve())); }
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.AGENTS_TEST_DATABASE_URL!); url.pathname = `/${database}`; databaseUrl = url.href; pool = new Pool({ connectionString: databaseUrl, max: 12 }); await setupPlatformSchema(pool);
    model = httpServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(JSON.parse(Buffer.concat(chunks).toString())); modelCalls++;
      if (modelCalls === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: `controlled-${modelCalls}`, choices: [{ finish_reason: "stop", message: { role: "assistant", content: modelCalls === 1 ? "LATE BEFORE WORKER LOSS" : "Automation resumed after verified human support." } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
    }); await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve)); modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
    const apiPort = await freePort(); workerPort = await freePort(); apiOrigin = `http://127.0.0.1:${apiPort}`;
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: databaseUrl, AGENTS_PUBLIC_URL: apiOrigin, AGENTS_OIDC_ISSUER_URL: "https://recovery-identity.fixture.test", AGENTS_OIDC_CLIENT_SECRET: "isolated-channel-recovery-fixture-secret", OPENROUTER_API_KEY: "controlled-local-provider-fixture" });
    app = await buildPlatformApp({ config, pool, logging: false }); await app.listen({ host: "127.0.0.1", port: apiPort }); await startWorker();
    docker("run", "-d", "--name", container, "--cpus", "1", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742"); started = true;
    ingress = `http://${docker("port", container, "8080/tcp")}`; runtimeAdmin = `http://${docker("port", container, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${runtimeAdmin}/health`)).ok; } catch { return false; } });
    const registered = await fetch(`${runtimeAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${workerPort}`, force: false }) }); expect(registered.ok, await registered.text()).toBe(true);
  }, 90_000);
  afterAll(async () => { releaseFirst?.(); await stopWorker(); if (started) docker("rm", "-f", container); await app?.close(); if (model) await new Promise<void>(resolve => model.close(() => resolve())); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } }, 30_000);
  it("recovers original root identity and channel control without replaying queued/human-owned input or duplicating provider work", async () => {
    const store = new PlatformStore(pool), account = await store.ensureAccount({ issuer: "https://recovery-identity.fixture.test", subject: randomUUID(), email: "operator@recovery.test", displayName: "Support operator" }), organization = await store.createOrganization(account.id, "Worker recovery fixture");
    const configuration = defaultBusinessConfiguration(); configuration.program = { id: "grounded-conversation", version: "1" }; configuration.tools = [];
    const scope = { accountId: account.id, organizationId: organization.id }, agent = await store.createAgent({ ...scope, name: "Grounded website", configuration }), version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 }), deployment = await store.publishWebsite({ ...scope, agentId: agent.id, versionId: version.id, allowedOrigins: [shop] });
    const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
    const staffHeaders = { cookie: `agents_session=${session.token}`, origin: apiOrigin, "content-type": "application/json" }, publicBase = `${apiOrigin}/api/website/${deployment.id}`;
    const opened = await fetch(`${publicBase}/session`, { method: "POST", headers: { origin: shop, "content-type": "application/json" }, body: "{}" }); expect(opened.ok).toBe(true);
    const { token } = await opened.json() as { token: string }, visitorHeaders = { authorization: `Bearer ${token}`, origin: shop, "content-type": "application/json" };
    const conversationResponse = await fetch(`${publicBase}/customer-conversations`, { method: "POST", headers: visitorHeaders, body: "{}" }); expect(conversationResponse.ok).toBe(true);
    const conversation = (await conversationResponse.json() as { conversation: { id: string } }).conversation, messages = `${publicBase}/customer-conversations/${conversation.id}/messages`, staffPath = `${apiOrigin}/api/organizations/${organization.id}/inbox/${conversation.id}`;
    async function send(body: string) { const response = await fetch(messages, { method: "POST", headers: visitorHeaders, body: JSON.stringify({ requestKey: randomUUID(), body }) }); expect(response.ok, await response.clone().text()).toBe(true); return (await response.json() as any).message; }
    async function command(action: string, body?: string) { const read = await fetch(staffPath, { headers: staffHeaders }); expect(read.ok).toBe(true); const revision = (await read.json() as any).conversation.revision;
      const response = await fetch(`${staffPath}/commands`, { method: "POST", headers: staffHeaders, body: JSON.stringify({ commandId: randomUUID(), expectedRevision: revision, action, ...(body ? { body } : {}) }) }); expect(response.ok, await response.clone().text()).toBe(true);
    }
    const firstMessage = await send("Question before worker loss"); await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: runtimeAdmin }); await eventually(async () => modelCalls === 1);
    const first = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=(SELECT task_id FROM agents_platform.customer_messages WHERE id=$1)", [firstMessage.id])).rows[0]; expect(first.runtime_invocation_id).toMatch(/^inv_/);
    const queuedMessage = await send("Queued before takeover"); const queued = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=(SELECT task_id FROM agents_platform.customer_messages WHERE id=$1)", [queuedMessage.id])).rows[0]; expect(queued.runtime_invocation_id).toBeNull();
    await stopWorker("SIGKILL"); await command("claim"); await command("takeover"); await command("reply", "A person handled the account request.");
    await send("Human-owned backlog must remain context, not a new automatic task");
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks")).rows[0].n).toBe(2); expect(modelCalls).toBe(1);
    releaseFirst?.(); await startWorker(); expect(workerPids).toHaveLength(2); expect(workerPids[1]).not.toBe(workerPids[0]);
    try { await eventually(async () => { await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: runtimeAdmin }); return (await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE id=ANY($1::uuid[]) AND state IN ('completed','incomplete','refused','failed','cancelled','uncertain')", [[first.id, queued.id]])).rows[0].n === 2; }); }
    catch (error) { console.error("Recovery diagnostics", { tasks:(await pool.query("SELECT id,state,error_code,runtime_invocation_id FROM agents_platform.tasks")).rows, operations:(await pool.query("SELECT state,kind FROM agents_platform.operations")).rows, cancellations:(await pool.query("SELECT completed_at FROM agents_platform.customer_cancellations")).rows, output: await (await fetch(`${ingress}/restate/output/${first.runtime_invocation_id}`)).text(), modelCalls }); throw error; }
    expect(modelCalls).toBe(1); const recovered = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [first.id])).rows[0]; expect(recovered.runtime_invocation_id).toBe(first.runtime_invocation_id); expect(recovered.state).toBe("uncertain"); expect(recovered.error_code).toBe("OPERATION_OUTCOME_UNCERTAIN"); expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[queued.id])).rows[0].state).toBe("cancelled");
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.operations WHERE task_id=$1 AND kind='model'", [first.id])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT state FROM agents_platform.customer_deliveries WHERE task_id=$1", [first.id])).rows[0].state).toBe("suppressed");
    await command("return"); expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks")).rows[0].n).toBe(2);
    const nextMessage = await send("New question after explicit return");
    await eventually(async () => { await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: runtimeAdmin }); return (await pool.query("SELECT state FROM agents_platform.tasks WHERE id=(SELECT task_id FROM agents_platform.customer_messages WHERE id=$1)", [nextMessage.id])).rows[0]?.state === "completed"; });
    expect(modelCalls).toBe(2); expect(JSON.stringify(requests[1])).toContain("A person handled the account request.");
    const timeline = await fetch(messages, { headers: visitorHeaders }); expect(timeline.ok).toBe(true); const history = await timeline.json() as any;
    expect(history.messages.map((message: any) => message.body)).toEqual(["Question before worker loss", "Queued before takeover", "A person handled the account request.", "Human-owned backlog must remain context, not a new automatic task", "New question after explicit return", "Automation resumed after verified human support."]);
    expect(JSON.stringify(history)).not.toContain("LATE BEFORE WORKER LOSS"); expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks")).rows[0].n).toBe(3);
  }, 90_000);
});
