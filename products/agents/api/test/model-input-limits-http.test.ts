import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { loadExecution } from "../src/execution/lifecycle/state";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("saved model input allowances through real HTTP", () => {
  const database = `agents_input_limits_${randomUUID().replaceAll("-", "")}`, origin = "http://localhost:3100";
  let admin: Pool, pool: Pool, store: PlatformStore, app: Awaited<ReturnType<typeof buildPlatformApp>>, endpoint: string;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); store = new PlatformStore(pool);
    app = await buildPlatformApp({ pool, logging: false, config: loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: url.href,
      AGENTS_PUBLIC_URL: origin, AGENTS_OIDC_CLIENT_SECRET: "input-limit-fixture-secret" }) });
    endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture() {
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "limits@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Input limits"); await connectFixtureModel(pool, account.id, org.id, "fixture/input-model");
    const configuration = defaultBusinessConfiguration(); configuration.model.maxInputBytes = 65536;
    configuration.context = { maxInputTokens: 24000, compactAtTokens: 18000 };
    const { agent, snapshot } = await store.createConfiguredAgent({ accountId: account.id, organizationId: org.id, name: "Agent", configuration });
    const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600000) });
    return { org, agent, snapshot, cookie: `agents_session=${session.token}` };
  }
  async function submit(f: Awaited<ReturnType<typeof fixture>>, input: string) {
    const response = await fetch(`${endpoint}/api/organizations/${f.org.id}/tasks`, { method: "POST",
      headers: { origin, cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify({ agentId: f.agent.id, input, requestKey: randomUUID() }) });
    return { status: response.status, body: await response.json() };
  }
  it("accepts ASCII messages above the removed character maximum through the saved byte allowance", async () => {
    const f = await fixture();
    for (const bytes of [20000, 65536]) {
      const input = "a".repeat(bytes), result = await submit(f, input); expect(result.status).toBe(202);
      const execution = await loadExecution(pool, result.body.task.id);
      expect(execution.task.input).toBe(input); expect(execution.models.primary.policy.maxInputBytes).toBe(65536);
    }
  });
  it("enforces the saved limit in UTF-8 bytes without mistaking characters for bytes", async () => {
    const f = await fixture(), input = "😀".repeat(16385);
    expect(input.length).toBeLessThan(65536); expect(Buffer.byteLength(input)).toBeGreaterThan(65536);
    const result = await submit(f, input); expect(result.status).toBe(413); expect(result.body.error.code).toBe("INPUT_LIMIT");
    expect((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count).toBe("0");
  });
  it("retains the independent HTTP request-body transport bound", async () => {
    const f = await fixture(), result = await submit(f, "a".repeat(128000));
    expect(result.status).toBe(413); expect(result.body.error.code).toBe("INVALID_REQUEST");
    expect((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count).toBe("0");
  });
});
