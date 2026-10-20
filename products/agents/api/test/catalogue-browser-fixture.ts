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
import { dropClosedTestDatabase } from "./support/database-cleanup";

const root = resolve(__dirname, "../../../.."), web = resolve(root, "products/agents/web");
const statePath = resolve(root, ".audit/agents-catalogue-browser-state.json");
const origin = "http://127.0.0.1:3197", apiOrigin = "http://127.0.0.1:4197";
const databaseName = `agents_catalogue_browser_${randomUUID().replaceAll("-", "")}`;
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
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
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: database.href, AGENTS_PUBLIC_URL: origin,
      AGENTS_OIDC_ISSUER_URL: "http://127.0.0.1:4197/fixture-issuer", AGENTS_CURSOR_ACTIVE_KEY_ID: process.env.AGENTS_CURSOR_ACTIVE_KEY_ID, AGENTS_CURSOR_KEYS_JSON: process.env.AGENTS_CURSOR_KEYS_JSON, AGENTS_OIDC_CLIENT_SECRET: randomBytes(32).toString("base64url") });
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({ issuer: config.AGENTS_OIDC_ISSUER_URL, subject: randomUUID(), email: "catalogue-browser@example.test", displayName: "Catalogue browser" });
    const organization = await store.createOrganization(account.id, "Catalogue acceptance");
    const agent = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Catalogue support", offering: "faq" });
    const otherAgent = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Separate support", offering: "faq" });
    const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
    app = await buildPlatformApp({ config, pool, logging: false }); await app.listen({ host: "127.0.0.1", port: 4197 });
    await mkdir(resolve(root, ".audit"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ url: origin, organizationId: organization.id, agentId: agent.id, otherAgentId: otherAgent.id, cookie: session.token }), { mode: 0o600 });
    await chmod(statePath, 0o600);
    vite = spawn(process.execPath, [resolve(web, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "3197"], {
      cwd: web, env: { ...process.env, AGENTS_API_PROXY_TARGET: apiOrigin }, stdio: ["ignore", "pipe", "pipe"],
    });
    // Drain server logs without exposing the fixture environment or request credentials.
    vite.stdout?.resume(); vite.stderr?.resume(); await ready(origin, vite);
    browser = spawn(process.execPath, [resolve(web, "node_modules/@playwright/test/cli.js"), "test", "test/catalogue-live.spec.ts", "--workers=1", "--timeout=45000", "--output", resolve(root, ".audit/catalogue-actual-api-browser")], {
      cwd: web, env: { ...process.env, AGENTS_BROWSER_BASE_URL: origin, AGENTS_CATALOGUE_BROWSER_STATE: statePath }, stdio: ["ignore", "inherit", "inherit"],
    });
    const [code] = await once(browser, "exit");
    assert.equal(code, 0, "Actual API catalogue browser acceptance failed");
    console.log("Actual API catalogue browser acceptance passed. Isolated fixture cleanup follows.");
  } finally {
    await stop(browser); await stop(vite); await app?.close(); await pool?.end();
    await rm(statePath, { force: true });
    if (admin) { if (created) await dropClosedTestDatabase(admin, databaseName); await admin.end(); }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Catalogue browser fixture failed"); process.exitCode = 1; });
