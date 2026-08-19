import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { ToolGrantRepository } from "../src/db/repositories/tool-grant-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("agent lifecycle controls (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const grants = new ToolGrantRepository(pool);
  const organizationId = `lifecycle-test-${randomUUID()}`;
  const systemOrganizationId = `system-test-${randomUUID()}`;
  let agentId = "";

  it("publishes, rolls back, retires, and archives without mutating history", async () => {
    const agent = await agents.createAgent(organizationId, "test-user", { name: "Lifecycle agent" });
    agentId = agent.id;
    await expect(agents.createAgent(organizationId, "test-user", { name: "Protected", protected: true })).rejects.toThrow("Only system-owned");
    const versionOne = await agents.createVersion(organizationId, "test-user", agentId, { instructions: "one", configuration: {}, policy: { allowedTools: ["platform.current_time"] } });
    await agents.publishVersion(organizationId, "test-user", agentId, versionOne.id);
    expect((await grants.effectiveTools(organizationId, versionOne.id, randomUUID())).has("platform.current_time")).toBe(true);
    const extraGrant = await grants.grantVersionTool({ organizationId, agentId, versionId: versionOne.id, toolName: "kasitek.core.customer_get", actorId: "test-user" });
    expect((await grants.listForVersion(organizationId, versionOne.id)).map((grant) => grant.tool_name)).toContain("kasitek.core.customer_get");
    await grants.revoke({ organizationId, grantId: extraGrant.id, actorId: "test-user" });
    const versionTwo = await agents.createVersion(organizationId, "test-user", agentId, { instructions: "two", configuration: {}, policy: {} });
    await agents.publishVersion(organizationId, "test-user", agentId, versionTwo.id);
    const rolledBack = await agents.rollbackVersion(organizationId, "test-user", agentId, versionOne.id);
    expect(rolledBack.id).toBe(versionOne.id);
    expect((await agents.listVersions(organizationId, agentId)).find((version) => version.id === versionTwo.id)?.status).toBe("retired");
    await agents.retireVersion(organizationId, "test-user", agentId, versionOne.id);
    expect((await agents.getVersion(organizationId, versionOne.id))?.status).toBe("retired");
    expect((await agents.archiveAgent(organizationId, "test-user", agentId)).status).toBe("archived");
    const systemAgent = await agents.createSystemAgent("system-bootstrap", { name: "KasiAi", organizationId: systemOrganizationId, protected: true });
    expect(systemAgent).toMatchObject({ owner_type: "system", protected: true, organization_id: systemOrganizationId });
    await expect(agents.archiveAgent(systemOrganizationId, "system-bootstrap", systemAgent.id)).rejects.toThrow("protected");
  });

  it("rolls back the complete external aggregate when credential validation fails", async () => {
    const rollbackOrganizationId = `external-rollback-${randomUUID()}`;
    await expect(agents.createExternalInstallation(rollbackOrganizationId, "test-user", {
      name: "Rollback external agent",
      runtime: "test",
      protocols: ["mcp"],
      capabilities: [],
      resources: [],
      connectors: [],
      credentialLabel: "rollback credential",
      idempotencyKey: `rollback-${randomUUID()}`,
      clientKeyId: "rollback-key",
      clientPublicKey: "not-a-public-key",
    })).rejects.toThrow();
    const counts = await pool.query<{ definitions: string; installations: string; principals: string; credentials: string }>(
      `SELECT
         (SELECT count(*)::text FROM agent_definitions WHERE organization_id = $1) AS definitions,
         (SELECT count(*)::text FROM agent_installations WHERE organization_id = $1) AS installations,
         (SELECT count(*)::text FROM agent_principals WHERE organization_id = $1) AS principals,
         (SELECT count(*)::text FROM agent_installation_credentials WHERE organization_id = $1) AS credentials`,
      [rollbackOrganizationId],
    );
    expect(counts.rows[0]).toEqual({ definitions: "0", installations: "0", principals: "0", credentials: "0" });
  });

  it("rejects direct credential inserts for a hosted installation at the database boundary", async () => {
    const organizationId = `credential-guard-${randomUUID()}`;
    const definitionId = randomUUID();
    const versionId = randomUUID();
    const installationId = randomUUID();
    await pool.query(`INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)`, [definitionId, organizationId, "Credential guard", `credential-guard-${definitionId}`, "test-user"]);
    await pool.query(`INSERT INTO agent_versions (id, agent_definition_id, version_number, status, instructions, checksum, created_by) VALUES ($1, $2, 1, 'published', 'test', $3, $4)`, [versionId, definitionId, `checksum-${versionId}`, "test-user"]);
    await pool.query(`INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', $5)`, [installationId, definitionId, versionId, organizationId, "test-user"]);
    await expect(pool.query(`INSERT INTO agent_installation_credentials (installation_id, organization_id, label, secret_hash, created_by) VALUES ($1, $2, 'invalid', 'scrypt$test$safe', $3)`, [installationId, organizationId, "test-user"])).rejects.toThrow("external_connected");
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [definitionId]);
  });

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    if (agentId) {
      await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
      await pool.query("DELETE FROM agent_tool_grants WHERE organization_id = $1", [organizationId]);
      await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
      await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
      await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    }
    await pool.query("DELETE FROM agent_definitions WHERE organization_id = $1", [systemOrganizationId]);
    await pool.end();
  });
});
