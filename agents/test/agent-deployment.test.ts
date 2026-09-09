import { describe, expect, it, vi } from "vitest";
import { AgentDeploymentModule } from "../src/db/repositories/agent-deployment-repository";

describe("agent version deployment rollout control", () => {
  it("blocks automatic follow-published movement when the scoped flag is disabled", async () => {
    const installation = {
      id: "installation-1",
      agent_definition_id: "agent-1",
      agent_version_id: "version-1",
      organization_id: "org-1",
      release_mode: "follow_published",
      status: "active",
      execution_mode: "kasitek_hosted",
      settings: {},
      scope_type: "organization",
      scope_id: "org-1",
      created_by: "test",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [installation] })
      .mockResolvedValueOnce({ rows: [{ scope_type: "organization", scope_id: "org-1", enabled: false }] });
    const client = { query } as never;

    await expect(new AgentDeploymentModule().deployFollowPublishedInstallations(client, {
      organizationId: "org-1",
      agentId: "agent-1",
      versionId: "version-2",
      actorId: "operator-1",
      trigger: "version_published",
    })).resolves.toBe(0);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.flatMap(([sql]) => [String(sql)])).not.toContain(expect.stringContaining("UPDATE agent_installations"));
  });

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
      .mockResolvedValueOnce({ rows: [playground] });
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
});
