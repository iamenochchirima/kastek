import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as httpServer } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { createModelFetch, type ModelFetch } from "../src/infrastructure/model-network";
import { PlatformStore } from "../src/product/agents/store";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { SHARED_HARNESS_RELEASE, SHARED_WORKFLOW_NAME } from "../src/contracts/execution";
import { EvidenceStore } from "../src/execution/context/evidence";
import { KnowledgeRuntime } from "../src/platform/knowledge/knowledge-runtime";
import { connectFixtureModel, fixtureModelProviders } from "./model-fixture";
import { runIndependentClient } from "../../examples/independent-client/client.mjs";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const enabled = process.env.AGENTS_INDEPENDENT_BROWSER === "1" && process.env.AGENTS_TEST_DATABASE_URL;
(enabled ? describe : describe.skip)("independent client and standalone UI", () => {
  const requireModule = createRequire(__filename), { chromium } = requireModule(process.env.AGENTS_PLAYWRIGHT_MODULE || "../../web/node_modules/@playwright/test");
  const root = resolve(__dirname, "../../../.."), database = `agents_independent_browser_${randomUUID().replaceAll("-", "")}`;
  const artifact = resolve(root, ".audit/independent-client-browser"), container = `agents-independent-browser-${randomUUID()}`;
  let admin: Pool, pool: Pool, app: Awaited<ReturnType<typeof buildPlatformApp>>, frontend: ChildProcess | undefined;
  let browser: any, model: ReturnType<typeof httpServer>, worker: ReturnType<typeof createServer>, started = false;
  let endpoint = "", origin = "", ingress = "", restateAdmin = "", dispatching = false, failure: unknown;
  const sessions = new Set<ServerHttp2Session>();
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
  async function freePort() { const server = httpServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
  async function eventually(check: () => Promise<boolean>, timeout = 30_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("fixture condition timed out"); }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.AGENTS_TEST_DATABASE_URL!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href, max: 16, statement_timeout: 12_000 }); await setupPlatformSchema(pool);
    Object.assign(process.env, { NODE_ENV: "test", OTEL_SDK_DISABLED: "true", AGENTS_CONNECTION_ACTIVE_KEY: "independent-browser",
      AGENTS_CONNECTION_KEYS: JSON.stringify({ "independent-browser": randomBytes(32).toString("base64") }) });
    const frontendPort = await freePort(); origin = `http://127.0.0.1:${frontendPort}`;
    model = httpServer(async (request, response) => {
      try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "independent-fixture", model: body.model, choices: [{ index: 0, finish_reason: "stop",
          delta: { role: "assistant", content: "Independent application answer." } }], usage: { prompt_tokens: 40, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`);
      } catch (error) { failure = error; response.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: url.href, AGENTS_PUBLIC_URL: origin,
      AGENTS_OIDC_ISSUER_URL: "https://independent-identity.test", AGENTS_OIDC_CLIENT_SECRET: "isolated-independent-browser-secret",
      OPENROUTER_API_KEY: "local-http-fixture-never-provider" });
    app = await buildPlatformApp({ config, pool, logging: false });
    endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    const evidence = new EvidenceStore(pool);
    const workflow = createBusinessWorkflow(pool, { modelProvider: fixtureModelProviders(pool), evidence,
      knowledgeRuntime: new KnowledgeRuntime(pool, evidence), modelRuntime: { dispatch: input => dispatchBoundModel(input, policy => {
        const destination = new URL(modelUrl), physical = createModelFetch({ ...policy, authorizeUrl: candidate => candidate.href === destination.href, testLoopback: true });
        const network = (async (_url, init) => physical(destination, init)) as ModelFetch;
        network.markProgress = physical.markProgress; return network;
      }) } }, { release: SHARED_HARNESS_RELEASE, workflow: SHARED_WORKFLOW_NAME });
    worker = createServer(createEndpointHandler({ services: [workflow] }));
    worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => worker.listen(0, "0.0.0.0", resolve));
    docker("run", "-d", "--name", container, "--cpus", "2", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway",
      "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13"); started = true;
    ingress = `http://${docker("port", container, "8080/tcp")}`; restateAdmin = `http://${docker("port", container, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${restateAdmin}/health`)).ok; } catch { return false; } });
    expect((await fetch(`${restateAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: `http://host.docker.internal:${(worker.address() as { port: number }).port}`, force: false }) })).ok).toBe(true);
    setInterval(() => { if (dispatching) return; dispatching = true;
      void dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restateAdmin, runtimeRoutes: { [SHARED_HARNESS_RELEASE]: { ingressUrl: ingress, adminUrl: restateAdmin, workflowName: SHARED_WORKFLOW_NAME } } }).catch(error => { failure = error; }).finally(() => { dispatching = false; }); }, 150).unref();
    const environment = { ...process.env, AGENTS_API_PROXY_TARGET: endpoint }; delete environment.OPENROUTER_API_KEY;
    frontend = spawn(process.execPath, [resolve(root, "products/agents/web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(frontendPort)],
      { cwd: resolve(root, "products/agents/web"), env: environment, stdio: "ignore" });
    await eventually(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
    browser = await chromium.launch({ headless: true }); await mkdir(artifact, { recursive: true });
  }, 90_000);
  afterAll(async () => {
    await browser?.close(); if (frontend && frontend.exitCode === null) frontend.kill("SIGTERM");
    for (const session of sessions) session.destroy(); if (worker) await new Promise<void>(resolve => worker.close(() => resolve()));
    if (model) await new Promise<void>(resolve => model.close(() => resolve()));
    if (started) docker("rm", "-f", container); await app?.close(); await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); }
  }, 30_000);

  it("shows the independent client's result and activity in the standalone UI", async () => {
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({ issuer: "https://independent-identity.test", subject: randomUUID(), email: "independent@example.test", displayName: "Independent owner" });
    const organization = await store.createOrganization(account.id, "Independent browser");
    const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
    await connectFixtureModel(pool, account.id, organization.id);
    const cookie = `agents_session=${session.token}`, org = `/api/organizations/${organization.id}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${endpoint}${path}`, { method, headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const seed = await store.createConfiguredAgent({ accountId: account.id, organizationId: organization.id, name: "Application seed" });
    const application = await call("POST", `${org}/applications`, { name: "Independent browser client", agentIds: [seed.agent.id],
      scopes: ["agents:read", "agents:manage", "agents:publish", "runs:start", "runs:read"] });
    const result = await runIndependentClient({ baseUrl: endpoint, credential: application.credential.secret,
      fixtureTool: "channel.request_handoff", agentName: "Independent browser agent", purpose: "Verify the application path.",
      instructions: "Answer briefly.", message: "Report the fixture result.", allowedOrigins: ["https://client.example"],
      pollMs: 250, timeoutMs: 60_000 });
    expect(result.run.state).toBe("completed");
    expect(result.run.output).toContain("Independent application answer.");
    expect(result.activity?.output).toContain("Independent application answer.");
    const taskId = result.run.taskId;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.context().addCookies([{ name: "agents_session", value: session.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(`${origin}/app/tasks/${taskId}`);
    await page.getByRole("heading", { name: "Task activity", exact: true }).waitFor({ state: "visible" });
    await page.getByText("Independent application answer.", { exact: false }).first().waitFor({ state: "visible" });
    const activityText = await page.locator("body").innerText();
    expect(activityText).toContain("Independent application answer.");
    await page.screenshot({ path: resolve(artifact, "independent-client-task.png"), fullPage: true });
    await page.context().close();

  }, 120_000);
});
