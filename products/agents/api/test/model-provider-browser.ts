import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createServer as createWorker, type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { connectionVaultFromEnvironment } from "../src/infrastructure/vault";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { createModelFetch, type ModelFetch } from "../src/infrastructure/model-network";
import { ModelProviderStore } from "../src/product/model-providers/store";
import { probeProviderModel } from "../src/product/model-providers/probe";
import { PlatformStore } from "../src/product/agents/store";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { EvidenceStore } from "../src/execution/context/evidence";
import { KnowledgeRuntime } from "../src/capabilities/knowledge/knowledge-runtime";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const root = resolve(__dirname, "../../../.."), web = resolve(root, "products/agents/web");
const evidenceDirectory = resolve(root, ".audit/model-provider-actual-browser");
const viteConfig = resolve(evidenceDirectory, "vite.config.mts");
const live = process.env.AGENTS_LIVE_MODEL_ACCEPTANCE === "1";
const image = "docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742";
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + (label === "live model/tool completion" ? 120_000 : 30_000);
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timed out: ${label}`);
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit"); child.kill("SIGTERM"); await done;
}
async function main() {
  assert.ok(process.env.AGENTS_TEST_DATABASE_URL, "An isolated PostgreSQL administrator connection is required");
  if (live) assert.ok(process.env.OPENROUTER_API_KEY, "Live acceptance requires an explicitly approved OpenRouter key");
  const databaseName = `agents_model_browser_${randomUUID().replaceAll("-", "")}`;
  const container = `agents-model-browser-${randomUUID()}`;
  const admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL });
  let pool: Pool | undefined, app: Awaited<ReturnType<typeof buildPlatformApp>> | undefined;
  let frontend: ChildProcess | undefined, browser: any, activePage: any, timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<unknown> | undefined, started = false, created = false;
  const sessions = new Set<ServerHttp2Session>();
  const worker = createWorker();
  const calls: Array<{ model: string; credential: string; tools: boolean }> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push({ model: body.model, credential: request.headers.authorization ?? "", tools: Boolean(body.tools?.length) });
      const user = body.messages.findLastIndex((message: any) => message.role === "user");
      const hasResult = body.messages.slice(user).some((message: any) => message.role === "tool");
      const setup = body.tools?.find((tool: any) => tool.function.name === "setup_echo");
      const search = body.tools?.find((tool: any) => tool.function.name === "knowledge_search");
      const tool = !hasResult && (setup ?? search);
      const args = setup ? { token: setup.function.parameters.properties.token.const } : { query: "opening hours" };
      const priorToken = body.messages.findLast((message: any) => message.role === "tool")?.content;
      const content = setup ? String(priorToken ?? "") : body.messages[user]?.content === "Reply with only OK." ? "OK" : `Configured ${body.model} answered.`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "controlled-response", model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", ...(tool ? { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }] } : { content }) }, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const database = new URL(process.env.AGENTS_TEST_DATABASE_URL); database.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: database.href }); await setupPlatformSchema(pool);
    Object.assign(process.env, { NODE_ENV: "test", OTEL_SDK_DISABLED: "true", AGENTS_CONNECTION_ACTIVE_KEY: "model-browser",
      AGENTS_CONNECTION_KEYS: JSON.stringify({ "model-browser": randomBytes(32).toString("base64") }) });
    const apiPort = await freePort(), frontendPort = await freePort(), workerPort = await freePort();
    const origin = `http://127.0.0.1:${frontendPort}`;
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const options: ConstructorParameters<typeof ModelProviderStore>[3] = {
      discoveryFetch: async () => ({ status: 200, body: JSON.stringify({ data: ["fixture/a", "fixture/b"].map(id => ({ id, name: id,
        context_length: 65536, top_provider: { max_completion_tokens: 8192 }, supported_parameters: ["tools"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } })) }) }),
      probe: input => probeProviderModel({ ...input, endpoint: `${providerOrigin}/v1` }, { testLoopback: true }),
    };
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: database.href, AGENTS_PUBLIC_URL: origin,
      AGENTS_OIDC_ISSUER_URL: "http://127.0.0.1:8080/realms/model-browser", AGENTS_OIDC_CLIENT_SECRET: randomBytes(32).toString("base64url") });
    await assert.rejects(buildPlatformApp({ config: { ...config, NODE_ENV: "production" }, pool, testModelProviderOptions: options }), /TEST_MODEL_OPTIONS_DENIED/);
    app = await buildPlatformApp({ config, pool, logging: false, testModelProviderOptions: options });
    const platform = new PlatformStore(pool);
    const account = await platform.ensureAccount({ issuer: config.AGENTS_OIDC_ISSUER_URL, subject: randomUUID(), email: "model-browser@example.test", displayName: "Provider owner" });
    const organization = await platform.createOrganization(account.id, "Provider browser");
    const scope = { accountId: account.id, organizationId: organization.id };
    const session = await platform.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
    const models = new ModelProviderStore(pool, new ModelCredentialVault(connectionVaultFromEnvironment()!), undefined, options);
    const network: Parameters<typeof dispatchBoundModel>[1] = policy => {
      if (live) return createModelFetch(policy);
      const target = new URL(`${providerOrigin}/v1/chat/completions`);
      const actual = createModelFetch({ ...policy, authorizeUrl: url => url.href === target.href, testLoopback: true });
      const send = (async (url, init) => { assert.ok(policy.authorizeUrl(new URL(String(url)))); return actual(target, init); }) as ModelFetch;
      send.markProgress = actual.markProgress; return send;
    };
    const evidence = new EvidenceStore(pool);
    const workflow = createBusinessWorkflow(pool, { modelProvider: models, evidence, knowledgeRuntime: new KnowledgeRuntime(pool, evidence),
      modelRuntime: { dispatch: input => dispatchBoundModel(input, network) } });
    worker.on("request", createEndpointHandler({ services: [workflow] }));
    worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => worker.listen(workerPort, "0.0.0.0", resolve));
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
    docker("run", "-d", "--name", container, "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", image); started = true;
    const ingressUrl = `http://${docker("port", container, "8080/tcp")}`, adminUrl = `http://${docker("port", container, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${adminUrl}/health`)).ok; } catch { return false; } }, "Restate startup");
    assert.ok((await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${workerPort}`, force: false }) })).ok);
    const activePool = pool;
    timer = setInterval(() => { if (!pending) pending = dispatchTasksOnce(activePool, { ingressUrl, adminUrl }).finally(() => { pending = undefined; }); }, 100);
    await app.listen({ host: "127.0.0.1", port: apiPort });
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(viteConfig, `import base from ${JSON.stringify(resolve(web, "vite.config.ts"))};
export default env => ({...base(env),cacheDir:${JSON.stringify(resolve(evidenceDirectory, "node_modules/.vite-cache"))}});
`);
    frontend = spawn(process.execPath, [resolve(web, "node_modules/vite/bin/vite.js"), "--config", viteConfig, "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
      cwd: web, env: { ...process.env, AGENTS_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: ["ignore", "ignore", "pipe"] });
    frontend.stderr?.on("data", chunk => process.stderr.write(chunk));
    await eventually(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "frontend startup");
    const { chromium } = require(resolve(web, "node_modules/@playwright/test"));
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: "agents_session", value: session.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const page = activePage = await context.newPage(); page.setDefaultTimeout(45_000);
    const errors: string[] = []; page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("Browser error", error.message); });
    page.on("console", (message: any) => { if (message.type() === "error") console.error("Browser console", message.text().slice(0, 300)); });
    page.on("requestfailed", (request: any) => console.error("Browser transport", new URL(request.url()).pathname, request.failure()?.errorText));
    if (live) {
      const liveModels = new ModelProviderStore(pool, new ModelCredentialVault(connectionVaultFromEnvironment()!));
      const connection = await liveModels.create(scope, { providerId: "openrouter", name: "Approved live account", apiKey: process.env.OPENROUTER_API_KEY });
      const catalogue = await liveModels.refreshModels(scope, connection.id, connection.revision);
      const modelId = process.env.AGENTS_LIVE_MODEL_ID;
      assert.ok(modelId, "Choose the exact live model explicitly with AGENTS_LIVE_MODEL_ID");
      const model = catalogue.models.find(model => model.id === modelId);
      assert.ok(model, "The approved exact live model must be present in the real provider catalogue");
      const configuration = defaultBusinessConfiguration();
      configuration.model.selection = { kind: "connection", connectionId: connection.id, modelId };
      configuration.model.maxOutputTokens = 4096;
      if (model.reasoningOptions?.efforts.includes("low")) configuration.model.generation = { reasoning: { kind: "effort", value: "low" } };
      configuration.instructions = "Call knowledge_search exactly once before replying to each user question. Use the tool result. If it has no approved passages, explain that no approved information is available. Do not invent opening hours or facts. Keep the final answer to one sentence.";
      configuration.tools = ["knowledge.search"];
      const created = await platform.createConfiguredAgent({ ...scope, name: "Live provider acceptance", configuration });
      await page.goto(`${origin}/app/agents/${created.agent.id}`);
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("What are your opening hours? Search approved knowledge before answering.");
      const submission = page.waitForResponse((response: any) => response.url().endsWith("/tasks") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const submitted = await submission; assert.equal(submitted.status(), 202);
      const taskId = (await submitted.json()).task.id;
      let result: any;
      await eventually(async () => {
        result = (await activePool.query("SELECT state,error_code,output FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
        if (["failed", "incomplete", "uncertain", "cancelled"].includes(result.state)) throw Error(`Live provider acceptance: ${result.error_code}`);
        return result.state === "completed";
      }, "live model/tool completion");
      assert.ok(result.output?.trim());
      await page.getByText(result.output, { exact: true }).last().waitFor();
      const tools = (await activePool.query("SELECT name,state FROM agents_platform.operations WHERE task_id=$1 AND kind='tool'", [taskId])).rows;
      assert.deepEqual(tools, [{ name: "knowledge.search", state: "completed" }]);
      const receipts = (await activePool.query("SELECT model_identity,input_count FROM agents_platform.private_model_continuations WHERE task_id=$1 AND state='completed' ORDER BY created_at", [taskId])).rows;
      assert.equal(receipts.length, 2); assert.ok(receipts.every(row => row.model_identity.requestedModelId === modelId));
      assert.deepEqual(errors, []);
      await mkdir(evidenceDirectory, { recursive: true });
      await page.screenshot({ path: resolve(evidenceDirectory, "live-configured-chat.png"), fullPage: true });
      await writeFile(resolve(evidenceDirectory, "live-acceptance.json"), JSON.stringify({ status: "passed", mode: "approved live OpenRouter + actual PostgreSQL/Restate/API/browser",
        modelId, adapterRevision: "2", taskState: result.state, actualToolOperations: tools, physicalModelCalls: receipts.length,
        inputCountPrecisions: receipts.map(row => row.input_count.precision), modelIdentities: receipts.map(row => row.model_identity),
        credentialsUnavailable: ["openai", "anthropic", "google", "xai", "deepseek", "mistral", "groq", "together", "fireworks", "moonshot", "zai"] }, null, 2));
      console.log("Approved live OpenRouter browser acceptance passed: configured chat, actual knowledge tool and two physical model receipts.");
      return;
    }
    await page.goto(`${origin}/app/settings`);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    console.log("Provider browser: authenticated owner setup");
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Search providers").fill("OpenRouter");
    await dialog.getByRole("button", { name: "OpenRouter", exact: true }).click();
    await dialog.getByLabel("Connection name").fill("Browser account");
    await dialog.getByLabel("API key", { exact: true }).fill("browser-fixture-key");
    await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
    await page.getByRole("heading", { name: "Browser account", exact: true }).waitFor();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Models", exact: true });
    await dialog.getByRole("button", { name: "Refresh models", exact: true }).click();
    await dialog.getByLabel("Model ID", { exact: true }).fill("fixture/a");
    await dialog.getByLabel("Test tool support", { exact: true }).check();
    await dialog.getByRole("button", { name: "Test model", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Run test", exact: true }).click();
    await dialog.getByText(/^Tools tested/).waitFor();
    console.log("Provider browser: native tool probe passed");
    await dialog.getByRole("button", { name: "Set default", exact: true }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    const connection = (await models.list(scope))[0]!;
    const agentResponse = await page.request.post(`${origin}/api/organizations/${organization.id}/agents`, { headers: { Origin: origin }, data: { name: "Provider journey", offering: "customer-service" } });
    assert.equal(agentResponse.status(), 201);
    const agent = (await agentResponse.json()).agent;
    await page.goto(`${origin}/app/agents/${agent.id}?section=configuration`);
    await page.getByLabel("Agent model", { exact: true }).selectOption(JSON.stringify({ kind: "connection", connectionId: connection.id, modelId: "fixture/a" }));
    async function save() {
      const response = page.waitForResponse((response: any) => response.url().endsWith("/configuration") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      if ((await response).status() === 409) await page.getByRole("alertdialog").getByRole("button", { name: "Apply changes", exact: true }).click();
      await eventually(() => page.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), "background snapshot save");
    }
    await save();
    async function chat(model: string, message: string) {
      await page.goto(`${origin}/app/agents/${agent.id}`);
      await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
      const submitted = page.waitForResponse((response: any) => response.url().endsWith("/tasks") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const accepted = await submitted; assert.equal(accepted.status(), 202);
      const task = (await accepted.json()).task;
      await eventually(async () => {
        const current = await page.request.get(`${origin}/api/organizations/${organization.id}/tasks/${task.id}`);
        const result = (await current.json()).task;
        if (["failed", "incomplete", "uncertain", "cancelled"].includes(result?.state)) throw Error(`Configured chat failed: ${result.errorCode}`);
        return result?.state === "completed";
      }, "configured chat completion");
      await page.getByText(`Configured ${model} answered.`, { exact: true }).last().waitFor({ timeout: 30_000 });
    }
    await chat("fixture/a", "Search the approved knowledge once.");
    console.log("Provider browser: initial configured chat passed");
    await page.goto(`${origin}/app/agents/${agent.id}?section=configuration`);
    await page.getByLabel("Agent model", { exact: true }).selectOption(JSON.stringify({ kind: "connection", connectionId: connection.id, modelId: "fixture/b" }));
    await save();
    await chat("fixture/b", "Search after switching models.");
    console.log("Provider browser: model switch passed");
    await page.goto(`${origin}/app/settings`);
    await page.getByRole("button", { name: "Edit key", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Replacement API key", { exact: true }).fill("browser-rotated-key");
    await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
    await page.getByRole("heading", { name: "Browser account", exact: true }).waitFor();
    // Rotation invalidates the credential-generation catalogue; refresh explicitly before new work.
    await page.getByRole("button", { name: "Models", exact: true }).click(); dialog = page.getByRole("dialog", { name: "Models", exact: true });
    await dialog.getByRole("button", { name: "Refresh models", exact: true }).click();
    await dialog.getByRole("button", { name: "fixture/b", exact: false }).first().waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await chat("fixture/b", "Search after rotating the account key.");
    assert.ok(calls.some(call => call.credential === "Bearer browser-rotated-key"));
    const beforeRevocation = calls.length;
    await page.goto(`${origin}/app/settings`); await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("dialog", { name: "Affected agents", exact: true }).getByRole("button", { name: "Revoke key", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke key", exact: true }).click();
    await page.goto(`${origin}/app/agents/${agent.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("This must not reach the revoked account.");
    const denied = page.waitForResponse((response: any) => response.url().endsWith("/tasks") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    assert.equal((await denied).status(), 409);
    await page.getByRole("alert").first().waitFor();
    assert.equal(calls.length, beforeRevocation);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes("browser-fixture-key") || value.includes("browser-rotated-key"))), false);
    const tasks = (await pool.query("SELECT t.state,r.routes->'primary'->'binding'->>'modelId' AS model FROM agents_platform.tasks t JOIN agents_platform.task_model_routes r ON r.task_id=t.id ORDER BY t.created_at")).rows;
    assert.deepEqual(tasks.map(task => task.model), ["fixture/a", "fixture/b", "fixture/b"]);
    assert.ok(tasks.every(task => task.state === "completed"));
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM agents_platform.operations WHERE kind='tool' AND state='completed'")).rows[0].n, 3);
    await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: resolve(evidenceDirectory, "revoked-model.png"), fullPage: true });
    await writeFile(resolve(evidenceDirectory, "acceptance.json"), JSON.stringify({ status: "passed", mode: "controlled real HTTP + PostgreSQL + Restate + browser", tasks, modelCalls: calls.length,
      addProvider: true, toolProbe: true, selectSaveChatToolRound: true, switchModel: true, rotateKey: true, revokeBlocksPhysicalCalls: true, secretsAbsentFromClientStorage: true }, null, 2));
    console.log("Actual API/browser provider journey passed; three completed chat/tool runs and explicit rotation/revocation.");
  } catch (error) {
    if (activePage) {
      await mkdir(evidenceDirectory, { recursive: true });
      await activePage.screenshot({ path: resolve(evidenceDirectory, "failure.png"), fullPage: true });
      console.error("Browser location", new URL(activePage.url()).pathname);
      console.error("Browser status", (await activePage.locator("body").innerText()).slice(0, 600));
    }
    throw error;
  } finally {
    if (timer) clearInterval(timer); await pending;
    await browser?.close(); await stop(frontend); await app?.close();
    await rm(viteConfig, { force: true }); await rm(resolve(evidenceDirectory, "node_modules/.vite-cache"), { recursive: true, force: true });
    for (const session of sessions) session.destroy();
    if (worker.listening) await new Promise<void>(resolve => worker.close(() => resolve()));
    provider.closeAllConnections(); if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
    if (started) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    await pool?.end(); if (created) await dropClosedTestDatabase(admin, databaseName); await admin.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Provider browser acceptance failed"); process.exitCode = 1; });
