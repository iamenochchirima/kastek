import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("assistant conversation archive and restore", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, app: Awaited<ReturnType<typeof buildPlatformApp>>, endpoint: string;
  const database = `agents_archive_${randomUUID().replaceAll("-", "")}`, origin = "http://localhost:3100";
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
    app = await buildPlatformApp({ pool, logging: false, config: loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: url.href, AGENTS_PUBLIC_URL: origin, AGENTS_OIDC_CLIENT_SECRET: "archive-offline-fixture-secret-only", OPENROUTER_API_KEY: "offline-never-sent" }) });
    endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function actor() { const user = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "archive@example.test", displayName: "Archivist" }); const session = await store.createSession({ accountId: user.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3600000) }); return { user, cookie: `agents_session=${session.token}` }; }
  async function call(method: string, path: string, cookie: string, body?: unknown) { const response = await fetch(endpoint + path, { method, headers: { cookie, "content-type": "application/json", origin }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; }
  async function fixture() {
    const f = await actor(), org = await store.createOrganization(f.user.id, "Archive fixtures");
    const agent = await store.createAgent({ accountId: f.user.id, organizationId: org.id, name: "Assistant" });
    const version = await store.createVersion({ accountId: f.user.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const conversation = randomUUID(), grant = randomUUID(), configuration = defaultBusinessConfiguration();
    const principal = { kind: "human", issuer: f.user.issuer, subject: f.user.subject };
    await pool.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)", [conversation, org.id, agent.id, principal]);
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,source_revision_ids,max_input_bytes,max_output_tokens,expires_at)
      VALUES($1,'agents',$2,$3,'agents-execution',$4,$5,'["model.reply"]'::jsonb,ARRAY[]::uuid[],$6,$7,now()+interval '1 hour')`,
      [grant, org.id, agent.id, principal, version.id, configuration.model.maxInputBytes, configuration.model.maxOutputTokens]);
    await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,state,turn_sequence,effective_composition,caller_client_id,root_task_id)
      VALUES($1::uuid,'agents',$2,$3,$4,$5,$6,$7,$1::text,repeat('0',64),'Remember the launch plan','completed',1,(SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$5),'agents-execution',$1::uuid)`,
      [randomUUID(), org.id, agent.id, principal, version.id, grant, conversation]);
    return { ...f, org: org.id, agent: agent.id, conversation, base: `/api/organizations/${org.id}` };
  }

  it("archives, lists archived, and restores a signed-in conversation", async () => {
    const f = await fixture();
    const list = async (state?: string) => call("GET", `${f.base}/conversations?agentId=${f.agent}${state ? `&state=${state}` : ""}`, f.cookie);
    expect((await list()).body.conversations.map((row: { id: string }) => row.id)).toEqual([f.conversation]);
    expect((await list("archived")).body.conversations).toEqual([]);
    const archived = await call("POST", `${f.base}/conversations/${f.conversation}/archive`, f.cookie, {});
    expect(archived.status).toBe(200); expect(archived.body).toEqual({ id: f.conversation, archived: true });
    expect((await list()).body.conversations).toEqual([]);
    expect((await list("archived")).body.conversations.map((row: { id: string }) => row.id)).toEqual([f.conversation]);
    const restored = await call("POST", `${f.base}/conversations/${f.conversation}/restore`, f.cookie, {});
    expect(restored.status).toBe(200); expect(restored.body).toEqual({ id: f.conversation, archived: false });
    expect((await list()).body.conversations.map((row: { id: string }) => row.id)).toEqual([f.conversation]);
  });

  it("rejects archive transitions for unknown or foreign conversations", async () => {
    const f = await fixture(), other = await actor();
    const missing = randomUUID();
    expect((await call("POST", `${f.base}/conversations/${missing}/archive`, f.cookie, {})).status).toBe(404);
    expect((await call("POST", `${f.base}/conversations/${f.conversation}/archive`, other.cookie, {})).status).toBe(404);
    expect((await call("POST", `${f.base}/conversations/${f.conversation}/restore`, other.cookie, {})).status).toBe(404);
    // Double archive and stray restore are not valid transitions.
    expect((await call("POST", `${f.base}/conversations/${f.conversation}/archive`, f.cookie, {})).status).toBe(200);
    expect((await call("POST", `${f.base}/conversations/${f.conversation}/archive`, f.cookie, {})).status).toBe(404);
    expect((await call("POST", `${f.base}/conversations/${f.conversation}/restore`, f.cookie, {})).status).toBe(200);
    expect((await call("POST", `${f.base}/conversations/${f.conversation}/restore`, f.cookie, {})).status).toBe(404);
  });
});
