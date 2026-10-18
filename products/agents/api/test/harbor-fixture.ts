/** Owned integration fixture. Harbor owns the trial, environment, verifier and reward. */
import assert from "node:assert/strict";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { publishFixtureSource } from "./knowledge-fixture";

const root = resolve(__dirname, "../../../.."), api = join(root, "products/agents/api");
const fixtureId = randomUUID(), databaseName = `agents_harbor_${fixtureId.replaceAll("-", "")}`;
const containerName = `agents-harbor-${fixtureId}`, build = join(root, ".audit", `harbor-${fixtureId}`);
const compiled = join(build, "runtime");
const realModel = process.env.AGENTS_HARBOR_REAL_MODEL === "1";
const modelKey = realModel ? process.env.OPENROUTER_API_KEY : "deterministic-harbor-fixture";
assert.ok(modelKey, "Approved free-model acceptance requires the configured key");
let pool: Pool | undefined, admin: Pool | undefined, storage: ChildProcess | undefined, harbor: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof import("../src/composition/app")["buildPlatformApp"]>> | undefined;
let dispatcher: ReturnType<typeof import("../src/execution/lifecycle/dispatcher")["startDispatcher"]> | undefined;
let worker: ReturnType<typeof createServer> | undefined;
let ownedRuntime = false, privateDirectory: string | undefined;
const sessions = new Set<ServerHttp2Session>(), abort = new AbortController();
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
async function availablePort() {
  const server = httpServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function ready(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Fixture readiness failed: ${label}`);
}
async function stop(process: ChildProcess | undefined) {
  if (process?.pid && process.exitCode === null && process.signalCode === null) { process.kill("SIGTERM"); await once(process, "exit"); }
}
async function main() {
  await mkdir(compiled, { recursive: true, mode: 0o700 });
  execFileSync(process.execPath, [join(api, "node_modules/typescript/bin/tsc"), "-p", join(api, "tsconfig.json"), "--outDir", compiled], { cwd: root, stdio: "inherit", timeout: 60000 });
  await cp(join(api, "schema"), join(build, "schema"), { recursive: true });
  // The isolated CommonJS build resolves the same pinned workspace dependencies.
  process.env.NODE_PATH = join(api, "node_modules"); require("node:module").Module._initPaths();
  const load = (path: string) => require(join(compiled, path));
  const { setupPlatformSchema } = load("composition/setup.js") as typeof import("../src/composition/setup");
  const { PlatformStore } = load("product/agents/store.js") as typeof import("../src/product/agents/store");
  const { defaultBusinessConfiguration } = load("contracts/contracts.js") as typeof import("../src/contracts/contracts");
  const { buildPlatformApp } = load("composition/app.js") as typeof import("../src/composition/app");
  const { loadPlatformConfig } = load("infrastructure/config.js") as typeof import("../src/infrastructure/config");
  const { privateStoreFromEnvironment } = load("infrastructure/object-store.js") as typeof import("../src/infrastructure/object-store");
  const { EvidenceStore } = load("execution/context/evidence.js") as typeof import("../src/execution/context/evidence");
  const { KnowledgeRuntime } = load("capabilities/knowledge/knowledge-runtime.js") as typeof import("../src/capabilities/knowledge/knowledge-runtime");
  const { createBusinessWorkflow } = load("execution/business/business.js") as typeof import("../src/execution/business/business");
  const { startDispatcher } = load("execution/lifecycle/dispatcher.js") as typeof import("../src/execution/lifecycle/dispatcher");
  const databaseUrl = process.env.AGENTS_BROWSER_FIXTURE_DATABASE_URL ?? process.env.AGENTS_DATABASE_URL;
  assert.ok(databaseUrl, "Fixture requires an administrative local PostgreSQL URL");
  admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${databaseName}"`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${databaseName}`;
  pool = new Pool({ connectionString: isolatedUrl.href }); await setupPlatformSchema(pool);
  privateDirectory = await mkdtemp(join(tmpdir(), "agents-harbor-"));
  const storagePort = await availablePort(), endpoint = `http://127.0.0.1:${storagePort}`;
  const accessKey = "harbor-fixture", secret = randomUUID() + randomUUID(), bucket = `harbor-${fixtureId}`;
  const childEnv = { ...process.env }; delete childEnv.OPENROUTER_API_KEY; delete childEnv.AGENTS_DATABASE_URL;
  storage = spawn(process.env.AGENTS_TEST_MINIO_BINARY ?? "/tmp/kasitek-minio-build/minio", ["server", join(privateDirectory, "objects"), "--address", `127.0.0.1:${storagePort}`, "--console-address", "127.0.0.1:0"], { stdio: "ignore", env: { ...childEnv, MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secret, MINIO_BROWSER: "off" } });
  storage.on("error", () => {});
  await ready(async () => (await fetch(`${endpoint}/minio/health/live`)).ok, "owned MinIO");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`, payload = sha("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", `/${bucket}`, "", `host:127.0.0.1:${storagePort}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`, signedHeaders, payload].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), "us-east-1"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).digest("hex");
  assert.ok((await fetch(`${endpoint}/${bucket}`, { method: "PUT", headers: { "x-amz-date": date, "x-amz-content-sha256": payload, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } })).ok);
  Object.assign(process.env, { NODE_ENV: "test", AGENTS_S3_ENDPOINT: endpoint, AGENTS_S3_REGION: "us-east-1", AGENTS_S3_BUCKET: bucket, AGENTS_S3_ACCESS_KEY_ID: accessKey, AGENTS_S3_SECRET_ACCESS_KEY: secret,
    AGENTS_SANDBOX_ENABLED: "0", AGENTS_DOCUMENT_RUNTIME_ENABLED: "0", AGENTS_REPORT_DELIVERY_TARGETS: "[]" });
  delete process.env.AGENTS_CONNECTION_ACTIVE_KEY; delete process.env.AGENTS_CONNECTION_KEYS;
  const objects = privateStoreFromEnvironment(process.env, 10485760)!;
  const store = new PlatformStore(pool), apiPort = await availablePort(), origin = `http://127.0.0.1:${apiPort}`;
  const config = loadPlatformConfig({ ...process.env, AGENTS_DATABASE_URL: isolatedUrl.href, AGENTS_PUBLIC_URL: origin, AGENTS_OIDC_ISSUER_URL: "http://localhost/realms/harbor-fixture", AGENTS_OIDC_CLIENT_SECRET: "harbor-local-fixture-secret-only", OPENROUTER_API_KEY: modelKey });
  const account = await store.ensureAccount({ issuer: config.AGENTS_OIDC_ISSUER_URL, subject: randomUUID(), email: "harbor@example.com", displayName: "Harbor fixture" });
  const organization = await store.createOrganization(account.id, "Harbor isolated trial");
  const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 1800000) });
  const source = await publishFixtureSource(pool, { accountId: account.id, organizationId: organization.id, title: "Opening hours", content: "What are the opening hours? Harbor fixture opens at nine.", visibility: "private" }, objects);
  const configuration = defaultBusinessConfiguration(); configuration.sourceRevisionIds = [source.id];
  const agent = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Grounded FAQ fixture", configuration });
  const version = await store.createVersion({ accountId: account.id, organizationId: organization.id, agentId: agent.id, expectedRevision: 1 });
  app = await buildPlatformApp({ config, pool, logging: false }); await app.listen({ host: "127.0.0.1", port: apiPort });
  docker("run", "-d", "--name", containerName, "--cpus", "2", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742"); ownedRuntime = true;
  const port = (containerPort: string) => Number(docker("port", containerName, containerPort).split(":").at(-1));
  const ingressUrl = `http://127.0.0.1:${port("8080/tcp")}`, adminUrl = `http://127.0.0.1:${port("9070/tcp")}`;
  await ready(async () => (await fetch(`${adminUrl}/deployments`)).ok, "owned Restate");
  const evidence = new EvidenceStore(pool, objects); let providerCalls = 0;
  const fixtureFetch: typeof fetch = async (url, request) => {
    const body = JSON.parse(String(request?.body)); assert.ok(body.model.endsWith(":free"));
    const messages = body.messages.map((message: { content?: string }) => message.content ?? "").join("\n");
    assert.ok(messages.includes("Harbor fixture opens at nine."), "Model must receive actual approved source evidence");
    const label = messages.match(/E[a-f0-9]{32}/)?.[0]; assert.ok(label, "Model must receive an actual native evidence citation"); providerCalls++;
    if (realModel) return fetch(url, request);
    return Response.json({ id: "deterministic-harbor-fixture", choices: [{ finish_reason: "stop", message: { role: "assistant", content: `Harbor fixture opens at nine. [${label}]` } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  worker = createServer(createEndpointHandler({ services: [createBusinessWorkflow(pool, { openRouterApiKey: modelKey, fetch: fixtureFetch, evidence, knowledgeRuntime: new KnowledgeRuntime(pool, evidence), signal: abort.signal })] }));
  worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  await new Promise<void>(resolve => worker!.listen(0, "0.0.0.0", resolve));
  const workerPort = (worker.address() as { port: number }).port;
  const registration = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${workerPort}`, use_http_11: false }) });
  assert.ok(registration.ok, `Worker registration status ${registration.status}`);
  dispatcher = startDispatcher(pool, { ingressUrl, adminUrl });
  const preparedScope = join(privateDirectory, "scope.json");
  await writeFile(preparedScope, JSON.stringify({ schema_version: "kasitek-prepared-scope.v1", scope_id: randomUUID(), origin, organization_id: organization.id, agent_id: agent.id, version_id: version.id,
    session_cookie_env: "KASITEK_EVALUATION_SESSION", cookie_name: "agents_session", composition_digest: version.effective_composition.digest, expires_at: new Date(Date.now() + 600000).toISOString(), max_tokens: 16384, isolation: "operator-provisioned-per-trial" }), { mode: 0o600 });
  const adapter = join(root, "products/agents/evaluation-adapters/harbor"), jobs = join(build, "jobs");
  harbor = spawn(process.env.AGENTS_HARBOR_BINARY ?? "/home/enock/.local/share/uv/tools/harbor/bin/harbor", ["run", "--path", join(adapter, "suites/faq-grounded"), "--agent", "kasitek_harbor.agent:KasitekAgent", "--agent-kwarg", `scope_path=${preparedScope}`, "--agent-kwarg", "root_token_limit=8192", "--n-concurrent", "1", "--max-retries", "0", "--jobs-dir", jobs, "--job-name", "native-faq", "--quiet"],
    { cwd: root, stdio: "inherit", env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, DOCKER_HOST: process.env.DOCKER_HOST, PYTHONPATH: join(adapter, "src"), KASITEK_EVALUATION_SESSION: session.token } });
  const timeout = setTimeout(() => harbor?.kill("SIGTERM"), 180000);
  const [exitCode] = await once(harbor, "exit"); clearTimeout(timeout); assert.equal(exitCode, 0, "Harbor job failed");
  const files = await readdir(jobs, { recursive: true });
  const rewards = files.filter(path => path.endsWith("/verifier/reward.json")); assert.equal(rewards.length, 1);
  const reward = JSON.parse(await readFile(join(jobs, rewards[0]!), "utf8")); assert.equal(reward.grounded_faq, 1);
  const tasks = (await pool.query("SELECT state,evaluation_trial_id FROM agents_platform.tasks")).rows; assert.equal(tasks.length, 1); assert.equal(tasks[0]!.state, "completed"); assert.ok(tasks[0]!.evaluation_trial_id);
  const trials = (await pool.query("SELECT state FROM agents_platform.evaluation_trials")).rows; assert.equal(trials.length, 1); assert.equal(trials[0]!.state, "revoked");
  assert.equal(providerCalls, 1);
  await writeFile(join(build, "acceptance.json"), JSON.stringify({ status: "passed", modelMode: realModel ? "approved-free-model" : "deterministic-provider-fixture", harborVersion: "0.24.0", restateVersion: "1.7.13", reward, taskCount: tasks.length, providerCalls, compositionDigest: version.effective_composition.digest, sourceRevisionId: source.id, ownerServicesChanged: false }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidence: "actual Harbor trial + verifier + native HTTP/PostgreSQL/Restate", modelMode: realModel ? "approved-free-model" : "deterministic-provider-fixture", reward, providerCalls, proof: join(build, "acceptance.json") }));
}
async function cleanup() {
  await stop(harbor); abort.abort(); await dispatcher?.stop(); await app?.close();
  for (const session of sessions) session.destroy();
  if (worker) await new Promise<void>(resolve => worker!.close(() => resolve()));
  await stop(storage); await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end(); }
  if (ownedRuntime) docker("rm", "-f", containerName);
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
}
main().catch(error => { console.error(JSON.stringify({ evidence: "Harbor acceptance failed", failure: error?.constructor?.name ?? "Error", message: String(error?.message ?? "").replace(/postgres(?:ql)?:\/\/\S+/g, "[database URL withheld]") })); process.exitCode = 1; }).finally(cleanup);
