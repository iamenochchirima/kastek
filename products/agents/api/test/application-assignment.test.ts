import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { Applications } from "../src/platform/access/applications";
import { PlatformStore } from "../src/product/agents/store";
import { requirePermission } from "../src/platform/access/permissions";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("application agent assignments", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_assignments_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("changes selected agents and denies unavailable or unauthorized assignments", async () => {
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Workspace");
    const otherOrg = await store.createOrganization(account.id, "Other");
    const owner = { accountId: account.id, organizationId: org.id };
    const first = await store.createConfiguredAgent({ ...owner, name: "First" });
    const second = await store.createConfiguredAgent({ ...owner, name: "Second" });
    const foreign = await store.createConfiguredAgent({ accountId: account.id, organizationId: otherOrg.id, name: "Foreign" });
    const applications = new Applications(pool, async (db, scope) => requirePermission(db, scope, "credentials.manage"));
    const { application, credential } = await applications.create(owner, { name: "Client", agentIds: [first.agent.id], scopes: ["agents:read"] });
    await expect(applications.assignAgents(owner, application.id, { agentIds: [foreign.agent.id] })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await applications.listAgents(credential.secret)).toEqual([{ id: first.agent.id, name: "First" }]);
    await applications.assignAgents(owner, application.id, { agentIds: [second.agent.id] });
    expect(await applications.listAgents(credential.secret)).toEqual([{ id: second.agent.id, name: "Second" }]);
    await applications.assignAgents(owner, application.id, { agentIds: [] });
    expect(await applications.listAgents(credential.secret)).toEqual([]);
    await applications.revoke(owner, application.id);
    await expect(applications.assignAgents(owner, application.id, { agentIds: [first.agent.id] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
