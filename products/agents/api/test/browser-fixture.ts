/** Local integration fixture: actual PostgreSQL, HTTP and Restate; deterministic model transport and seeded identity only. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash, createHmac } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { buildPlatformApp } from "../src/platform/app";
import { loadPlatformConfig } from "../src/platform/config";
import { setupPlatformSchema } from "../src/platform/setup";
import { PlatformStore } from "../src/platform/store";
import { createBusinessWorkflow } from "../src/platform/business";
import { startDispatcher } from "../src/platform/dispatcher";
import { defaultFaqConfiguration, type AgentConfiguration } from "../src/platform/contracts";
import { KnowledgeStore } from "../src/platform/knowledge";
import { EvidenceStore } from "../src/platform/evidence";
import { KnowledgeRuntime } from "../src/platform/knowledge-runtime";
import { QueryEmbeddingService } from "../src/platform/query-embedding";
import { documentRuntimeFromEnvironment } from "../src/platform/document-runtime";
import { IngestionService, createIngestionWorkflow, startIngestionDispatcher, reapDocumentResources } from "../src/platform/ingestion-runtime";
import { reapQueryEmbeddingResources } from "../src/platform/query-embedding";
import { privateStoreFromEnvironment } from "../src/platform/artifacts";
import { sandboxManagerFromEnvironment } from "../src/platform/sandbox";
import { createSandboxExecutor } from "../src/platform/sandbox-executor";

const root = resolve(__dirname, "../../../..");
const container = `kasitek-browser-${randomUUID().slice(0, 8)}`;
const databaseName = `agents_browser_${randomUUID().replaceAll("-", "")}`;
const image = "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742";
let ingress = process.env.RESTATE_INGRESS_URL ?? "http://127.0.0.1:18080";
let runtimeAdmin = process.env.RESTATE_ADMIN_URL ?? "http://127.0.0.1:19070";
let ownedRuntime = false;
let admin: Pool | undefined;
let pool: Pool | undefined;
let app: Awaited<ReturnType<typeof buildPlatformApp>> | undefined;
let dispatcher: ReturnType<typeof startDispatcher> | undefined;
let ingestionDispatcher: ReturnType<typeof startIngestionDispatcher> | undefined;
let workerProcess: ChildProcess | undefined;
let receiverProcess: ChildProcess | undefined;
let workerEnvironment: NodeJS.ProcessEnv | undefined;
let receiverLedger: string | undefined;
let workerRestarts = 0;
let worker: ReturnType<typeof createServer> | undefined;
let site: ReturnType<typeof createHttpServer> | undefined;
let privateDirectory: string | undefined;
let browserProcess: ChildProcess | undefined;
let storageProcess: ChildProcess | undefined;
let reaperProcess: ChildProcess | undefined;
let sandboxManager: ReturnType<typeof sandboxManagerFromEnvironment>;
const fixtureAbort = new AbortController();
let cleaning: Promise<void> | undefined;
const connections = new Set<ServerHttp2Session>();
const realModel = process.env.AGENTS_BROWSER_REAL_MODEL === "1";
const harnessJourney = process.env.AGENTS_HARNESS_LIVE === "1";
const automationJourney = process.env.AGENTS_AUTOMATION_LIVE === "1";
const advancedJourney = process.env.AGENTS_ADVANCED_LIVE === "1" || automationJourney;
const modelCalls: { model: string; approvedKnowledgePresent: boolean }[] = [];

async function ready(action: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { try { if (await action()) return; } catch { /* Wait for the local service. */ } await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Timed out waiting for ${label}`);
}
function cleanup(): Promise<void> {
  return cleaning ??= cleanupResources();
}
async function cleanupResources() {
  if (browserProcess && browserProcess.exitCode === null) browserProcess.kill("SIGTERM");
  fixtureAbort.abort();
  await stopWorkerProcess();
  if (receiverProcess?.pid && receiverProcess.exitCode === null && receiverProcess.signalCode === null) { receiverProcess.kill("SIGTERM"); await once(receiverProcess, "exit"); }
  await dispatcher?.stop();
  await ingestionDispatcher?.stop();
  if(pool){const runtime=documentRuntimeFromEnvironment();if(runtime){await reapDocumentResources(pool,runtime);await reapQueryEmbeddingResources(pool,runtime);}}
  await app?.close();
  if (site) await new Promise<void>(resolve => site!.close(() => resolve()));
  for (const session of connections) session.destroy();
  if (worker) await new Promise<void>(resolve => worker!.close(() => resolve()));
  if (sandboxManager && pool) {
    const allocations = (await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE state<>'destroyed'")).rows;
    for (const allocation of allocations) await sandboxManager.destroy({ organizationId: allocation.organization_id, rootTaskId: allocation.root_task_id, taskId: allocation.task_id, deadlineAt: new Date(allocation.lease_expires_at) }, allocation.id);
  }
  if (reaperProcess?.pid && reaperProcess.exitCode === null && reaperProcess.signalCode === null) { reaperProcess.kill("SIGTERM"); await once(reaperProcess, "exit"); }
  await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end(); }
  if (ownedRuntime) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  if (storageProcess?.pid && storageProcess.exitCode === null && storageProcess.signalCode === null) { storageProcess.kill("SIGTERM"); await once(storageProcess, "exit"); }
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
}


async function availablePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function stopWorkerProcess() {
  if (workerProcess?.pid && workerProcess.exitCode === null && workerProcess.signalCode === null) { workerProcess.kill("SIGKILL"); await once(workerProcess, "exit"); }
}
async function startWorkerProcess() {
  workerProcess = spawn(process.execPath, [resolve(root, "products/agents/api/dist/platform/worker.js")], { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: workerEnvironment });
  await ready(() => new Promise<boolean>(resolve => { const socket = connect(9080, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); }), "actual worker process");
}
async function ledgerRecords(): Promise<Record<string, any>[]> { return (await readFile(receiverLedger!, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line)); }
async function prepareDeliveryFixture(directory: string) {
  receiverLedger = join(directory, "receiver-ledger.jsonl");
  const apiKey = randomUUID()+randomUUID();
  Object.assign(process.env, { NODE_ENV: "test", AGENTS_CONNECTION_ACTIVE_KEY: "browser-fixture", AGENTS_CONNECTION_KEYS: JSON.stringify({ "browser-fixture": randomBytes(32).toString("base64") }), AGENTS_REPORT_DELIVERY_TARGETS: JSON.stringify([{ id: "browser-receiver", label: "Browser report receiver", url: "http://127.0.0.1:4399/deliveries", resource: "browser-report" }]) });
  receiverProcess = spawn(process.execPath, ["--import", require.resolve("tsx"), resolve(root, "products/agents/web/test/report-receiver.ts")], { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, AGENTS_RECEIVER_LEDGER: receiverLedger, AGENTS_RECEIVER_KEY: apiKey } });
  await ready(async () => (await fetch("http://127.0.0.1:4399/deliveries")).status === 403, "persistent independent report receiver");
  return apiKey;
}

async function prepareAdvancedStorage(directory: string): Promise<void> {
  const reservation = createHttpServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const endpoint = `http://127.0.0.1:${port}`, accessKeyId = "advanced-browser-fixture", secretAccessKey = randomUUID()+randomUUID(), bucket = `agents-browser-${randomUUID()}`;
  storageProcess = spawn(process.env.AGENTS_TEST_MINIO_BINARY ?? "/tmp/kasitek-minio-build/minio", ["server", join(directory, "objects"), "--address", `127.0.0.1:${port}`, "--console-address", "127.0.0.1:0"], {
    stdio: "ignore", env: { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey, MINIO_BROWSER: "off" },
  });
  storageProcess.once("error", () => { /* Readiness reports the unavailable local backend. */ });
  await ready(async () => (await fetch(`${endpoint}/minio/health/live`)).ok, "isolated private object storage");
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0,8), path = `/${bucket}`;
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
  const payload = sha(""), scope = `${day}/us-east-1/s3/aws4_request`, headers = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", path, "", `host:127.0.0.1:${port}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`, headers, payload].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`,day),"us-east-1"),"s3"),"aws4_request");
  const signature = createHmac("sha256",key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).digest("hex");
  const created = await fetch(endpoint+path, { method: "PUT", headers: { "x-amz-date": date, "x-amz-content-sha256": payload, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${headers}, Signature=${signature}` } });
  assert.ok(created.ok, `Private fixture bucket setup failed (${created.status})`);
  Object.assign(process.env, { AGENTS_S3_ENDPOINT: endpoint, AGENTS_S3_REGION: "us-east-1", AGENTS_S3_BUCKET: bucket, AGENTS_S3_ACCESS_KEY_ID: accessKeyId, AGENTS_S3_SECRET_ACCESS_KEY: secretAccessKey, AGENTS_SANDBOX_ENABLED: "1", AGENTS_SANDBOX_DIRECTORY: join(directory,"sandbox") });
}

async function prepareAdvancedFixture(token: string): Promise<{ agentPath: string; specialistVersionIds: string[]; sourceTitle: string }> {
  async function request<T>(path: string, body: unknown, method = "POST"): Promise<T> {
    const response = await fetch(`http://127.0.0.1:4100${path}`, { method, headers: { "content-type": "application/json", origin: "http://localhost:3100", cookie: `agents_session=${token}` }, ...(body!==undefined?{body:JSON.stringify(body)}:{}) });
    assert.ok(response.ok, `Advanced fixture management ${method} ${path} failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  const { organization } = await request<{ organization: { id: string } }>("/api/organizations", { name: "Advanced browser verification" });
  const base = `/api/organizations/${organization.id}`;
  const sourceTitle = "Browser analysis data";
  const { job } = await request<{ job: { id: string; sourceId: string; revisionId: string } }>(`${base}/knowledge/imports`, { operationId: randomUUID(), title: sourceTitle, kind: "upload", contentType: "text/plain", contentBase64: Buffer.from("Approved numeric dataset: [10, 20, 30]. Each number is one observation. This research dataset supports independently checking the sum, total, count and maximum, then calculating a Python analysis report. Use only these approved values for the report and cite this source.").toString("base64") });
  await ready(async()=> (await pool!.query("SELECT state FROM agents_platform.ingestion_jobs WHERE id=$1",[job.id])).rows[0]?.state==="ready","actual isolated advanced source import");
  await request(`${base}/knowledge/sources/${job.sourceId}/policy`,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
  const approved=await request<{sources:{id:string;revisions:{id:string;embeddingRelease:string|null}[]}[]}>(`${base}/knowledge/sources`,undefined,"GET");
  const embeddingRelease=approved.sources.find(source=>source.id===job.sourceId)?.revisions.find(revision=>revision.id===job.revisionId)?.embeddingRelease;
  assert.ok(embeddingRelease,"Research acceptance requires the actually indexed semantic profile");
  const knowledge={id:job.revisionId};
  async function create(name: string, instructions: string, specialist: boolean) {
    const { agent } = await request<{ agent: { id: string; draftRevision: number } }>(`${base}/agents`, { name });
    const defaults = defaultFaqConfiguration();
    const configuration: AgentConfiguration = { ...defaults, instructions, sourceRevisionIds: [knowledge.id], retrievalProfile:{kind:"hybrid-v1",embeddingRelease}, tools: specialist ? ["knowledge.search", "knowledge.read"] : [], model: { ...defaults.model, maxOutputTokens: specialist ? 192 : 768 } };
    const updated = await request<{ agent: { draftRevision: number } }>(`${base}/agents/${agent.id}`, { name, configuration, expectedRevision: agent.draftRevision }, "PUT");
    const { version } = await request<{ version: { id: string } }>(`${base}/agents/${agent.id}/versions`, { expectedRevision: updated.agent.draftRevision });
    return { agent, version };
  }
  const first = await create("Dataset researcher", "Inspect the approved numeric dataset and answer the delegated arithmetic question in one short sentence. Use the supplied source passage; if absent, knowledge.search for 'approved numeric dataset'. Copy its exact citation label in brackets. Do not delegate or run code.", true);
  const second = await create("Dataset reviewer", "Independently inspect the approved numeric dataset. State its count and maximum in one short sentence. Use the supplied source passage; if absent, knowledge.search for 'approved numeric dataset'. Copy its exact citation label in brackets. Do not delegate or run code.", true);
  const coordinator = await create("Analysis coordinator", "Complete the user's task with actual tools. First call agents_delegate once with two requests, one per binding: 'What is the sum of the approved numeric dataset? Cite the supplied source.' and 'What are the count and maximum of the approved numeric dataset? Cite the supplied source.'. Omit maxTokens so specialists receive their full published allocation. Wait for their actual results. Then call sandbox_analyze once using standard-library Python to calculate sum and count and write report.json under os.environ['OUTPUT_DIR']. Report JSON must contain values, sum, count, and a nonempty citations array of exact bracketed source labels from your supplied context or specialist results. Never invent a source label. Finish only after export, and cite the actual source in the short final reply. Do not repeat successful tool calls.", false);
  return { agentPath: `/app/agents/${coordinator.agent.id}`, specialistVersionIds: [first.version.id, second.version.id], sourceTitle };
}

async function main() {
  if (automationJourney) {
    ingress = `http://127.0.0.1:${await availablePort()}`;
    runtimeAdmin = `http://127.0.0.1:${await availablePort()}`;
    Object.assign(process.env, { RESTATE_INGRESS_URL: ingress, RESTATE_ADMIN_URL: runtimeAdmin });
  }
  let databaseUrl = process.env.AGENTS_BROWSER_FIXTURE_DATABASE_URL;
  if (!databaseUrl && process.env.AGENTS_BROWSER_FIXTURE_STATE_PATH) {
    const state = JSON.parse(await readFile(process.env.AGENTS_BROWSER_FIXTURE_STATE_PATH, "utf8")) as { url?: string; AGENTS_TEST_DATABASE_URL?: string };
    databaseUrl = state.url ?? state.AGENTS_TEST_DATABASE_URL;
  }
  assert.ok(databaseUrl, "Set AGENTS_BROWSER_FIXTURE_DATABASE_URL or AGENTS_BROWSER_FIXTURE_STATE_PATH to an isolated local PostgreSQL administrator fixture");
  if (advancedJourney) assert.ok(realModel, "Advanced acceptance requires the approved real model and actual isolation");
  if (realModel) assert.ok(process.env.OPENROUTER_API_KEY, "Live model mode requires OPENROUTER_API_KEY; fixture mode is the default");
  const modelKey = realModel ? process.env.OPENROUTER_API_KEY! : "deterministic-fixture-only";
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const database = new URL(databaseUrl); database.pathname = `/${databaseName}`;
  pool = new Pool({ connectionString: database.href, max: 10 });
  await setupPlatformSchema(pool);
  const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: database.href,
    AGENTS_PUBLIC_URL: "http://localhost:3100", AGENTS_OIDC_ISSUER_URL: "http://localhost:8080/realms/browser-fixture",
    AGENTS_OIDC_CLIENT_SECRET: "fixture-not-a-production-secret", OPENROUTER_API_KEY: modelKey });
  const store = new PlatformStore(pool);
  // This seeds an identity for transport testing. OIDC is verified separately.
  const account = await store.ensureAccount({ issuer: config.AGENTS_OIDC_ISSUER_URL, subject: randomUUID(), email: "browser-fixture@example.com", displayName: "Browser fixture" });
  const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  privateDirectory = await mkdtemp(join(tmpdir(), "agents-browser-fixture-"));
  await writeFile(join(privateDirectory, "session.json"), JSON.stringify({ cookie: session.token }), { mode: 0o600 });
  await prepareAdvancedStorage(privateDirectory);
  process.env.AGENTS_DOCUMENT_RUNTIME_ENABLED="1";
  const documents=documentRuntimeFromEnvironment();assert.ok(documents&&await documents.available(),"Browser fixture requires actual pinned document isolation");
  const deliveryKey = automationJourney ? await prepareDeliveryFixture(privateDirectory) : undefined;
  sandboxManager = sandboxManagerFromEnvironment(pool);
  if (advancedJourney) assert.ok(sandboxManager && await sandboxManager.available(), "Advanced fixture requires actual gVisor isolation");
  app = await buildPlatformApp({ config, pool, logging: false });
  await app.listen({ host: "127.0.0.1", port: 4100 });
  let advanced: Awaited<ReturnType<typeof prepareAdvancedFixture>> | undefined;
  const fixtureFetch: typeof fetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body)) as { model: string; messages: { content: string }[] };
    const knowledge = body.messages.map(message=>message.content??"").join("\n");
    const answer = knowledge.match(/Acme accepts returns[^.\n]*\./)?.[0];
    modelCalls.push({ model: body.model, approvedKnowledgePresent: Boolean(answer) });
    assert.ok(answer, "Model transport must receive the approved public knowledge source");
    await new Promise(resolve => setTimeout(resolve, 1_500));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer+" ["+knowledge.match(/E[a-f0-9]{32}/)![0]+"]" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { "content-type": "application/json" } });
  };
  const observedModelFetch: typeof fetch = async (url, request) => {
    const started = Date.now();
    try {
      const response = await fetch(url, request);
      if (!response.ok) {
        const body = await response.clone().json().catch(() => null) as { error?: { code?: unknown } } | null;
        const code = body?.error?.code;
        console.error(JSON.stringify({ event: "fixture.model_http_failure", status: response.status, elapsedMs: Date.now() - started,
          ...(typeof code === "number" || typeof code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(code) ? { providerCode: code } : {}) }));
      }
      return response;
    } catch (error) {
      const cause = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : undefined;
      console.error(JSON.stringify({ event: "fixture.model_transport_failure", elapsedMs: Date.now() - started,
        ...(typeof cause === "string" && /^[A-Z0-9_]{1,80}$/.test(cause) ? { code: cause } : {}) }));
      throw error;
    }
  };
  const sourceObjects=privateStoreFromEnvironment(process.env,10_485_760)!;
  const evidence=new EvidenceStore(pool,sourceObjects),ingestion=new IngestionService(pool,sourceObjects,documents,new KnowledgeStore(pool,sourceObjects));
  if (automationJourney) {
    workerEnvironment = { ...process.env, AGENTS_DATABASE_URL: database.href, OPENROUTER_API_KEY: modelKey, RESTATE_INGRESS_URL: ingress, RESTATE_ADMIN_URL: runtimeAdmin, RESTATE_WORKER_PORT: "9080", RESTATE_WORKER_HOST: "0.0.0.0", AGENTS_ALLOW_UNSIGNED_WORKER: "1" };
    await startWorkerProcess();
  } else {
  worker = createServer(createEndpointHandler({ services: [createBusinessWorkflow(pool, { openRouterApiKey: modelKey, signal: fixtureAbort.signal, executeSandbox: createSandboxExecutor(pool, sandboxManager, privateStoreFromEnvironment()), evidence,knowledgeRuntime:new KnowledgeRuntime(pool,evidence,new QueryEmbeddingService(pool,sourceObjects,documents)),fetch: realModel ? observedModelFetch : fixtureFetch }),createIngestionWorkflow(ingestion)] }));
  worker.on("session", session => { connections.add(session); session.once("close", () => connections.delete(session)); });
  await new Promise<void>((resolve, reject) => { worker!.once("error", reject); worker!.listen(9080, "0.0.0.0", resolve); });
  }
  let runtimeReady = false;
  try { runtimeReady = (await fetch(`${runtimeAdmin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Start a dedicated runtime below. */ }
  if (!runtimeReady) {
    execFileSync("docker", ["run", "-d", "--name", container, "--add-host", "host.docker.internal:host-gateway",
      "-p", `127.0.0.1:${new URL(ingress).port}:8080`, "-p", `127.0.0.1:${new URL(runtimeAdmin).port}:9070`, image], { stdio: "pipe" });
    ownedRuntime = true;
  }
  await ready(async () => (await fetch(`${runtimeAdmin}/health`)).ok, "Restate");
  const registration = await fetch(`${runtimeAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: "http://host.docker.internal:9080", force: true }) });
  assert.ok(registration.ok, `Restate registration failed (${registration.status})`);
  if (advancedJourney) {
    reaperProcess = spawn(process.execPath, [resolve(root, "products/agents/api/node_modules/tsx/dist/cli.mjs"), resolve(root, "products/agents/api/src/platform/sandbox-reaper.ts")], {
      cwd: root, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, AGENTS_DATABASE_URL: database.href },
    });
  }
  if (!automationJourney) {
    dispatcher = startDispatcher(pool, { ingressUrl: ingress, adminUrl: runtimeAdmin, onError: code => console.error(`Fixture dispatcher: ${code}`) });
    ingestionDispatcher=startIngestionDispatcher(ingestion,ingress,code=>console.error(`Fixture import dispatcher: ${code}`));
  }
  advanced = advancedJourney ? await prepareAdvancedFixture(session.token) : undefined;
  site = createHttpServer((request, response) => {
    if (automationJourney && request.method === "POST" && request.url?.startsWith("/fixture/")) {
      void (async () => {
        if (request.url === "/fixture/restart-review") { await stopWorkerProcess(); await startWorkerProcess(); workerRestarts++; }
        else if (request.url === "/fixture/interrupt-delivery") { await ready(async () => (await ledgerRecords()).some(record => record.type === "accepted"), "receiver durable acceptance before interruption"); await stopWorkerProcess(); await startWorkerProcess(); workerRestarts++; }
        else { response.writeHead(404).end(); return; }
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ workerRestarts }));
      })().catch(() => response.writeHead(500).end()); return;
    }

    const deployment = new URL(request.url ?? "/", "http://127.0.0.1:4398").searchParams.get("deployment");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>External website fixture</title><h1>Acme help</h1>${deployment && /^[a-f0-9-]{36}$/.test(deployment) ? `<script async src="http://localhost:3100/api/website/${deployment}/widget.js"></script>` : ""}</html>`);
  });
  await new Promise<void>((resolve, reject) => { site!.once("error", reject); site!.listen(4398, "127.0.0.1", resolve); });
  assert.ok((await fetch("http://localhost:3100")).ok, "Start the Agents Vite frontend at localhost:3100 before running this fixture");
  const playwright = require.resolve("@playwright/test/cli", { paths: [resolve(root, "products/agents/web")] });
  const browser = browserProcess = spawn(process.execPath, [playwright, "test", "--grep", automationJourney ? "live automation:" : advancedJourney ? "live execution:" : harnessJourney ? "live harness" : "live platform", "--output", automationJourney ? ".artifacts/automation-live" : advancedJourney ? ".artifacts/advanced-live" : harnessJourney ? ".artifacts/harness-live" : ".artifacts/browser-live"], {
    cwd: resolve(root, "products/agents/web"), stdio: "inherit",
    env: { ...process.env, AGENTS_BROWSER_BASE_URL: "http://localhost:3100", AGENTS_BROWSER_SESSION_COOKIE: session.token,
      AGENTS_BROWSER_WIDGET_ORIGIN: "http://127.0.0.1:4398",
      ...(deliveryKey ? { AGENTS_DELIVERY_FIXTURE_KEY: deliveryKey } : {}),
      ...(advanced ? { AGENTS_ADVANCED_AGENT_PATH: advanced.agentPath, AGENTS_ADVANCED_SPECIALIST_VERSIONS: advanced.specialistVersionIds.join(","),
        AGENTS_ADVANCED_SOURCE_TITLE: advanced.sourceTitle, AGENTS_ADVANCED_PROMPT: "Independently research the approved numeric dataset with both configured specialists; omit maxTokens. Calculate a Python analysis report with the original values, sum and count. Write report.json in OUTPUT_DIR, including a nonempty citations array of exact supplied source labels in brackets, and report the verified total with its source. Use actual tools and export the report.",
        AGENTS_ADVANCED_EXPECT: "60", AGENTS_ADVANCED_FILE_CONTAINS: "60", AGENTS_ADVANCED_DATASET_CHECK: "1" } : {}) },
  });
  const [exitCode] = await once(browser, "exit");
  assert.equal(exitCode, 0, "Live-service browser check failed");
  if (!realModel) {
    assert.equal(modelCalls.length, 4, "Four logical tasks require four provider calls; lost-response retry must not call twice");
    assert.ok(modelCalls.every(call => call.approvedKnowledgePresent), "Every provider fixture call must receive approved knowledge");
  }
  const tasks = (await pool.query("SELECT id,state,runtime_invocation_id,parent_task_id,root_task_id FROM agents_platform.tasks")).rows;
  if (automationJourney) {
    assert.equal(workerRestarts, 2, "Actual worker must restart awaiting review and after receiver acceptance");
    const records = await ledgerRecords(), accepted = records.filter(record => record.type === "accepted");
    assert.equal(accepted.length, 1, "Independent receiver must persist exactly one accepted report");
    assert.equal(records.filter(record => record.type === "post").length, 1, "Recovery must query the original receipt without a second POST");
    assert.ok(records.some(record => record.type === "status"), "Restart must reconcile using real receiver status");
    const report = JSON.parse(Buffer.from(accepted[0].payload.report.contentBase64, "base64").toString("utf8"));
    assert.deepEqual(report.values, [10,20,30]); assert.equal(report.sum, 60); assert.equal(report.count, 3);
    const action = (await pool.query("SELECT state,receipt FROM agents_platform.actions")).rows;
    assert.equal(action.length, 1); assert.equal(action[0].state, "delivered"); assert.equal(action[0].receipt.id, accepted[0].receipt.id);
    console.log(JSON.stringify({ evidence: "scheduled real report, worker restart awaiting review, sender interrupted after durable receiver acceptance, original receipt recovered with one POST", workerRestarts, acceptedDeliveries: accepted.length }));
  }
  if (advancedJourney) {
    assert.equal(tasks.length, 3, "One accepted root must create exactly two real child tasks");
    const acceptedRoot = tasks.find(task => !task.parent_task_id);
    assert.ok(acceptedRoot && tasks.every(task => task.state === "completed" && task.runtime_invocation_id));
    assert.equal(tasks.filter(task => task.parent_task_id === acceptedRoot.id && task.root_task_id === acceptedRoot.id).length, 2);
    const operations = (await pool.query("SELECT kind,name,state FROM agents_platform.operations WHERE task_id=$1", [acceptedRoot.id])).rows;
    assert.ok(operations.some(operation => operation.name === "agents.delegate" && operation.state === "completed"), "Require a completed real delegation operation");
    assert.ok(operations.some(operation => operation.name === "sandbox.analyze" && operation.state === "completed"), "Require a completed real sandbox operation");
    const allocations = (await pool.query("SELECT state FROM agents_platform.sandbox_allocations WHERE root_task_id=$1", [acceptedRoot.id])).rows;
    assert.ok(allocations.length > 0 && allocations.every(allocation => allocation.state === "destroyed"), "Actual sandbox allocations must be destroyed after export");
    const imports = (await pool.query("SELECT id,revision_id,state FROM agents_platform.ingestion_jobs")).rows;
    assert.ok(imports.length > 0 && imports.every(job => job.state === "ready"), "Approved research knowledge must pass through actual source ingestion");
    const references = (await pool.query("SELECT id,task_id,operation_id,citation_label FROM agents_platform.evidence_references WHERE root_task_id=$1 ORDER BY task_id,id", [acceptedRoot.id])).rows;
    console.log(JSON.stringify({ evidence: "actual isolated source ingestion and server-issued research evidence", imports, references, perTask:tasks.map(task=>({id:task.id,references:references.filter(reference=>reference.task_id===task.id).length})) }));
    assert.ok(tasks.every(task => references.some(reference => reference.task_id === task.id)), "The coordinator and both specialists must have actual source evidence");
    console.log(JSON.stringify({ evidence: "real free model, authorized specialist children, gVisor analysis, private artifact download and cleanup; identity seeded", rootTaskId: acceptedRoot.id, completedTasks: tasks.length, providerFixtureCalls: modelCalls.length }));
    return;
  }
  assert.ok(tasks.length === (harnessJourney ? 3 : 4) && tasks.every(task => task.state === "completed" && task.runtime_invocation_id), "All browser replies require actual durable Restate invocations");
  console.log(JSON.stringify({ evidence: harnessJourney ? "real HTTP, PostgreSQL, outbox, Restate, browser, contextual conversation, reviewed memory, pinned skills and tool execution; identity seeded" : "real HTTP, PostgreSQL, outbox, Restate, browser, external widget and lost-response recovery; identity seeded", modelTransport: realModel ? "live free model" : "deterministic fixture", ports: [3100, 4100, 9080, 18080, 19070, 4398], completedTasks: tasks.length, providerFixtureCalls: modelCalls.length }));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
void main().catch(error => { console.error(error instanceof Error ? error.stack : "Browser fixture failed"); process.exitCode = 1; }).finally(cleanup);
