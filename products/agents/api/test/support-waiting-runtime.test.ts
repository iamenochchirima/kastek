import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as reservePort } from "node:net";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { dispatchSupportWaitingOnce } from "../src/product/inbox/support-waiting-runtime";
import { transaction } from "../src/infrastructure/database";
import { registerChannelPorts } from "../src/infrastructure/channel-ports";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const enabled = process.env.AGENTS_TEST_DATABASE_URL && process.env.AGENTS_SUPPORT_WAITING_RUNTIME === "1";
(enabled ? describe : describe.skip)("actual Restate support waiting and recovery without inference", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, worker: ChildProcess | undefined;
  let databaseUrl = "", workerOutput = "", bridge = "", port = 0, ingress = "", runtimeAdmin = "", started = false;
  const database = `agents_support_runtime_${randomUUID().replaceAll("-", "")}`, container = `agents-support-runtime-${randomUUID()}`;
  const image = "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742";
  const root = resolve(__dirname, "../../../.."), workerPids: number[] = [], proof: Record<string, unknown> = {};
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  async function eventually(check: () => Promise<boolean>, timeout = 30_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await delay(75); } throw Error("Owned support runtime checkpoint timed out"); }
  async function startWorker(pauseAfterCommit = false) {
    workerOutput = "";
    worker = spawn(process.execPath, ["--import", "tsx", resolve(__dirname, "support-waiting-runtime-worker.ts")], {
      cwd: resolve(root, "products/agents/api"), env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OTEL_SDK_DISABLED: "true", AGENTS_DATABASE_URL: databaseUrl,
        SUPPORT_WAITING_FIXTURE_HOST: bridge, SUPPORT_WAITING_FIXTURE_PORT: String(port), SUPPORT_WAITING_FIXTURE_PAUSE_AFTER_COMMIT: pauseAfterCommit ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const owned = worker; owned.stdout!.on("data", chunk => { workerOutput = (workerOutput + String(chunk)).slice(-12000); }); owned.stderr!.on("data", () => {});
    await eventually(async () => { if (owned.exitCode !== null || owned.signalCode !== null) throw Error("Owned support worker exited during startup"); return workerOutput.includes("SUPPORT_WAITING_FIXTURE_READY"); });
    workerPids.push(owned.pid!);
  }
  async function stopWorker() {
    const owned = worker; if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
    owned.kill("SIGKILL"); await new Promise<void>(resolve => owned.once("exit", () => resolve()));
  }
  async function healthy() { await eventually(async () => { try { return (await fetch(`${runtimeAdmin}/health`)).ok; } catch { return false; } }); }
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.AGENTS_TEST_DATABASE_URL!); url.pathname = `/${database}`; databaseUrl = url.href;
    pool = new Pool({ connectionString: databaseUrl, max: 8 }); await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    bridge = docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}");
    const reservation = reservePort(); await new Promise<void>(resolve => reservation.listen(0, bridge, resolve)); port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    await startWorker();
    docker("run", "-d", "--name", container, "--cpus", "1", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", image); started = true;
    ingress = `http://${docker("port", container, "8080/tcp")}`; runtimeAdmin = `http://${docker("port", container, "9070/tcp")}`; await healthy();
    const registration = await fetch(`${runtimeAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${port}`, force: false }) });
    expect(registration.ok, await registration.text()).toBe(true);
  }, 90_000);
  afterAll(async () => {
    await stopWorker(); if (started) docker("rm", "-f", container); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); }
  }, 30_000);

  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "https://support-runtime.fixture.test", subject: randomUUID(), email: "operator@support-runtime.test", displayName: "Support operator" });
    const org = await platform.createOrganization(account.id, "Support runtime fixture"); await connectFixtureModel(pool, account.id, org.id);
    const configuration = defaultBusinessConfiguration(); configuration.tools = ["channel.request_handoff"];
    const agent = await platform.createAgent({ accountId: account.id, organizationId: org.id, name: "Support", configuration });
    const version = await platform.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const deployment = await platform.publishWebsite({ accountId: account.id, organizationId: org.id, agentId: agent.id, versionId: version.id, allowedOrigins: ["https://support-customer.fixture.test"] });
    const sessionId = randomUUID(), token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [sessionId, deployment.id, createHash("sha256").update(token).digest("hex"), "https://support-customer.fixture.test"]);
    const grant = await platform.createWebsiteGrant({ deploymentId: deployment.id, origin: "https://support-customer.fixture.test", sessionId });
    const inbox = new InboxStore(pool, {
      async admit(db, input) { return (await platform.admitTaskInTransaction(db, { authority: { product: "agents", organizationId: org.id, resourceId: deployment.id, callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId } }, grantId: grant.id, versionId: version.id, input: input.input, requestKey: input.requestKey, channelBinding: input.channelBinding })).task; },
      async readableOutput() { throw Error("Unexpected model output read"); }, async cancelRoot() {},
    });
    registerChannelPorts(pool, { assertBinding: (...args) => inbox.assertBinding(...args), requestHandoff: (...args) => inbox.requestHandoff(...args), publishAutomated: (...args) => inbox.publishAutomated(...args), context: (...args) => inbox.context(...args) });
    const visitor = { deploymentId: deployment.id, sessionId }, conversation = await inbox.open(visitor);
    const incoming = await inbox.ingress(visitor, conversation.id, { requestKey: randomUUID(), body: "I need human support" }), taskId = incoming.message.task_id!;
    await transaction(pool, db => inbox.requestHandoff(db, { customerConversationId: conversation.id, ownershipGeneration: "1", inputMessageId: incoming.message.id }, taskId));
    await pool.query("UPDATE agents_platform.support_waiting SET requested_at=now()-interval '35 minutes' WHERE task_id=$1", [taskId]);
    return { taskId, conversation, inbox, visitor };
  }
  async function notices(taskId: string) { return (await pool.query("SELECT stage,state,message_id FROM agents_platform.support_waiting_notices WHERE task_id=$1 ORDER BY stage", [taskId])).rows; }
  async function outputCompleted(invocationId: string) { await eventually(async () => (await fetch(`${ingress}/restate/output/${invocationId}`)).status === 200); }
  async function noInference() { expect((await pool.query("SELECT count(*)::int count FROM agents_platform.operations WHERE kind='model'")).rows[0].count).toBe(0); }

  it("persists its timer across worker SIGKILL and Restate restart, then publishes one actual Inbox notice", async () => {
    const f = await fixture(), due = Date.now() + 6000, invocations: string[] = [];
    await pool.query("UPDATE agents_platform.support_waiting SET next_action_at=$2 WHERE task_id=$1", [f.taskId, new Date(due)]);
    await dispatchSupportWaitingOnce(pool, ingress, async (url, init) => { const response = await fetch(url, init); invocations.push((await response.clone().json() as { invocationId: string }).invocationId); return response; });
    await eventually(async () => workerOutput.includes(`SUPPORT_WAITING_FIXTURE_STEP ${f.taskId}`));
    expect(await notices(f.taskId)).toHaveLength(0); expect(Date.now()).toBeLessThan(due);
    await stopWorker(); docker("restart", "--time", "0", container);
    ingress = `http://${docker("port", container, "8080/tcp")}`; runtimeAdmin = `http://${docker("port", container, "9070/tcp")}`; await healthy();
    await delay(Math.max(1, due - Date.now() + 150)); expect(await notices(f.taskId)).toHaveLength(0);
    await startWorker(); await eventually(async () => (await notices(f.taskId))[0]?.state === "published");
    await outputCompleted(invocations[0]!);
    await pool.query("UPDATE agents_platform.support_waiting SET dispatched_at=NULL WHERE task_id=$1", [f.taskId]);
    // Direct duplicate invocation checks actual Restate workflow identity even though the outbox is terminal.
    const replay = await fetch(`${ingress}/restate/send/AgentsSupportWaitingV1/${f.taskId}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: f.taskId }) });
    invocations.push((await replay.json() as { invocationId: string }).invocationId);
    expect(invocations[1]).toBe(invocations[0]); expect(await notices(f.taskId)).toHaveLength(1);
    const timeline = await f.inbox.readVisitor(f.visitor, f.conversation.id);
    expect(timeline.messages.at(-1)?.body).toContain("still waiting");
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.support_staff_alerts WHERE task_id=$1", [f.taskId])).rows[0].count).toBe(2);
    await noInference(); proof.timer = { taskId: f.taskId, invocationId: invocations[0], timerSurvivedWorkerAndRestateRestart: true, duplicateInvocationReused: true, notices: await notices(f.taskId) };
  }, 60_000);

  it("recovers a committed notice after worker SIGKILL before the durable step acknowledgement without duplicating it", async () => {
    await stopWorker(); await startWorker(true); const f = await fixture();
    await pool.query("UPDATE agents_platform.support_waiting SET next_action_at=now()-interval '1 second' WHERE task_id=$1", [f.taskId]);
    let invocationId = "";
    await dispatchSupportWaitingOnce(pool, ingress, async (url, init) => { const response = await fetch(url, init); invocationId = (await response.clone().json() as { invocationId: string }).invocationId; return response; });
    await eventually(async () => workerOutput.includes(`SUPPORT_WAITING_FIXTURE_COMMITTED ${f.taskId}`));
    const before = await notices(f.taskId); expect(before).toHaveLength(1); expect(before[0].state).toBe("published");
    // Restate 1.7 reports an unfinished invocation with its 470 not-ready status.
    expect((await fetch(`${ingress}/restate/output/${invocationId}`)).status).toBe(470);
    await stopWorker(); await startWorker(); await outputCompleted(invocationId);
    expect(await notices(f.taskId)).toEqual(before);
    expect((await pool.query("SELECT count(*)::int count FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key LIKE 'waiting:%'", [f.conversation.id])).rows[0].count).toBe(1);
    await noInference(); proof.commitReplay = { taskId: f.taskId, invocationId, killedAfterDatabaseCommitBeforeStepResult: true, unchangedNoticeReceipts: true, notices: before };
    const evidence = resolve(root, ".audit/support-waiting-runtime"); await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, "acceptance.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), mode: "actual-postgresql-and-restate-no-inference", restateImage: image, workerPids, ...proof }, null, 2));
  }, 60_000);
});
