import { contextGrantCeiling } from "../src/execution/models/settings";
import {nativeProviderConnectors} from "../src/adapters/providers/connector-registry";
import {connectFixtureModel} from "./model-fixture";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { createBookingOAuthFixture, createBookingProviderFixture, type BookingProviderFixture } from "./booking-fixture";
import { ProviderConnectionStore } from "../src/product/connections/provider-connections";
import { connectionVaultFromEnvironment } from "../src/infrastructure/vault";
import { BookingService } from "../src/workflows/booking/bookings";
import { defaultBusinessConfiguration, type AdmissionAuthority, type ExecutionGrant } from "../src/contracts/contracts";
import { createCatalogueProviderFixture } from "./catalogue-provider-fixture";
import { createCatalogueOAuthFixture } from "./catalogue-oauth-fixture";
import { createCatalogueRuntimeFixture } from "./catalogue-runtime-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const root = resolve(__dirname, "../../../.."), web = resolve(root, "products/agents/web");
const statePath = resolve(root, ".audit/agents-catalogue-browser-state.json");
const origin = "http://127.0.0.1:3197", apiOrigin = "http://127.0.0.1:4197";
const databaseName = `agents_catalogue_browser_${randomUUID().replaceAll("-", "")}`;
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}
async function ready(url: string, child: ChildProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The isolated browser server stopped before it was ready");
    try { if ((await fetch(url)).ok) return; } catch { /* Wait for the fixture listener. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The isolated browser server did not start");
}
async function main() {
  assert.ok(process.env.AGENTS_TEST_DATABASE_URL, "AGENTS_TEST_DATABASE_URL is required");
  let admin: Pool | undefined, pool: Pool | undefined, app: Awaited<ReturnType<typeof buildPlatformApp>> | undefined;
  let provider: BookingProviderFixture | undefined;
  let executionProvider: Awaited<ReturnType<typeof createCatalogueProviderFixture>> | undefined;
  let oauthProvider: Awaited<ReturnType<typeof createCatalogueOAuthFixture>> | undefined;
  let runtime: Awaited<ReturnType<typeof createCatalogueRuntimeFixture>> | undefined;
  let vite: ChildProcess | undefined, browser: ChildProcess | undefined, created = false;
  try {
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL });
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const database = new URL(process.env.AGENTS_TEST_DATABASE_URL); database.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: database.href }); await setupPlatformSchema(pool);
    process.env.NODE_ENV = "test";
    process.env.AGENTS_CURSOR_ACTIVE_KEY_ID = "browser-fixture";
    process.env.AGENTS_CURSOR_KEYS_JSON = JSON.stringify({ "browser-fixture": randomBytes(32).toString("base64url") });
    process.env.AGENTS_CONNECTION_ACTIVE_KEY = "browser-fixture";
    process.env.AGENTS_CONNECTION_KEYS = JSON.stringify({ "browser-fixture": randomBytes(32).toString("base64") });
    if (process.env.AGENTS_CATALOGUE_EXECUTION === "1") {
      executionProvider = await createCatalogueProviderFixture();
      oauthProvider = await createCatalogueOAuthFixture();
      runtime = await createCatalogueRuntimeFixture(pool, database.href, origin, `${executionProvider.base}/model`);
    }
    const config = loadPlatformConfig({ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, NODE_ENV: "test", AGENTS_DATABASE_URL: database.href, AGENTS_PUBLIC_URL: origin,
      AGENTS_OIDC_ISSUER_URL: "http://127.0.0.1:4197/fixture-issuer", AGENTS_CURSOR_ACTIVE_KEY_ID: process.env.AGENTS_CURSOR_ACTIVE_KEY_ID, AGENTS_CURSOR_KEYS_JSON: process.env.AGENTS_CURSOR_KEYS_JSON, AGENTS_OIDC_CLIENT_SECRET: randomBytes(32).toString("base64url") });
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({ issuer: config.AGENTS_OIDC_ISSUER_URL, subject: randomUUID(), email: "catalogue-browser@example.test", displayName: "Catalogue browser" });
    const organization = await store.createOrganization(account.id, "Catalogue acceptance");
    await connectFixtureModel(pool,account.id,organization.id);
    const agent = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Catalogue support", offering: "faq" });
    const otherAgent = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Separate support", offering: "faq" });
    const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
    provider = await createBookingProviderFixture();
    const oauth = createBookingOAuthFixture("https://accounts.fixture.test/authorize");
    const google = new ProviderConnectionStore(pool, connectionVaultFromEnvironment(), { definition:nativeProviderConnectors.find(item=>item.id==="google-calendar")!, oauth, appUrl: origin, testApiBaseUrl: provider.base });
    const scope = { accountId: account.id, organizationId: organization.id };
    const pendingConnection = await google.create(scope, { name: "Operator confirmation calendar", operations:["calendar.availability","calendar.book"] });
    const authorization = await google.authorize(scope, pendingConnection.id);
    await google.complete(account.id, `?state=${new URL(authorization.authorizationUrl).searchParams.get("state")}&code=fixture`);
    const authorized = await google.get(scope, pendingConnection.id);
    const selectedCalendar = await google.selectCalendar(scope, authorized.id, { generation: authorized.generation, calendarId: provider.calendarId });
    const connection = await google.sharing(scope, selectedCalendar.id, { generation: selectedCalendar.generation, sharing: "organization_service" });
    const bookings = new BookingService(pool, { resolveCalendar: (...args) => google.resolveBookingCalendar(...args), ensureFresh: (...args) => google.ensureCredentialFresh(...args), testBaseUrl: provider.base });
    const bookingAgent = await store.createAgent({ ...scope, name: "Booking acceptance", offering: "customer-service" });
    const operatorAgent = await store.createAgent({ ...scope, name: "Operator appointment", configuration: defaultBusinessConfiguration() });
    const policy = await bookings.createPolicy(scope, operatorAgent.id, { connectionId: connection.id, title: "Consultation", durationMinutes: 30, minimumNoticeMinutes: 0, maximumAdvanceDays: 30, days: [0, 1, 2, 3, 4, 5, 6], opensAt: "08:00", closesAt: "18:00" });
    const bookingConfiguration = defaultBusinessConfiguration();
    bookingConfiguration.capabilities.businessActions = { enabled: true, profileId: "calendar-booking-v1", policyId: policy.id, policyDigest: policy.policyDigest };
    const bookingDraft = await store.updateDraft({ ...scope, agentId: operatorAgent.id, configuration: bookingConfiguration, expectedRevision: 1 });
    const bookingVersion = await store.createVersion({ ...scope, agentId: operatorAgent.id, expectedRevision: bookingDraft.draft_revision });
    const authority: AdmissionAuthority = { product: "agents", organizationId: organization.id, resourceId: operatorAgent.id, callerClientId: "agents-execution", principal: { kind: "human", issuer: account.issuer, subject: account.subject } };
    const grant: ExecutionGrant = { ...authority, id: randomUUID(), versionId: bookingVersion.id, operations: ["model.reply", "knowledge.read", "booking.read", "booking.execute"], sourceRevisionIds: [], connectedToolBindingIds: [], maxInputBytes: bookingConfiguration.model.maxInputBytes, maxOutputTokens: bookingConfiguration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(bookingConfiguration), rootTokenLimit: 32000, expiresAt: new Date(Date.now() + 300000).toISOString(), revokedAt: null };
    await store.createGrant({ accountId: account.id, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: bookingVersion.id, requestKey: randomUUID(), input: "Propose a consultation." });
    const startsAt = new Date(Date.now() + 86400000); startsAt.setUTCHours(8, 0, 0, 0);
    const booking = await bookings.prepare(task.id, randomUUID(), startsAt.toISOString());
    if (executionProvider) await assert.rejects(buildPlatformApp({ config: { ...config, NODE_ENV: "production" }, pool, testConnectionLoopback: true }), /TEST_CONNECTION_OPTIONS_DENIED/);
    app = await buildPlatformApp({ config, pool, logging: false, testGoogleOAuth: oauth, testGoogleApiBaseUrl: provider.base, testConnectionLoopback: Boolean(executionProvider) }); await app.listen({ host: "127.0.0.1", port: 4197 });
    await mkdir(resolve(root, ".audit"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ url: origin, organizationId: organization.id, agentId: agent.id, otherAgentId: otherAgent.id, bookingAgentId: bookingAgent.id, bookingTaskId: task.id, bookingRequestDigest: booking.requestDigest, cookie: session.token, ...(executionProvider ? { controlledProvider: executionProvider.base, oauthProvider: oauthProvider!.base } : {}) }), { mode: 0o600 });
    await chmod(statePath, 0o600);
    vite = spawn(process.execPath, [resolve(web, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "3197", "--strictPort"], {
      cwd: web, env: { ...process.env, AGENTS_API_PROXY_TARGET: apiOrigin }, stdio: ["ignore", "pipe", "pipe"],
    });
    // Drain server logs without exposing the fixture environment or request credentials.
    vite.stdout?.resume(); vite.stderr?.resume(); await ready(origin, vite);
    browser = spawn(process.execPath, [resolve(web, "node_modules/@playwright/test/cli.js"), "test", ...(process.env.AGENTS_CATALOGUE_EXECUTION_ONLY === "1" ? [] : ["test/catalogue-live.spec.ts"]), ...(executionProvider ? ["test/catalogue-execution-live.spec.ts"] : []), "--workers=1", "--timeout=45000", "--output", resolve(root, ".audit/catalogue-actual-api-browser")], {
      cwd: web, env: { ...process.env, AGENTS_BROWSER_BASE_URL: origin, AGENTS_CATALOGUE_BROWSER_STATE: statePath }, stdio: ["ignore", "inherit", "inherit"],
    });
    const [code] = await once(browser, "exit");
    assert.equal(code, 0, "Actual API catalogue browser acceptance failed");
    if (executionProvider) {
      const receipts = (await pool.query("SELECT state,body_key,body_digest,result FROM agents_platform.connected_reads WHERE state='completed'")).rows;
      assert.equal(receipts.length, 7, "Published integrations, resources, pinned templates and prompts must have completed private receipts");
      assert.ok(receipts.every(receipt => receipt.body_key && /^[a-f0-9]{64}$/.test(receipt.body_digest) && receipt.result?.status === "ok"));
      assert.equal(executionProvider.calls.filter(call => call.kind === "mcp").length, 2);
      assert.equal(executionProvider.calls.filter(call => call.kind === "api").length, 2);
      for (const kind of ["resource", "template", "prompt"]) assert.equal(executionProvider.calls.filter(call => call.kind === kind).length, 1);
      console.log("Controlled MCP/native execution verified: seven private receipts and seven approved provider calls.");
    }
    console.log("Actual API catalogue browser acceptance passed. Isolated fixture cleanup follows.");
  } finally {
    await stop(browser); await stop(vite); await runtime?.close(); await app?.close(); await executionProvider?.close(); await oauthProvider?.close(); await provider?.close(); await pool?.end();
    await rm(statePath, { force: true });
    if (admin) { if (created) await dropClosedTestDatabase(admin, databaseName); await admin.end(); }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Catalogue browser fixture failed"); process.exitCode = 1; });
