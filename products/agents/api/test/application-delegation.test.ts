import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { Applications } from "../src/platform/access/applications";
import { admitApplicationRun } from "../src/platform/runs/application-admission";
import { operationsForConfiguration } from "../src/platform/access/grant-operations";
import { PlatformStore } from "../src/product/agents/store";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("delegated application assertions", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_delegation_${randomUUID().replaceAll("-", "")}`;
  const audience = "https://agents.test";
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("verifies a signed user assertion and binds it to the application run", async () => {
    const store = new PlatformStore(pool);
    const owner = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "delegation@example.test", displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "Delegation");
    await connectFixtureModel(pool, owner.id, org.id);
    const agent = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Agent", configuration: defaultBusinessConfiguration() });
    const applications = new Applications(pool, async () => {}, { publicUrl: audience });
    const { application, credential } = await applications.create({ accountId: owner.id, organizationId: org.id }, { name: "Client", agentIds: [agent.agent.id], scopes: ["runs:start"] });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await applications.registerKey({ accountId: owner.id, organizationId: org.id }, application.id, { operationId: randomUUID(), publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() });
    const payload = { applicationId: application.id, organizationId: org.id, subject: "user-42", audience,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = sign(null, Buffer.from(encoded), privateKey).toString("base64url");
    const assertion = `${encoded}.${signature}`;
    const verified = await applications.verifyAssertion(credential.secret, assertion);
    expect(verified).toMatchObject({ applicationId: application.id, organizationId: org.id, subject: "user-42" });
    const run = await admitApplicationRun({ pool, store, assertServices: async () => {}, grantOperations: c => operationsForConfiguration(c, true) },
      { organizationId: org.id, applicationId: application.id, credentialId: credential.id, agentId: agent.agent.id,
        message: "Hello", requestId: randomUUID(), delegated: { subject: verified.subject, assertionDigest: verified.assertionDigest,
          issuedAt: verified.issuedAt, expiresAt: verified.expiresAt } });
    const row = (await pool.query("SELECT subject,assertion_digest FROM agents_platform.application_delegations WHERE task_id=$1", [run.task.id])).rows[0];
    expect(row).toEqual({ subject: "user-42", assertion_digest: verified.assertionDigest });
    const tampered = `${encoded}.${Buffer.alloc(64).toString("base64url")}`;
    await expect(applications.verifyAssertion(credential.secret, tampered)).rejects.toMatchObject({ code: "INVALID_ASSERTION" });
    const other = Buffer.from(JSON.stringify({ ...payload, applicationId: randomUUID() })).toString("base64url");
    const otherAssertion = `${other}.${sign(null, Buffer.from(other), privateKey).toString("base64url")}`;
    await expect(applications.verifyAssertion(credential.secret, otherAssertion)).rejects.toMatchObject({ code: "ASSERTION_SCOPE_DENIED" });
  });
});
