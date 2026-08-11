import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRepository,
  SYSTEM_ORGANIZATION_ID,
} from "../src/db/repositories/agent-repository";
import { ToolGrantRepository } from "../src/db/repositories/tool-grant-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("protected system agent installations (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const grants = new ToolGrantRepository(pool);
  const suffix = randomUUID();
  const slug = `system-agent-${suffix}`;
  const organizationOne = `system-install-one-${suffix}`;
  const organizationTwo = `system-install-two-${suffix}`;
  const organizationWithoutInstallation = `system-install-none-${suffix}`;
  let agentId = "";
  let versionId = "";

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  it("bootstraps once and installs the protected version idempotently across organizations", async () => {
    const definition = {
      name: "Protected integration agent",
      slug,
      description: "Integration fixture",
      protected: true,
    };
    const firstAgent = await agents.ensureSystemAgent("integration-bootstrap", definition);
    const secondAgent = await agents.ensureSystemAgent("integration-bootstrap", definition);
    agentId = firstAgent.id;
    expect(secondAgent.id).toBe(agentId);
    expect(firstAgent).toMatchObject({
      organization_id: SYSTEM_ORGANIZATION_ID,
      owner_type: "system",
      protected: true,
    });

    const versionInput = {
      instructions: "Use only the granted test tool.",
      configuration: { provider: "openrouter", model: "test/model" },
      policy: { allowedTools: ["platform.current_time"] },
    };
    const firstVersion = await agents.ensureInitialSystemVersion(
      "integration-bootstrap",
      agentId,
      versionInput,
    );
    const secondVersion = await agents.ensureInitialSystemVersion(
      "integration-bootstrap",
      agentId,
      versionInput,
    );
    versionId = firstVersion.id;
    expect(secondVersion.id).toBe(versionId);
    expect(firstVersion.status).toBe("published");

    const firstInstallation = await agents.ensureSystemInstallation({
      organizationId: organizationOne,
      actorId: "user-one",
      systemSlug: slug,
    });
    const repeatedInstallation = await agents.ensureSystemInstallation({
      organizationId: organizationOne,
      actorId: "user-one",
      systemSlug: slug,
    });
    const secondOrganizationInstallation = await agents.ensureSystemInstallation({
      organizationId: organizationTwo,
      actorId: "user-two",
      systemSlug: slug,
    });

    expect(firstInstallation.created).toBe(true);
    expect(repeatedInstallation.created).toBe(false);
    expect(repeatedInstallation.id).toBe(firstInstallation.id);
    expect(secondOrganizationInstallation.id).not.toBe(firstInstallation.id);
    expect(firstInstallation).toMatchObject({
      organization_id: organizationOne,
      agent_definition_id: agentId,
      agent_version_id: versionId,
      agent_slug: slug,
      agent_protected: true,
    });
    const guidance = await pool.query<{ source_count: string; chunk_count: string }>(
      `SELECT COUNT(DISTINCT ks.id)::text AS source_count, COUNT(kc.id)::text AS chunk_count
       FROM knowledge_sources ks
       LEFT JOIN knowledge_chunks kc ON kc.source_id = ks.id
       WHERE ks.organization_id = $1 AND ks.agent_definition_id = $2 AND ks.installation_id = $3`,
      [organizationOne, agentId, firstInstallation.id],
    );
    expect(guidance.rows[0]).toMatchObject({ source_count: "1", chunk_count: "6" });
    expect((await agents.listAgents(organizationOne)).map((agent) => agent.id)).toContain(agentId);
    expect((await agents.listAgents(organizationWithoutInstallation)).map((agent) => agent.id)).not.toContain(agentId);
    expect(await agents.getAgent(organizationTwo, agentId)).toMatchObject({ id: agentId });
    expect(await agents.getAgent(organizationWithoutInstallation, agentId)).toBeNull();
    expect(await agents.getInstallation(organizationTwo, firstInstallation.id)).toBeNull();
    expect(await agents.getSystemInstallation({ organizationId: organizationOne, systemSlug: slug })).toMatchObject({
      id: firstInstallation.id,
      created: false,
    });

    const effectiveTools = await grants.effectiveTools(organizationOne, versionId, firstInstallation.id);
    expect(effectiveTools).toEqual(new Set(["platform.current_time"]));

    await expect(
      agents.createVersion(organizationOne, "user-one", agentId, {
        instructions: "Unauthorized mutation",
        configuration: {},
        policy: {},
      }),
    ).rejects.toThrow("Agent not found");
    await expect(agents.archiveAgent(organizationOne, "user-one", agentId)).rejects.toThrow(
      "Agent not found or protected",
    );
  });

  afterAll(async () => {
    if (agentId) {
      await pool.query(
        "DELETE FROM audit_records WHERE organization_id = ANY($1::text[])",
        [[SYSTEM_ORGANIZATION_ID, organizationOne, organizationTwo, organizationWithoutInstallation]],
      );
      await pool.query(
        "DELETE FROM evaluation_runs WHERE scenario_id IN (SELECT id FROM evaluation_scenarios WHERE agent_definition_id = $1)",
        [agentId],
      );
      await pool.query("DELETE FROM evaluation_scenarios WHERE agent_definition_id = $1", [agentId]);
      await pool.query(
        "DELETE FROM knowledge_chunks WHERE source_id IN (SELECT id FROM knowledge_sources WHERE agent_definition_id = $1)",
        [agentId],
      );
      await pool.query("DELETE FROM knowledge_sources WHERE agent_definition_id = $1", [agentId]);
      await pool.query("DELETE FROM channel_bindings WHERE installation_id IN (SELECT id FROM agent_installations WHERE agent_definition_id = $1)", [agentId]);
      await pool.query("DELETE FROM channel_connections WHERE installation_id IN (SELECT id FROM agent_installations WHERE agent_definition_id = $1)", [agentId]);
      await pool.query(
        "DELETE FROM agent_principals WHERE installation_id IN (SELECT id FROM agent_installations WHERE agent_definition_id = $1)",
        [agentId],
      );
      if (versionId) await pool.query("DELETE FROM agent_tool_grants WHERE agent_version_id = $1", [versionId]);
      await pool.query("DELETE FROM agent_installations WHERE agent_definition_id = $1", [agentId]);
      await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
      await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    }
    await pool.end();
  });
});
