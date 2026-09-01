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
});
