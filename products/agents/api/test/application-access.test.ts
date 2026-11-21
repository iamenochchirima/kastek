import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { registerApplicationRoutes } from "../src/integrations/http/application-routes";
import { PlatformStore } from "../src/product/agents/store";
import { admitApplicationRun } from "../src/platform/runs/application-admission";
import { operationsForConfiguration } from "../src/platform/access/grant-operations";
import { Applications, authorizeApplicationManager } from "../src/platform/access";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { connectFixtureModel } from "./model-fixture";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("application credentials", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_applications_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("issues a scoped secret once, returns only assigned agents, and revokes access", async () => {
    const store = new PlatformStore(pool);
    const owner = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "Workspace");
    const member = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "member@example.test", displayName: "Member" });
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [org.id, member.id]);
    const allowed = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Allowed" });
    const unassigned = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Not assigned" });
    const app = Fastify();
    let accountId = owner.id;
    registerApplicationRoutes(app, { applications: new Applications(pool, authorizeApplicationManager), resolveScope: async () => ({ accountId, organizationId: org.id }) });
    try {
      const path = `/api/organizations/${org.id}/applications`;
      accountId = member.id;
      expect((await app.inject({ method: "POST", url: path, payload: { name: "Denied", agentIds: [allowed.agent.id], scopes: ["agents:read"] } })).statusCode).toBe(403);
      accountId = owner.id;
      expect((await app.inject({ method: "POST", url: path, payload: { name: "Denied", agentIds: [randomUUID()], scopes: ["agents:read"] } })).statusCode).toBe(403);
      const created = await app.inject({ method: "POST", url: path, payload: { name: "Client", agentIds: [allowed.agent.id], scopes: ["agents:read"] } });
      expect(created.statusCode).toBe(201);
      const { application, credential } = created.json();
      expect(credential.secret).toMatch(/^kat_/);
      const listed = await app.inject({ method: "GET", url: path });
      expect(listed.body).not.toContain(credential.secret);
      const agents = await app.inject({ method: "GET", url: "/v1/agents", headers: { authorization: `Bearer ${credential.secret}` } });
      expect(agents.statusCode).toBe(200);
      expect(agents.json().agents).toEqual([{ id: allowed.agent.id, name: "Allowed" }]);
      const headers = { authorization: `Bearer ${credential.secret}` };
      const opened = await app.inject({ method: "GET", url: `/v1/agents/${allowed.agent.id}`, headers });
      expect(opened.statusCode).toBe(200);
      expect(opened.json().agent).toMatchObject({ id: allowed.agent.id, name: "Allowed", version: { number: 1 } });
      expect(opened.json().agent.version.id).toMatch(/^[a-f0-9-]{36}$/);
      expect((await app.inject({ method: "GET", url: `/v1/agents/${unassigned.agent.id}`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/v1/agents/${allowed.agent.id}` })).statusCode).toBe(401);
      const rotated = await app.inject({ method: "POST", url: `${path}/${application.id}/credentials`, payload: { scopes: ["agents:read"] } });
      expect(rotated.statusCode).toBe(201);
      const replacement = rotated.json().credential;
      expect((await app.inject({ method: "POST", url: `${path}/${application.id}/credentials/${credential.id}/revoke` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/agents", headers: { authorization: `Bearer ${credential.secret}` } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/v1/agents", headers: { authorization: `Bearer ${replacement.secret}` } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `${path}/${application.id}/revoke` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/agents", headers: { authorization: `Bearer ${replacement.secret}` } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("admits application runs and enforces agent and key permissions", async () => {
    const store = new PlatformStore(pool);
    const owner = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "runner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "Runs");
    await connectFixtureModel(pool, owner.id, org.id);
    const agent = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Allowed", configuration: defaultBusinessConfiguration() });
    const other = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Other", configuration: defaultBusinessConfiguration() });
    const app = Fastify();
    registerApplicationRoutes(app, { applications: new Applications(pool, authorizeApplicationManager), resolveScope: async () => ({ accountId: owner.id, organizationId: org.id }), runs: {
      start: input => admitApplicationRun({ pool, store, assertServices: async () => {}, grantOperations: c => operationsForConfiguration(c, true) }, input),
      read: async task => ({ taskId: task.id, state: task.state }), steer: async () => ({ accepted: true }), cancel: async () => ({ accepted: true }),
    } });
    try {
      const path = `/api/organizations/${org.id}/applications`;
      const created = await app.inject({ method: "POST", url: path, payload: { name: "Client", agentIds: [agent.agent.id], scopes: ["runs:start", "runs:read"] } });
      expect(created.statusCode).toBe(201);
      const { application, credential } = created.json(), headers = { authorization: `Bearer ${credential.secret}` };
      const request = { agentId: agent.agent.id, message: "Hello", requestId: randomUUID() };
      expect((await app.inject({ method: "POST", url: "/v1/runs", headers, payload: { ...request, agentId: other.agent.id } })).statusCode).toBe(403);
      const started = await app.inject({ method: "POST", url: "/v1/runs", headers, payload: request });
      expect(started.statusCode).toBe(202);
      const { taskId } = started.json();
      expect((await app.inject({ method: "POST", url: "/v1/runs", headers, payload: request })).json()).toMatchObject({ taskId, replayed: true });
      expect((await app.inject({ method: "GET", url: `/v1/runs/${taskId}`, headers })).json()).toMatchObject({ taskId, state: "accepted" });
      expect((await app.inject({ method: "POST", url: `/v1/runs/${taskId}/cancel`, headers, payload: {} })).statusCode).toBe(401);
      const row = (await pool.query("SELECT principal FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
      expect(row.principal).toEqual({ kind: "application", applicationId: application.id });
      expect((await pool.query("SELECT g.application_credential_id FROM agents_platform.execution_grants g JOIN agents_platform.tasks t ON t.grant_id=g.id WHERE t.id=$1", [taskId])).rows[0].application_credential_id).toBe(credential.id);
      const createdConversation = await app.inject({ method: "POST", url: "/v1/conversations", headers, payload: { agentId: agent.agent.id } });
      expect(createdConversation.statusCode).toBe(201);
      const conversationId = createdConversation.json().conversation.id;
      const runInConversation = await app.inject({ method: "POST", url: "/v1/runs", headers,
        payload: { ...request, requestId: randomUUID(), conversationId } });
      expect(runInConversation.statusCode).toBe(202);
      const conversationRead = await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}`, headers });
      expect(conversationRead.json().tasks.map((task: { taskId: string }) => task.taskId)).toContain(runInConversation.json().taskId);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      const abort = new AbortController();
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/${taskId}/events`, { headers, signal: abort.signal });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const reader = response.body!.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        expect(first).toContain("event: snapshot");
        expect(first).toContain(taskId);
        // A newly connected client receives the current snapshot without a cursor.
        const second = await fetch(`http://127.0.0.1:${address.port}/v1/runs/${taskId}/events`, { headers, signal: abort.signal });
        const secondReader = second.body!.getReader();
        expect(new TextDecoder().decode((await secondReader.read()).value)).toContain(taskId);
        await secondReader.cancel();
        await app.inject({ method: "POST", url: `${path}/${application.id}/revoke` });
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: unavailable");
      } finally { abort.abort(); }
      expect((await app.inject({ method: "GET", url: `/v1/runs/${taskId}`, headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("accepts bearer run requests through the composed API without a browser origin", async () => {
    const store = new PlatformStore(pool);
    const owner = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "api@example.test", displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "API");
    const foreignOrg = await store.createOrganization(owner.id, "Other workspace");
    await connectFixtureModel(pool, owner.id, org.id);
    const agent = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Agent", configuration: defaultBusinessConfiguration() });
    const foreignAgent = await store.createConfiguredAgent({ accountId: owner.id, organizationId: foreignOrg.id, name: "Other agent", configuration: defaultBusinessConfiguration() });
    const session = await store.createSession({ accountId: owner.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3600000) });
    const app = await buildPlatformApp({ pool, logging: false, config: loadPlatformConfig({ NODE_ENV: "test",
      AGENTS_DATABASE_URL: (pool.options as { connectionString: string }).connectionString, AGENTS_PUBLIC_URL: "http://localhost:3100",
      AGENTS_OIDC_ISSUER_URL: "https://identity.test", AGENTS_OIDC_CLIENT_SECRET: "isolated-application-fixture-secret" }) });
    try {
      const created = await app.inject({ method: "POST", url: `/api/organizations/${org.id}/applications`,
        headers: { cookie: `agents_session=${session.token}`, origin: "http://localhost:3100" },
        payload: { name: "Client", agentIds: [agent.agent.id], scopes: ["agents:read", "runs:start", "runs:read"] } });
      expect(created.statusCode).toBe(201);
      const { application, credential } = created.json();
      const headers = { authorization: `Bearer ${credential.secret}` };
      expect((await app.inject({ method: "GET", url: `/v1/agents/${foreignAgent.agent.id}`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/v1/runs", headers,
        payload: { agentId: foreignAgent.agent.id, message: "Hello", requestId: randomUUID() } })).statusCode).toBe(403);
      const run = await app.inject({ method: "POST", url: "/v1/runs", headers,
        payload: { agentId: agent.agent.id, message: "Hello", requestId: randomUUID() } });
      expect(run.statusCode).toBe(202);
      expect((await app.inject({ method: "GET", url: `/v1/runs/${run.json().taskId}`, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/organizations/${org.id}/applications/${application.id}/credentials/${credential.id}/revoke`,
        headers: { cookie: `agents_session=${session.token}`, origin: "http://localhost:3100" }, payload: {} })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/v1/runs/${run.json().taskId}`, headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
