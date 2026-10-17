/** Local integration fixture: actual PostgreSQL, HTTP and Restate; deterministic model transport and seeded identity only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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

const root = resolve(__dirname, "../../../..");
const container = `kasitek-browser-${randomUUID().slice(0, 8)}`;
const databaseName = `agents_browser_${randomUUID().replaceAll("-", "")}`;
const image = "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742";
const ingress = process.env.RESTATE_INGRESS_URL ?? "http://127.0.0.1:18080";
const runtimeAdmin = process.env.RESTATE_ADMIN_URL ?? "http://127.0.0.1:19070";
let ownedRuntime = false;
let admin: Pool | undefined;
let pool: Pool | undefined;
let app: Awaited<ReturnType<typeof buildPlatformApp>> | undefined;
let dispatcher: ReturnType<typeof startDispatcher> | undefined;
let worker: ReturnType<typeof createServer> | undefined;
let site: ReturnType<typeof createHttpServer> | undefined;
let privateDirectory: string | undefined;
let browserProcess: ChildProcess | undefined;
let cleaning: Promise<void> | undefined;
const connections = new Set<ServerHttp2Session>();
const realModel = process.env.AGENTS_BROWSER_REAL_MODEL === "1";
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
  await dispatcher?.stop();
  await app?.close();
  if (site) await new Promise<void>(resolve => site!.close(() => resolve()));
  for (const session of connections) session.destroy();
  if (worker) await new Promise<void>(resolve => worker!.close(() => resolve()));
  await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end(); }
  if (ownedRuntime) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
}
async function main() {
  let databaseUrl = process.env.AGENTS_BROWSER_FIXTURE_DATABASE_URL;
  if (!databaseUrl && process.env.AGENTS_BROWSER_FIXTURE_STATE_PATH) {
    const state = JSON.parse(await readFile(process.env.AGENTS_BROWSER_FIXTURE_STATE_PATH, "utf8")) as { url: string };
    databaseUrl = state.url;
  }
  assert.ok(databaseUrl, "Set AGENTS_BROWSER_FIXTURE_DATABASE_URL or AGENTS_BROWSER_FIXTURE_STATE_PATH to an isolated local PostgreSQL administrator fixture");
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
  app = await buildPlatformApp({ config, pool, logging: false });
  await app.listen({ host: "127.0.0.1", port: 4100 });
  const fixtureFetch: typeof fetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body)) as { model: string; messages: { content: string }[] };
    const knowledge = body.messages[1]?.content ?? "";
    const answer = knowledge.match(/Acme accepts returns[^.\n]*\./)?.[0];
    modelCalls.push({ model: body.model, approvedKnowledgePresent: Boolean(answer) });
    assert.ok(answer, "Model transport must receive the approved public knowledge source");
    await new Promise(resolve => setTimeout(resolve, 1_500));
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { "content-type": "application/json" } });
  };
  worker = createServer(createEndpointHandler({ services: [createBusinessWorkflow(pool, { openRouterApiKey: modelKey, ...(realModel ? {} : { fetch: fixtureFetch }) })] }));
  worker.on("session", session => { connections.add(session); session.once("close", () => connections.delete(session)); });
  await new Promise<void>((resolve, reject) => { worker!.once("error", reject); worker!.listen(9080, "0.0.0.0", resolve); });
  let runtimeReady = false;
  try { runtimeReady = (await fetch(`${runtimeAdmin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Start a dedicated runtime below. */ }
  if (!runtimeReady) {
    execFileSync("docker", ["run", "-d", "--name", container, "--add-host", "host.docker.internal:host-gateway",
      "-p", "127.0.0.1:18080:8080", "-p", "127.0.0.1:19070:9070", image], { stdio: "pipe" });
    ownedRuntime = true;
  }
  await ready(async () => (await fetch(`${runtimeAdmin}/health`)).ok, "Restate");
  const registration = await fetch(`${runtimeAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: "http://host.docker.internal:9080", force: true }) });
  assert.ok(registration.ok, `Restate registration failed (${registration.status})`);
  dispatcher = startDispatcher(pool, { ingressUrl: ingress, adminUrl: runtimeAdmin, onError: code => console.error(`Fixture dispatcher: ${code}`) });
  site = createHttpServer((request, response) => {
    const deployment = new URL(request.url ?? "/", "http://127.0.0.1:4398").searchParams.get("deployment");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>External website fixture</title><h1>Acme help</h1>${deployment && /^[a-f0-9-]{36}$/.test(deployment) ? `<script async src="http://localhost:3100/api/website/${deployment}/widget.js"></script>` : ""}</html>`);
  });
  await new Promise<void>((resolve, reject) => { site!.once("error", reject); site!.listen(4398, "127.0.0.1", resolve); });
  assert.ok((await fetch("http://localhost:3100")).ok, "Start the Agents Vite frontend at localhost:3100 before running this fixture");
  const playwright = require.resolve("@playwright/test/cli", { paths: [resolve(root, "products/agents/web")] });
  const browser = browserProcess = spawn(process.execPath, [playwright, "test", "--grep", "live platform", "--output", ".artifacts/browser-live"], {
    cwd: resolve(root, "products/agents/web"), stdio: "inherit",
    env: { ...process.env, AGENTS_BROWSER_BASE_URL: "http://localhost:3100", AGENTS_BROWSER_SESSION_COOKIE: session.token,
      AGENTS_BROWSER_WIDGET_ORIGIN: "http://127.0.0.1:4398" },
  });
  const [exitCode] = await once(browser, "exit");
  assert.equal(exitCode, 0, "Live-service browser check failed");
  if (!realModel) {
    assert.equal(modelCalls.length, 4, "Four logical tasks require four provider calls; lost-response retry must not call twice");
    assert.ok(modelCalls.every(call => call.approvedKnowledgePresent), "Every provider fixture call must receive approved knowledge");
  }
  const tasks = (await pool.query("SELECT state,runtime_invocation_id FROM agents_platform.tasks")).rows;
  assert.ok(tasks.length === 4 && tasks.every(task => task.state === "completed" && task.runtime_invocation_id), "All browser replies require actual durable Restate invocations");
  console.log(JSON.stringify({ evidence: "real HTTP, PostgreSQL, outbox, Restate, browser, external widget and lost-response recovery; identity seeded", modelTransport: realModel ? "live free model" : "deterministic fixture", ports: [3100, 4100, 9080, 18080, 19070, 4398], completedTasks: tasks.length, providerFixtureCalls: modelCalls.length }));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
void main().catch(error => { console.error(error instanceof Error ? error.message : "Browser fixture failed"); process.exitCode = 1; }).finally(cleanup);
