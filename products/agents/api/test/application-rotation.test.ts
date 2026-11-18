import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { EvidenceStore } from "../src/execution/context/evidence";
import { assertBaseAuthority } from "../src/execution/lifecycle/authority";
import { loadExecution } from "../src/execution/lifecycle/state";
import { settleTask } from "../src/execution/lifecycle/execution";
import { Applications } from "../src/platform/access/applications";
import { operationsForConfiguration } from "../src/platform/access/grant-operations";
import { admitApplicationRun } from "../src/platform/runs/application-admission";
import { PlatformStore } from "../src/product/agents/store";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("application credential rotation", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_app_rotation_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("keeps conversation history while revocation stops runs admitted with the old key", async () => {
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "rotation@example.test", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Workspace");
    await connectFixtureModel(pool, account.id, org.id);
    const agent = await store.createConfiguredAgent({ accountId: account.id, organizationId: org.id, name: "Agent", configuration: defaultBusinessConfiguration() });
    const applications = new Applications(pool, async () => {}), owner = { accountId: account.id, organizationId: org.id };
    const { application, credential } = await applications.create(owner, { name: "App", agentIds: [agent.agent.id], scopes: ["runs:start"] });
    const next = await applications.issueCredential(owner, application.id, { scopes: ["runs:start"] });
    const scope = { organizationId: org.id, applicationId: application.id, agentId: agent.agent.id };
    const options = { pool, store, assertServices: async () => {}, grantOperations: (c: typeof agent.version.configuration) => operationsForConfiguration(c, true) };
    const prior = await admitApplicationRun(options, { ...scope, credentialId: credential.id, message: "My preference is short answers", requestId: randomUUID() });
    await settleTask(pool, prior.task.id, { state: "failed", errorCode: "TEST_FINISHED" });
    const pending = await admitApplicationRun(options, { ...scope, credentialId: credential.id, message: "Still working", requestId: randomUUID() });
    await applications.revokeCredential(owner, application.id, credential.id);
    await expect(assertBaseAuthority(pool, await loadExecution(pool, pending.task.id))).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const followup = await admitApplicationRun(options, { ...scope, credentialId: next.credential.id, message: "What is my preference?",
      requestId: randomUUID(), conversationId: prior.task.conversation_id });
    expect(followup.task.principal).toEqual(prior.task.principal);
    const history = await new EvidenceStore(pool).checkHistory(followup.task.id, [prior.task.id]);
    expect(history).toMatchObject([{ taskId: prior.task.id, eligible: true }]);
  });
});
