import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { registerApplicationRoutes } from "../src/integrations/http/application-routes";
import { PlatformStore } from "../src/product/agents/store";
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
    await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Not assigned" });
    const app = Fastify();
    let accountId = owner.id;
    registerApplicationRoutes(app, { pool, resolveScope: async () => ({ accountId, organizationId: org.id }) });
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
});
