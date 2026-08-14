import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { InstallationGrantRepository } from "../src/db/repositories/installation-grant-repository";
import { ScheduleRepository } from "../src/db/repositories/schedule-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("hosted agent lifecycle and isolation (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const grants = new InstallationGrantRepository(pool);
  const schedules = new ScheduleRepository(pool);
  const organizationA = `hosted-boundary-a-${randomUUID()}`;
  const organizationB = `hosted-boundary-b-${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let installationId = "";

  it("keeps definitions, versions, and installations organization-scoped", async () => {
    const agent = await agents.createAgent(organizationA, "owner-a", { name: "Boundary agent" });
    agentId = agent.id;
    const version = await agents.createVersion(organizationA, "owner-a", agent.id, {
      instructions: "Follow the published workflow.",
      configuration: {
        workflow: {
          version: 1,
          entryNodeId: "start",
          nodes: [
            { id: "start", type: "deterministic", config: { operation: "set", path: "ready", value: true } },
          ],
          edges: [],
          stateSchema: { ready: { type: "boolean" } },
        },
      },
      policy: { allowedTools: ["platform.current_time"], maxConcurrentRuns: 2 },
    });
    versionId = version.id;
    await agents.publishVersion(organizationA, "owner-a", agent.id, version.id);

    expect(await agents.getAgent(organizationB, agent.id)).toBeNull();
    expect(await agents.getVersion(organizationB, version.id)).toBeNull();
    expect((await agents.listAgents(organizationB)).some((entry) => entry.id === agent.id)).toBe(false);
    await expect(agents.createInstallation(organizationB, "owner-b", {
      agentVersionId: version.id,
      scopeType: "organization",
      scopeId: organizationB,
      settings: {},
    })).rejects.toThrow("Published agent version not found");

    const installation = await agents.createInstallation(organizationA, "owner-a", {
      agentVersionId: version.id,
      scopeType: "organization",
      scopeId: organizationA,
      settings: { environment: "test" },
    });
    installationId = installation.id;
    expect(await agents.getInstallation(organizationB, installation.id)).toBeNull();
    expect(await agents.setInstallationSettings(organizationA, installation.id, "owner-a", { region: "local" })).toMatchObject({
      settings: { environment: "test", region: "local" },
    });
    expect((await agents.setInstallationStatus(organizationA, installation.id, "paused", "owner-a")).status).toBe("paused");
    expect((await agents.setInstallationStatus(organizationA, installation.id, "active", "owner-a")).status).toBe("active");
    await expect(agents.setInstallationStatus(organizationB, installation.id, "disabled", "owner-b")).rejects.toThrow("Installation not found");
  });

  it("scopes resource, connector, and schedule grants to the installation organization", async () => {
    expect(installationId).toBeTruthy();
    await grants.grantResource({ organizationId: organizationA, installationId, resourceType: "workspace", resourceId: "workspace-a", actorId: "owner-a" });
    await grants.grantConnector({ organizationId: organizationA, installationId, connectorId: "provider.mail", actorId: "owner-a" });
    expect(await grants.effective(organizationA, installationId)).toEqual({
      resources: [{ resourceType: "workspace", resourceId: "workspace-a" }],
      connectors: ["provider.mail"],
    });
    expect(await grants.effective(organizationB, installationId)).toEqual({ resources: [], connectors: [] });
    await expect(grants.grantResource({ organizationId: organizationB, installationId, resourceType: "workspace", resourceId: "workspace-b", actorId: "owner-b" })).rejects.toThrow("Installation not found");
    await expect(grants.grantConnector({ organizationId: organizationB, installationId, connectorId: "provider.crm", actorId: "owner-b" })).rejects.toThrow("Installation not found");

    const schedule = await schedules.create({
      organizationId: organizationA,
      installationId,
      expression: "0 * * * *",
      timezone: "Africa/Johannesburg",
      scheduleInput: { prompt: "refresh" },
      actorId: "owner-a",
    });
    expect(schedule.status).toBe("active");
    expect((await schedules.list(organizationA, installationId)).map((entry) => entry.id)).toContain(schedule.id);
    expect(await schedules.list(organizationB, installationId)).toEqual([]);
    expect((await schedules.setStatus(organizationA, schedule.id, "paused", "owner-a")).status).toBe("paused");
    await expect(schedules.setStatus(organizationB, schedule.id, "disabled", "owner-b")).rejects.toThrow("Schedule not found");
  });

  it("rejects invalid workflow configuration before persisting a version", async () => {
    expect(agentId).toBeTruthy();
    await expect(agents.createVersion(organizationA, "owner-a", agentId, {
      instructions: "invalid",
      configuration: {
        workflow: {
          version: 1,
          entryNodeId: "missing",
          nodes: [{ id: "start", type: "route" }],
          edges: [],
          stateSchema: {},
        },
      },
      policy: {},
    })).rejects.toThrow("entry node does not exist");
    expect((await agents.listVersions(organizationA, agentId)).map((version) => version.id)).toEqual([versionId]);
  });

  beforeAll(async () => { await pool.query("SELECT 1"); });

  afterAll(async () => {
    if (installationId) {
      await pool.query("DELETE FROM agent_schedules WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installation_resource_grants WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installation_connector_grants WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installation_credentials WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationA]);
    }
    if (versionId) await pool.query("DELETE FROM agent_tool_grants WHERE organization_id = $1 AND agent_version_id = $2", [organizationA, versionId]);
    if (agentId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    if (agentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.query("DELETE FROM audit_records WHERE organization_id IN ($1, $2)", [organizationA, organizationB]);
    await pool.end();
  });
});
