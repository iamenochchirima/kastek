import { connectFixtureModel, fixtureModelProviders } from "./model-fixture";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { createModelFetch, type ModelFetch } from "../src/infrastructure/model-network";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as httpServer } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const enabled = process.env.AGENTS_INBOX_BROWSER === "1" && process.env.AGENTS_TEST_DATABASE_URL;
(enabled ? describe : describe.skip)("actual website/Inbox browser with PostgreSQL, Restate and HTTP model fixture", () => {
  const requireModule = createRequire(__filename), { chromium, expect: browserExpect } = requireModule(process.env.AGENTS_PLAYWRIGHT_MODULE || "../../web/node_modules/@playwright/test");
  const root = resolve(__dirname, "../../../.."), database = `agents_inbox_browser_${randomUUID().replaceAll("-", "")}`, container = `agents-inbox-browser-${randomUUID()}`;
  let admin: Pool, pool: Pool, app: Awaited<ReturnType<typeof buildPlatformApp>>, frontend: ChildProcess, browser: any, staff: any, visitor: any, widget: any, model: ReturnType<typeof httpServer>, worker: ReturnType<typeof createServer>;
  let endpoint = "", origin = "", ingress = "", restateAdmin = "", started = false, interval: NodeJS.Timeout | undefined, dispatching = false;
  let releaseFirst: (() => void) | undefined, modelCalls = 0, modelInputs: any[] = [], providerFailure: unknown;
  const sessions = new Set<ServerHttp2Session>();
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
  const artifact = resolve(root, ".audit/customer-inbox-browser");
  async function eventually(check: () => Promise<boolean>, timeout = 25_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error("Inbox fixture condition timed out"); }
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL }); await admin.query(`CREATE DATABASE "${database}"`);
    const compiled = process.env.AGENTS_INBOX_COMPILED_DIR;
    const initialize: typeof setupPlatformSchema = compiled ? requireModule(resolve(compiled, "composition/setup.js")).setupPlatformSchema : setupPlatformSchema;
    const buildApp: typeof buildPlatformApp = compiled ? requireModule(resolve(compiled, "composition/app.js")).buildPlatformApp : buildPlatformApp;
    const createWorkflow: typeof createBusinessWorkflow = compiled ? requireModule(resolve(compiled, "execution/business/business.js")).createBusinessWorkflow : createBusinessWorkflow;
    const endpointHandler: typeof createEndpointHandler = compiled ? requireModule("@restatedev/restate-sdk").createEndpointHandler : createEndpointHandler;
    const url = new URL(process.env.AGENTS_TEST_DATABASE_URL!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href, max: 16, statement_timeout: 12_000 }); await initialize(pool);
    const reserve = httpServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve)); const frontendPort = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve())); origin = `http://127.0.0.1:${frontendPort}`;
    model = httpServer(async (request, response) => { try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); modelInputs.push(JSON.parse(Buffer.concat(chunks).toString())); modelCalls++;
      if (modelCalls === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ id: `inbox-fixture-${modelCalls}`, model: modelInputs.at(-1).model, choices: [{ index: 0, finish_reason: "stop", delta: { role: "assistant", content: modelCalls === 1 ? "LATE AUTOMATED REPLY" : "We received your update after support helped." } }], usage: { prompt_tokens: 52, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { providerFailure = error; response.writeHead(500).end(); } });
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve)); const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: url.href, AGENTS_PUBLIC_URL: origin, AGENTS_OIDC_ISSUER_URL: "https://inbox-identity.test", AGENTS_OIDC_CLIENT_SECRET: "isolated-inbox-browser-offline-secret", OPENROUTER_API_KEY: "local-http-fixture-never-provider" });
    app = await buildApp({ config, pool, logging: false }); endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    const workflow = createWorkflow(pool, { modelProvider: fixtureModelProviders(pool), modelRuntime: {
      dispatch: input => dispatchBoundModel(input, policy => {
        const destination = new URL(modelUrl);
        const physical = createModelFetch({ ...policy, authorizeUrl: url => url.href === destination.href, testLoopback: true });
        const network = (async (url, init) => {
          if (!policy.authorizeUrl(new URL(String(url)))) throw Error("Model fixture destination denied");
          return physical(destination, init);
        }) as ModelFetch;
        network.markProgress = physical.markProgress;
        return network;
      }),
    } });
    worker = createServer(endpointHandler({ services: [workflow] })); worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => worker.listen(0, "0.0.0.0", resolve));
    docker("run", "-d", "--name", container, "--cpus", "2", "--memory", "768m", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13"); started = true;
    ingress = `http://${docker("port", container, "8080/tcp")}`; restateAdmin = `http://${docker("port", container, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${restateAdmin}/health`)).ok; } catch { return false; } });
    const registration = await fetch(`${restateAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${(worker.address() as { port: number }).port}`, force: false }) }); expect(registration.ok).toBe(true);
    interval = setInterval(() => { if (dispatching) return; dispatching = true; void dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restateAdmin }).catch(error => { providerFailure = error; }).finally(() => { dispatching = false; }); }, 150);
    const env = { ...process.env, AGENTS_API_PROXY_TARGET: endpoint }; delete env.OPENROUTER_API_KEY;
    frontend = spawn(process.execPath, [resolve(root, "products/agents/web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(frontendPort)], { cwd: resolve(root, "products/agents/web"), env, stdio: "ignore" });
    await eventually(async () => { try { return (await fetch(origin)).ok; } catch { return false; } });
    browser = await chromium.launch({ headless: true }); await mkdir(artifact, { recursive: true });
  }, 90_000);
  afterAll(async () => {
    releaseFirst?.(); if (interval) clearInterval(interval); await browser?.close(); if (frontend && frontend.exitCode === null) frontend.kill("SIGTERM");
    for (const session of sessions) session.destroy(); if (worker) await new Promise<void>(resolve => worker.close(() => resolve())); if (model) await new Promise<void>(resolve => model.close(() => resolve()));
    if (started) docker("rm", "-f", container); await app?.close(); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); }
  }, 30_000);
  afterEach(async context => { if (context.task.result?.state === "fail") for (const [name, page] of [["visitor", visitor], ["staff", staff], ["widget", widget]] as const) if (page && !page.isClosed()) { await page.screenshot({ path: resolve(artifact, `${name}-failure.png`), fullPage: true }); console.error(`${name} fixture page: ${(await page.locator("body").innerText()).slice(0, 2000)}`); } });
  it("persists customer follow-up through the browser and owned API", async () => {
    const platform = new PlatformStore(pool);
    const account = await platform.ensureAccount({ issuer: "https://inbox-identity.test", subject: randomUUID(), email: "records@inbox.test", displayName: "Records operator" });
    const org = await platform.createOrganization(account.id, "Customer records verification");
    const session = await platform.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      await context.addCookies([{ name: "agents_session", value: session.token, url: origin }]);
      staff = await context.newPage();
      let networkChanged = false;
      staff.on("requestfailed", (request: any) => { if (request.failure()?.errorText === "net::ERR_NETWORK_CHANGED") networkChanged = true; });
      await staff.goto(`${origin}/app/customers`);
      const add = staff.getByRole("button", { name: "Add enquiry", exact: true });
      try { await browserExpect(add).toBeVisible({ timeout: 5000 }); }
      catch (error) { if (!networkChanged) throw error; await staff.reload(); await browserExpect(add).toBeVisible({ timeout: 5000 }); }
      await add.click();
      const editor = staff.getByRole("dialog", { name: "Add enquiry" });
      await editor.getByLabel("Name", { exact: true }).fill("Fixture customer");
      await editor.getByLabel("Message", { exact: true }).fill("Needs a follow-up");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await staff.getByRole("link", { name: /Fixture customer · New/ }).click();
      await staff.getByLabel("Enquiry status", { exact: true }).selectOption("in_progress");
      await staff.getByLabel("Internal note", { exact: true }).fill("Call next week");
      await staff.getByRole("button", { name: "Add note", exact: true }).click();
      await browserExpect(staff.getByText("Call next week", { exact: true })).toBeVisible();
      const rows = (await pool.query("SELECT id, status, fields, assignee_account_id FROM agents_platform.customer_record_enquiries WHERE organization_id=$1", [org.id])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "in_progress", fields: { name: "Fixture customer", message: "Needs a follow-up" }, assignee_account_id: account.id });
      const notes = (await pool.query("SELECT body, actor_account_id FROM agents_platform.customer_record_activity WHERE enquiry_id=$1 AND kind='note'", [rows[0].id])).rows;
      expect(notes).toEqual([{ body: "Call next week", actor_account_id: account.id }]);
      await staff.reload();
      await browserExpect(staff.getByLabel("Enquiry status", { exact: true })).toHaveValue("in_progress");
      await browserExpect(staff.getByText("Call next week", { exact: true })).toBeVisible();
    } catch (error) {
      if (staff && !staff.isClosed()) { await staff.screenshot({ path: resolve(artifact, "customer-follow-up-failure.png"), fullPage: true }); console.error("Customer fixture page:", (await staff.locator("body").innerText()).slice(0, 2000)); }
      throw error;
    } finally { await context.close(); }
  }, 30_000);
  it("takes over active work, delivers a human reply, returns on new input and recovers browser views", async () => {
    const platform = new PlatformStore(pool), account = await platform.ensureAccount({ issuer: "https://inbox-identity.test", subject: randomUUID(), email: "operator@inbox.test", displayName: "Support operator" });
    const org = await platform.createOrganization(account.id, "Customer Inbox verification"), scope = { accountId: account.id, organizationId: org.id };
    await connectFixtureModel(pool, account.id, org.id);
    const configuration = defaultBusinessConfiguration(); configuration.program = { id: "grounded-conversation", version: "1" }; configuration.tools = [];
    const agent = await platform.createAgent({ ...scope, name: "Website support", configuration }), version = await platform.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    const deployment = await platform.publishWebsite({ ...scope, agentId: agent.id, versionId: version.id, allowedOrigins: [origin] });
    const session = await platform.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
    const staffContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await staffContext.addCookies([{ name: "agents_session", value: session.token, url: origin }]); staff = await staffContext.newPage();
    const visitorContext = await browser.newContext({ viewport: { width: 768, height: 1000 } }); visitor = await visitorContext.newPage();
    visitor.on("pageerror", (error: Error) => console.error("Visitor browser error:", error.message));
    visitor.on("console", (entry: any) => { if (entry.type() === "error") console.error("Visitor console:", entry.text().slice(0, 600)); });
    let visitorNetworkChanged=false;
    visitor.on("requestfailed", (request: any) => { if(request.failure()?.errorText==="net::ERR_NETWORK_CHANGED")visitorNetworkChanged=true; console.error("Visitor request failed:", new URL(request.url()).pathname, request.failure()); });
    visitor.on("response", (response: any) => { if (response.status() >= 400) console.error("Visitor HTTP failure:", new URL(response.url()).pathname, response.status()); });
    await visitor.goto(`${origin}/chat/${deployment.id}`);
    const visitorInput=visitor.getByRole("textbox", { name: "Message", exact: true });
    try { await browserExpect(visitorInput).toBeVisible({timeout:5000}); }
    catch(error) { if(!visitorNetworkChanged)throw error; await visitor.reload(); await browserExpect(visitorInput).toBeVisible({timeout:5000}); }
    await visitorInput.fill("Can you help with my account?"); await visitor.getByRole("button", { name: "Send message", exact: true }).click();
    await eventually(async () => modelCalls === 1); await staff.goto(`${origin}/app/inbox`); await staff.getByRole("button", { name: /Website support/ }).click();
    await staff.getByRole("button", { name: "Assign to me", exact: true }).click(); await staff.getByRole("button", { name: "Take over", exact: true }).click();
    await staff.getByRole("textbox", { name: "Reply to customer", exact: true }).fill("I handled your account request. Support is here."); await staff.getByRole("button", { name: "Send reply", exact: true }).click();
    await browserExpect(visitor.getByText("I handled your account request. Support is here.", { exact: true })).toBeVisible(); releaseFirst?.();
    await eventually(async () => Boolean((await pool.query("SELECT 1 FROM agents_platform.customer_deliveries WHERE state='suppressed'")).rowCount));
    await browserExpect(visitor.getByText("LATE AUTOMATED REPLY", { exact: true })).toHaveCount(0);
    const before = Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [org.id])).rows[0].count);
    await visitor.getByRole("textbox", { name: "Message", exact: true }).fill("This message belongs to support while you own the conversation."); await visitor.getByRole("button", { name: "Send message", exact: true }).click();
    await browserExpect(staff.getByText("This message belongs to support while you own the conversation.", { exact: true })).toBeVisible(); expect(Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [org.id])).rows[0].count)).toBe(before);
    await staff.getByRole("button", { name: "Return to automation", exact: true }).click();
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [org.id])).rows[0].count)).toBe(before);
    await visitor.getByRole("textbox", { name: "Message", exact: true }).fill("A new question after the handoff."); await visitor.getByRole("button", { name: "Send message", exact: true }).click();
    await browserExpect(visitor.getByText("We received your update after support helped.", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(modelCalls).toBe(2); expect(JSON.stringify(modelInputs[1])).toContain("I handled your account request. Support is here.");
    await visitor.reload(); await browserExpect(visitor.getByText("I handled your account request. Support is here.", { exact: true })).toBeVisible(); await browserExpect(visitor.getByText("We received your update after support helped.", { exact: true })).toBeVisible();
    for (const width of [1440, 768, 390]) { await staff.setViewportSize({ width, height: 1000 }); await browserExpect(staff.getByRole("heading", { name: "Customer", exact: true })).toBeVisible(); expect(await staff.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await staff.screenshot({ path: resolve(artifact, `inbox-${width}.png`), fullPage: true }); }
    expect(providerFailure).toBeUndefined();
    const messages = (await pool.query("SELECT author_kind,body FROM agents_platform.customer_messages ORDER BY conversation_id,sequence")).rows; expect(messages.filter(row => row.author_kind === "human")).toHaveLength(1); expect(messages.some(row => row.body === "LATE AUTOMATED REPLY")).toBe(false);
    const widgetContext = await browser.newContext({ viewport: { width: 390, height: 844 } }); widget = await widgetContext.newPage();
    await widget.goto(origin); await widget.addScriptTag({ url: `${origin}/api/website/${deployment.id}/widget.js` }); await widget.getByRole("button", { name: "Chat", exact: true }).click();
    await browserExpect(widget.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const widgetConversation = (await pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1", [org.id])).rows[0].id;
    const commandUrl = `${origin}/api/organizations/${org.id}/inbox/${widgetConversation}/commands`;
    async function widgetCommand(action: string, body?: string) {
      const read = await staff.request.get(`${origin}/api/organizations/${org.id}/inbox/${widgetConversation}`); expect(read.status()).toBe(200);
      const detail = await read.json(), response = await staff.request.post(commandUrl, { headers: { origin }, data: { commandId: randomUUID(), expectedRevision: detail.conversation.revision, action, ...(body ? { body } : {}) } }); expect(response.status()).toBe(200);
    }
    await widgetCommand("claim"); await widgetCommand("takeover");
    let lostAcknowledgement = false;
    await widget.route("**/customer-conversations/*/messages", async (route: any) => {
      if (route.request().method() === "POST" && !lostAcknowledgement) { lostAcknowledgement = true; await route.fetch(); await route.abort("failed"); } else await route.continue();
    });
    await widget.getByRole("textbox", { name: "Message", exact: true }).fill("Hello support through the embedded widget"); await widget.getByRole("button", { name: "Send", exact: true }).click();
    await browserExpect(widget.getByRole("button", { name: "Retry message", exact: true })).toBeVisible(); await widget.getByRole("button", { name: "Retry message", exact: true }).click();
    await browserExpect(widget.getByRole("log").getByText("Hello support through the embedded widget")).toBeVisible();
    expect((await pool.query("SELECT count(*) FROM agents_platform.customer_messages WHERE conversation_id=$1 AND author_kind='visitor'", [widgetConversation])).rows[0].count).toBe("1");
    await widgetCommand("reply", "Support replied through the real website channel"); await browserExpect(widget.getByRole("log").getByText("Support replied through the real website channel")).toBeVisible();
    await widget.reload(); await widget.addScriptTag({ url: `${origin}/api/website/${deployment.id}/widget.js` }); await widget.getByRole("button", { name: "Chat", exact: true }).click();
    await browserExpect(widget.getByRole("log").getByText("Support replied through the real website channel")).toBeVisible(); expect(modelCalls).toBe(2);
    await widget.screenshot({ path: resolve(artifact, "widget-390.png"), fullPage: true }); await widgetContext.close();
    await staffContext.close(); await visitorContext.close();
  }, 90_000);
});
