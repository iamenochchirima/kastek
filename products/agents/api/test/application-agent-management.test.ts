import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { Applications } from "../src/platform/access/applications";
import { registerApplicationRoutes } from "../src/integrations/http/application-routes";
import { agentCreationOperations } from "../src/product/agents/creation-operations";
import { createApplicationAgentManagement } from "../src/product/agents/application-management";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("application agent management", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_app_agents_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("creates, edits, previews and publishes an agent for an application", async () => {
    const store = new PlatformStore(pool);
    const owner = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "app-agents@example.test", displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "App agents");
    const seed = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Seed" });
    const applications = new Applications(pool, async () => {}, { publicUrl: "https://agents.test" });
    const created = await applications.create({ accountId: owner.id, organizationId: org.id },
      { name: "Client", agentIds: [seed.agent.id], scopes: ["agents:read", "agents:manage", "agents:publish"] });
    const assertBindings = async () => {};
    const management = createApplicationAgentManagement({ pool, store,
      operations: agentCreationOperations({ store, pool, assertBindings }), assertBindings });
    const app = Fastify();
    registerApplicationRoutes(app, { applications, agentManagement: management,
      resolveScope: async () => ({ accountId: owner.id, organizationId: org.id }) });
    const headers = { authorization: `Bearer ${created.credential.secret}` };
    try {
      const made = await app.inject({ method: "POST", url: "/v1/agents", headers,
        payload: { name: "Managed", purpose: "Answer questions", instructions: "Use approved sources.", operationId: randomUUID() } });
      expect(made.statusCode).toBe(201);
      const agentId = made.json().agent.id as string;
      const draftRevision = made.json().agent.draftRevision as number;
      expect(draftRevision).toBeGreaterThan(0);
      const configuration = defaultBusinessConfiguration();
      const saved = await app.inject({ method: "PATCH", url: `/v1/agents/${agentId}`, headers,
        payload: { configuration, expectedRevision: draftRevision } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().agent.draftRevision).toBe(draftRevision + 1);
      expect((await app.inject({ method: "POST", url: `/v1/agents/${agentId}/preview`, headers, payload: { configuration } })).json())
        .toMatchObject({ ready: true });
      const version = await app.inject({ method: "POST", url: `/v1/agents/${agentId}/versions`, headers, payload: { expectedRevision: saved.json().agent.draftRevision } });
      expect(version.statusCode).toBe(201);
      const deployment = await app.inject({ method: "POST", url: `/v1/agents/${agentId}/deployments`, headers,
        payload: { versionId: version.json().version.id, allowedOrigins: ["https://example.com"] } });
      expect(deployment.statusCode).toBe(201);
      const opened = await app.inject({ method: "GET", url: `/v1/agents/${agentId}`, headers });
      expect(opened.json().agent.version.id).toBe(version.json().version.id);
      expect(opened.json().agent.draftRevision).toBe(saved.json().agent.draftRevision);
      const workspaceVersions = await store.listVersions(owner.id, org.id, agentId);
      expect(workspaceVersions.some(item => item.id === version.json().version.id)).toBe(true);
    } finally { await app.close(); }
  });
});
