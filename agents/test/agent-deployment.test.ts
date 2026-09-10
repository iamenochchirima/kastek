import { describe, expect, it, vi } from "vitest";
import { AgentDeploymentModule } from "../src/db/repositories/agent-deployment-repository";

describe("agent version deployment rollout control", () => {
  it("preflights a published Playground candidate against an active Live target", async () => {
    const target = {
      id: "live-installation",
      agent_definition_id: "agent-1",
      agent_version_id: "version-1",
      organization_id: "org-1",
      release_mode: "pinned",
      status: "active",
      execution_mode: "kasitek_hosted",
      settings: { environment: "live", bindingRevision: "live-bindings-4" },
      scope_type: "organization",
      scope_id: "org-1",
      created_by: "test",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    const current = {
      version_id: "version-1",
      version_number: 1,
      status: "published",
      checksum: "candidate-1",
      extension_snapshot_id: null,
      extension_snapshot_checksum: null,
    };
    const candidate = {
      ...current,
      version_id: "version-2",
      version_number: 2,
      checksum: "candidate-2",
      owner_type: "organization",
      protected: false,
    };
    const playground = {
      ...target,
      id: "playground-installation",
      agent_version_id: "version-2",
      settings: { environment: "playground" },
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [target] })
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [playground] })
      .mockResolvedValueOnce({ rows: [{ digest: "playground-capabilities-1" }] });
    const result = await new AgentDeploymentModule().preflightInstallation(
      { query } as never,
      "org-1",
      "live-installation",
      { versionId: "version-2", sourceInstallationId: "playground-installation", expectedVersionId: "version-1" },
    );

    expect(result).toMatchObject({
      installationId: "live-installation",
      agentId: "agent-1",
      status: "ready",
      ready: true,
      sourceInstallationId: "playground-installation",
      capabilityConfigurationDigest: "playground-capabilities-1",
      bindingRevision: "live-bindings-4",
      candidate: { versionId: "version-2", digest: "candidate-2" },
      current: { versionId: "version-1", digest: "candidate-1" },
    });
    expect(result.blockers).toEqual([]);
  });

  it("reports stale Live pointers and does not mutate during preflight", async () => {
    const target = {
      id: "live-installation",
      agent_definition_id: "agent-1",
      agent_version_id: "version-2",
      organization_id: "org-1",
      release_mode: "pinned",
      status: "active",
      execution_mode: "kasitek_hosted",
      settings: { environment: "live" },
    };
    const version = {
      version_id: "version-2",
      version_number: 2,
      status: "published",
      checksum: "candidate-2",
      extension_snapshot_id: null,
      extension_snapshot_checksum: null,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [target] })
      .mockResolvedValueOnce({ rows: [version] })
      .mockResolvedValueOnce({ rows: [{ ...version, version_id: "version-3", version_number: 3, checksum: "candidate-3", owner_type: "organization", protected: false }] });
    const result = await new AgentDeploymentModule().preflightInstallation(
      { query } as never,
      "org-1",
      "live-installation",
      { versionId: "version-3", expectedVersionId: "version-1" },
    );

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "expected_version_mismatch" }),
    ]));
    expect(query.mock.calls.map(([sql]) => String(sql)).some((sql) => sql.includes("UPDATE agent_installations"))).toBe(false);
  });

  it("restores the recorded capability snapshot and reports its digest on rollback", async () => {
    const current = {
      id: "live-installation",
      agent_definition_id: "agent-1",
      agent_version_id: "version-2",
      organization_id: "org-1",
      release_mode: "pinned",
      status: "active",
      execution_mode: "kasitek_hosted",
      settings: { environment: "live", bindingRevision: "live-bindings-4" },
      scope_type: "organization",
      scope_id: "org-1",
      created_by: "test",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    const restored = { ...current, agent_version_id: "version-1" };
    const target = {
      version_id: "version-1",
      version_number: 1,
      status: "published",
      checksum: "candidate-1",
      extension_snapshot_id: null,
      extension_snapshot_checksum: null,
      deployment_id: "promotion-1",
      deployment_action: "deployed",
      deployment_previous_version_id: "version-0",
      deployment_idempotency_key: "promotion-1-key",
      deployment_candidate_digest: "candidate-1",
      deployment_capability_configuration_digest: "candidate-capabilities-1",
      deployment_previous_capability_configuration_snapshot: {
        connections: [],
        resourceGrants: [],
        connectorGrants: [],
        toolGrants: [],
      },
      deployment_extension_snapshot_checksum: null,
      deployment_binding_revision: "live-bindings-4",
    };
    let deploymentLookupCount = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM agent_installations") && sql.includes("FOR UPDATE")) return { rows: [current] };
      if (sql.includes("FROM agent_installation_deployments deployment")) return { rows: [target] };
      if (sql.includes("SELECT * FROM agent_installation_deployments")) {
        deploymentLookupCount += 1;
        return deploymentLookupCount === 1 ? { rows: [] } : { rows: [{ id: "rollback-1" }] };
      }
      if (sql.includes("SELECT md5(")) return { rows: [{ digest: "restored-capabilities-1" }] };
      if (sql.includes("SELECT integration_id")) return { rows: [] };
      if (sql.includes("SELECT resource_type")) return { rows: [] };
      if (sql.includes("SELECT connector_id")) return { rows: [] };
      if (sql.includes("SELECT agent_version_id")) return { rows: [] };
      if (sql.includes("UPDATE agent_installations")) return { rows: [restored] };
      if (sql.includes("INSERT INTO analytics_outbox")) return { rows: [{ outbox_id: "outbox-1", source_sequence: "1" }] };
      return { rows: [] };
    });

    const result = await new AgentDeploymentModule().rollbackInstallation(
      { query } as never,
      "org-1",
      "operator-1",
      "live-installation",
      { expectedVersionId: "version-2" },
    );

    expect(result.manifest).toMatchObject({
      candidateVersionId: "version-1",
      capabilityConfigurationDigest: "restored-capabilities-1",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE integration_connections"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO agent_installation_deployments"))).toBe(true);
  });

  it("rejects promotion when the mirrored Live capability digest differs from Playground", async () => {
    const live = {
      id: "live-installation",
      agent_definition_id: "agent-1",
      agent_version_id: "version-1",
      organization_id: "org-1",
      release_mode: "pinned",
      status: "active",
      execution_mode: "kasitek_hosted",
      settings: { environment: "live", bindingRevision: "live-bindings-4" },
    };
    const playground = { ...live, id: "playground-installation", agent_version_id: "version-2", settings: { environment: "playground" } };
    const version = {
      version_id: "version-1",
      version_number: 1,
      status: "published",
      checksum: "candidate-1",
      extension_snapshot_id: null,
      extension_snapshot_checksum: null,
    };
    const candidate = { ...version, version_id: "version-2", version_number: 2, checksum: "candidate-2", owner_type: "organization", protected: false };
    let installationSelectCount = 0;
    let digestCount = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM agent_installations")) {
        installationSelectCount += 1;
        return { rows: [installationSelectCount === 3 ? playground : live] };
      }
      if (sql.includes("WHERE version.id = $1")) return { rows: [version] };
      if (sql.includes("WHERE version.id = $3")) return { rows: [candidate] };
      if (sql.includes("SELECT md5(")) {
        digestCount += 1;
        return { rows: [{ digest: digestCount === 1 ? "playground-capabilities-1" : "live-capabilities-2" }] };
      }
      if (sql.includes("SELECT integration_id") || sql.includes("SELECT resource_type") || sql.includes("SELECT connector_id") || sql.includes("SELECT agent_version_id")) return { rows: [] };
      return { rows: [] };
    });

    await expect(new AgentDeploymentModule().promoteInstallation(
      { query } as never,
      "org-1",
      "operator-1",
      "live-installation",
      { versionId: "version-2", sourceInstallationId: "playground-installation", expectedVersionId: "version-1", idempotencyKey: "promotion-key" },
    )).rejects.toMatchObject({ code: "PROMOTION_CAPABILITY_CONFIGURATION_MISMATCH" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE agent_installations"))).toBe(false);
  });
});
