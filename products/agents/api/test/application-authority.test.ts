import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { assertApplicationAuthority } from "../src/execution/admission/application-authority";
import { Applications } from "../src/platform/access/applications";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("application run authority", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_app_auth_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href });
    await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("checks the assigned agent, initiating key, scope and revocation", async () => {
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Workspace");
    const allowed = await store.createConfiguredAgent({ accountId: account.id, organizationId: org.id, name: "Allowed" });
    const other = await store.createConfiguredAgent({ accountId: account.id, organizationId: org.id, name: "Other" });
    const applications = new Applications(pool, async () => {});
    const owner = { accountId: account.id, organizationId: org.id };
    const { application, credential } = await applications.create(owner, { name: "App", agentIds: [allowed.agent.id], scopes: ["runs:start"] });
    const principal = { kind: "application" as const, applicationId: application.id };
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: allowed.agent.id, callerClientId: "agents-application", principal };
    await expect(assertApplicationAuthority(pool, authority, allowed.agent.id, credential.id)).resolves.toBeUndefined();
    await expect(assertApplicationAuthority(pool, { ...authority, resourceId: other.agent.id }, other.agent.id, credential.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(assertApplicationAuthority(pool, authority, allowed.agent.id, randomUUID())).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const readOnly = await applications.issueCredential(owner, application.id, { scopes: ["agents:read"] });
    await expect(assertApplicationAuthority(pool, authority, allowed.agent.id, readOnly.credential.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await applications.revokeCredential(owner, application.id, credential.id);
    await expect(assertApplicationAuthority(pool, authority, allowed.agent.id, credential.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});
