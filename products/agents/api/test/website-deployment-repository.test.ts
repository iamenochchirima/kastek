import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { WebsiteDeploymentRepository, type WebsiteDeploymentRecord } from "../src/db/repositories/website-deployment-repository";
import { AgentDeploymentModule } from "../src/db/repositories/agent-deployment-repository";

describe("website deployment repository", () => {
  it("creates a ready Live target that passes preflight for the exact tested version", async () => {
    const deployment: WebsiteDeploymentRecord = {
      id: "deployment-1",
      public_id: "public-1",
      organization_id: "workspace-1",
      source_installation_id: "test-installation-1",
      installation_id: "live-installation-1",
      channel_connection_id: "connection-1",
      status: "ACTIVE",
      allowed_origins: ["https://support.example.test"],
      configuration: {},
      created_at: "2026-10-17T00:00:00.000Z",
      updated_at: "2026-10-17T00:00:00.000Z",
    };
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const query = vi.fn(async (text: unknown, values?: unknown[]) => {
      const sql = String(text);
      queries.push({ sql, values });
      if (sql.includes("INSERT INTO agent_installations")) return { rows: [{ id: "live-installation-1" }] };
      if (sql.includes("INSERT INTO channel_connections")) return { rows: [{ id: "connection-1" }] };
      if (sql.includes("INSERT INTO agent_website_deployments")) return { rows: [deployment] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const repository = new WebsiteDeploymentRepository(pool);

    const result = await repository.create({
      organizationId: "workspace-1",
      sourceInstallationId: "test-installation-1",
      actorId: "member-1",
      origins: ["https://support.example.test"],
      configuration: {},
    });

    expect(result).toEqual(deployment);
    const installQuery = queries.find(({ sql }) => sql.includes("INSERT INTO agent_installations"));
    expect(installQuery?.sql).toContain("SELECT source.organization_id, source.agent_definition_id, source.agent_version_id");
    const liveSettings = JSON.parse(installQuery?.values?.[4] as string);
    expect(liveSettings).toMatchObject({
      environment: "live",
      source: "website",
      bindingRevision: "system-default",
      bindingStatus: "ready",
    });

    const currentVersion = { version_id: "version-1", version_number: 1, status: "published", checksum: "digest-1", extension_snapshot_id: null, extension_snapshot_checksum: null };
    const candidateVersion = { ...currentVersion, version_id: "version-2", version_number: 2, checksum: "digest-2", owner_type: "organization", protected: false };
    const preflightQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "live-installation-1",
        organization_id: "workspace-1",
        agent_definition_id: "agent-1",
        agent_version_id: "version-1",
        execution_mode: "kasitek_hosted",
        release_mode: "pinned",
        settings: liveSettings,
        status: "active",
      }] })
      .mockResolvedValueOnce({ rows: [currentVersion] })
      .mockResolvedValueOnce({ rows: [candidateVersion] })
      .mockResolvedValueOnce({ rows: [{
        id: "test-installation-1",
        organization_id: "workspace-1",
        agent_definition_id: "agent-1",
        agent_version_id: "version-2",
        execution_mode: "kasitek_hosted",
        status: "active",
        settings: { environment: "playground" },
      }] })
      .mockResolvedValueOnce({ rows: [{ digest: "test-capabilities" }] });
    const preflight = await new AgentDeploymentModule().preflightInstallation(
      { query: preflightQuery } as never,
      "workspace-1",
      "live-installation-1",
      { versionId: "version-2", sourceInstallationId: "test-installation-1", expectedVersionId: "version-1" },
    );
    expect(preflight).toMatchObject({ ready: true, status: "ready", candidate: { versionId: "version-2" }, current: { versionId: "version-1" }, bindingRevision: "system-default", blockers: [] });
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
