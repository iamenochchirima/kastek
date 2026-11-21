import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { Applications } from "../src/platform/access/applications";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("application capability scopes", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_scopes_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("stores management, publication, connection and review grants", async () => {
    const store = new PlatformStore(pool);
    const owner = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "scopes@example.test", displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "Scopes");
    const agent = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Agent" });
    const applications = new Applications(pool, async () => {});
    const scopes = ["agents:read", "agents:manage", "agents:publish", "connections:manage", "reviews:decide"] as const;
    const created = await applications.create({ accountId: owner.id, organizationId: org.id }, { name: "Client", agentIds: [agent.agent.id], scopes: [...scopes] });
    expect(created.credential.scopes).toEqual([...scopes]);
    const listed = await applications.list({ accountId: owner.id, organizationId: org.id });
    expect(listed[0]?.credentials[0]?.scopes).toEqual([...scopes]);
  });
});
