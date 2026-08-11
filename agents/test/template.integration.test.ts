import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("agent template installation (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const organizationId = `template-test-${randomUUID()}`;

  it("creates a published template agent and idempotently reuses its installation", async () => {
    const first = await agents.installTemplate({ organizationId, actorId: "template-user", templateKey: "lead-intake", settings: { tone: "concise" } });
    const second = await agents.installTemplate({ organizationId, actorId: "template-user", templateKey: "lead-intake", settings: { tone: "detailed" } });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.version.id).toBe(first.version.id);
    expect(second.installation.id).toBe(first.installation.id);
    expect(second.version.status).toBe("published");
    expect(second.installation.settings).toMatchObject({ templateKey: "lead-intake", templateVersion: 1 });
  });

  beforeAll(async () => { await pool.query("SELECT 1"); });

  afterAll(async () => {
    await pool.query("DELETE FROM audit_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_tool_grants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id IN (SELECT id FROM agent_definitions WHERE organization_id = $1)", [organizationId]);
    await pool.query("DELETE FROM agent_definitions WHERE organization_id = $1", [organizationId]);
    await pool.end();
  });
});
