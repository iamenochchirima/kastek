import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { admitChildren } from "../src/execution/delegation/delegation";
import { discoverSpecialists } from "../src/execution/delegation/discovery";
import { PlatformStore } from "../src/product/agents/store";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("delegation roster", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const database = `agents_delegation_roster_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  async function fixture(overrides: { maxChildren?: number; roster?: "open" | "restricted" } = {}) {
    const account = await store.ensureAccount({ issuer: "https://delegation.test", subject: randomUUID(), email: "owner@delegation.test", displayName: "Owner" });
    const organization = await store.createOrganization(account.id, "Delegation roster");
    const scope = { accountId: account.id, organizationId: organization.id };
    await connectFixtureModel(pool, account.id, organization.id);
    const named = await store.createConfiguredAgent({ ...scope, name: "Named specialist" });
    const namedVersion = await store.createVersion({ ...scope, agentId: named.agent.id, expectedRevision: 1 });
    const configuration = defaultBusinessConfiguration();
    configuration.program = { id: "tool-directed", version: "4" };
    configuration.tools = ["agents.delegate", "agents.discover"];
    configuration.capabilities.delegation = { enabled: true, maxChildren: overrides.maxChildren ?? 2, maxDepth: 1,
      bindings: [], ...(overrides.roster ? { roster: overrides.roster } : {}) };
    const parent = await store.createConfiguredAgent({ ...scope, name: "Coordinator", configuration });
    const version = await store.createVersion({ ...scope, agentId: parent.agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: organization.id, resourceId: parent.agent.id,
      callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: ["model.reply", "delegation.execute"], sourceRevisionIds: [], connectedToolBindingIds: [],
      maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens,
      maxContextTokens: contextGrantCeiling(configuration), rootTokenLimit: 32000,
      expiresAt: new Date(Date.now() + 300_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: account.id, grant });
    const admitted = await store.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input: "Coordinate the work" });
    return { scope, parent, version, named, namedVersion, taskId: admitted.task.id };
  }

  it("admits a temporary general-purpose child from the single delegation setting", async () => {
    const f = await fixture();
    const [child] = await admitChildren(pool, f.taskId, "general-one", { requests: [{ bindingId: "general", brief: "Summarize the request." }] });
    expect(child).toBeDefined();
    const childTask = (await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1", [child!.taskId])).rows[0];
    expect(childTask.version_id).toBe(f.version.id);
    const delegation = (await pool.query("SELECT binding_id FROM agents_platform.delegations WHERE child_task_id=$1", [child!.taskId])).rows[0];
    expect(delegation.binding_id).toBe("general");
  });

  it("admits a child run of an authorized named workspace agent, in parallel", async () => {
    const f = await fixture();
    const children = await admitChildren(pool, f.taskId, "named-parallel", {
      requests: [{ bindingId: `named-${f.named.agent.id}`, brief: "Check the named specialist." }, { bindingId: "general", brief: "Run the general check." }],
    });
    expect(children).toHaveLength(2);
    const versions = (await pool.query("SELECT id,version_id FROM agents_platform.tasks WHERE id=ANY($1::uuid[])", [children.map(child => child.taskId)])).rows;
    expect(versions.map(row => row.version_id)).toContain(f.namedVersion.id);
    expect(versions.map(row => row.version_id)).toContain(f.version.id);
  });

  it("keeps saved assignments as a restricted roster when requested", async () => {
    const f = await fixture({ roster: "restricted" });
    await expect(admitChildren(pool, f.taskId, "restricted-one", { requests: [{ bindingId: "general", brief: "General child." }] }))
      .rejects.toMatchObject({ code: "DELEGATION_ROSTER_DENIED" });
    await expect(admitChildren(pool, f.taskId, "restricted-two", { requests: [{ bindingId: `named-${f.named.agent.id}`, brief: "Named child." }] }))
      .rejects.toMatchObject({ code: "DELEGATION_ROSTER_DENIED" });
  });

  it("lists authorized named agents for conversation requests only on an open roster", async () => {
    const open = await fixture();
    const listed = await discoverSpecialists(pool, open.taskId, {});
    expect(listed.specialists.some(specialist => specialist.bindingId === `named-${open.named.agent.id}`)).toBe(true);
    const restricted = await fixture({ roster: "restricted" });
    const hidden = await discoverSpecialists(pool, restricted.taskId, {});
    expect(hidden.specialists.some(specialist => specialist.bindingId === `named-${restricted.named.agent.id}`)).toBe(false);
  });

  it("enforces the fan-out limit once the parallel children are active", async () => {
    const f = await fixture();
    const children = await admitChildren(pool, f.taskId, "fanout", { requests: [{ bindingId: "general", brief: "First." }, { bindingId: "general", brief: "Second." }] });
    expect(children).toHaveLength(2);
    await expect(admitChildren(pool, f.taskId, "fanout-extra", { requests: [{ bindingId: "general", brief: "Third." }] }))
      .rejects.toMatchObject({ code: "CHILD_LIMIT" });
  });
});
