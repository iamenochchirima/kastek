import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("kill switches (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const repository = new KillSwitchRepository(pool);
  const organizationId = `kill-switch-${randomUUID()}`;
  const otherOrganizationId = `kill-switch-other-${randomUUID()}`;
  const createdIds: string[] = [];

  it("sets, resolves, lists, and disables a scoped switch", async () => {
    const created = await repository.set({ organizationId, scopeType: "agent", scopeId: randomUUID(), reason: "test", actorId: "test-user" });
    createdIds.push(created.id);
    expect(created.enabled).toBe(true);
    expect(await repository.isBlocked({ organizationId, agentId: created.scope_id, installationId: randomUUID() })).toBe(true);
    expect((await repository.list(organizationId)).map((entry) => entry.id)).toContain(created.id);
    await repository.disable(organizationId, created.id);
    expect(await repository.isBlocked({ organizationId, agentId: created.scope_id, installationId: randomUUID() })).toBe(false);
  });

  it("applies organization and global switches across the intended scopes", async () => {
    const organization = await repository.set({ organizationId, scopeType: "organization", scopeId: organizationId, reason: "org test", actorId: "test-user" });
    const global = await repository.set({ scopeType: "global", scopeId: "platform", reason: "global test", actorId: "test-user" });
    createdIds.push(organization.id, global.id);

    expect(await repository.isBlocked({ organizationId, agentId: randomUUID(), installationId: randomUUID() })).toBe(true);
    expect(await repository.isBlocked({ organizationId: otherOrganizationId, agentId: randomUUID(), installationId: randomUUID() })).toBe(true);

    await repository.disable(undefined, global.id);
    expect(await repository.isBlocked({ organizationId: otherOrganizationId, agentId: randomUUID(), installationId: randomUUID() })).toBe(false);
    expect(await repository.isBlocked({ organizationId, agentId: randomUUID(), installationId: randomUUID() })).toBe(true);
    await repository.disable(organizationId, organization.id);
    expect(await repository.isBlocked({ organizationId, agentId: randomUUID(), installationId: randomUUID() })).toBe(false);
  });

  afterAll(async () => { await pool.query("DELETE FROM agent_kill_switches WHERE id = ANY($1::uuid[])", [createdIds]); await pool.end(); });
});
