import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ExtensionSnapshotRepository, type ExtensionSnapshotRecord } from "../src/db/repositories/extension-snapshot-repository";
import type { ExtensionSnapshot } from "../src/extensions";

const organizationId = "org-extension";
const actorId = "actor-extension";
const versionId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";

function snapshot(): ExtensionSnapshot {
  return {
    id: "extension-snapshot-aaaaaaaaaaaaaaaaaaaaaaaa",
    checksum: "a".repeat(64),
    agentVersionId: versionId,
    skills: [],
    plugins: [],
    connectors: [],
    mcpCapabilities: [],
  };
}

function snapshotRow(): ExtensionSnapshotRecord {
  return {
    id: snapshotId,
    organization_id: organizationId,
    agent_version_id: versionId,
    snapshot_key: snapshot().id,
    checksum: snapshot().checksum,
    snapshot: snapshot(),
    created_by: actorId,
    created_at: "2026-09-07T00:00:00.000Z",
  };
}

function transactionalPool(responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    return responses.shift() ?? { rows: [], rowCount: 0 };
  });
  const client = { query: clientQuery, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  return { pool, clientQuery };
}

describe("ExtensionSnapshotRepository", () => {
  it("creates an immutable snapshot record through the owning agent version", async () => {
    const row = snapshotRow();
    const { pool, clientQuery } = transactionalPool([{ rows: [row] }]);
    const repository = new ExtensionSnapshotRepository(pool as never);

    const result = await repository.createSnapshot(organizationId, actorId, snapshot());

    expect(result).toEqual(row);
    expect(clientQuery.mock.calls[1]?.[0]).toContain("INSERT INTO agent_extension_snapshots");
    expect(clientQuery.mock.calls[1]?.[0]).toContain("JOIN agent_definitions");
    expect(clientQuery.mock.calls[1]?.[1]).toEqual([organizationId, versionId, snapshot().id, snapshot().checksum, JSON.stringify(snapshot()), actorId]);
  });

  it("persists declarative package dependencies and compatibility metadata", async () => {
    const packageRow = {
      id: "33333333-3333-4333-8333-333333333333",
      organization_id: organizationId,
      kind: "plugin",
      package_id: "support-plugin",
      version: "1.0.0",
      name: "Support plugin",
      checksum: "b".repeat(64),
      status: "draft",
      declaration: {
        kind: "plugin",
        id: "support-plugin",
        version: "1.0.0",
        checksum: "b".repeat(64),
        skillIds: ["support-skill"],
      },
      created_by: actorId,
      created_at: "2026-09-07T00:00:00.000Z",
      published_at: null,
      deprecated_at: null,
      revoked_at: null,
    };
    const { pool, clientQuery } = transactionalPool([{ rows: [packageRow] }, { rows: [] }, { rows: [] }]);
    const repository = new ExtensionSnapshotRepository(pool as never);

    const result = await repository.createPackage(organizationId, actorId, {
      declaration: packageRow.declaration,
      dependencies: [{ kind: "skill", id: "support-skill", versionConstraint: "1.0.0" }],
      compatibility: { minRuntimeVersion: "2.0.0", supportedChannels: ["web", "web"] },
    });

    expect(result.dependencies[0]).toMatchObject({ dependency_kind: "skill", dependency_id: "support-skill", version_constraint: "1.0.0" });
    expect(result.compatibility).toMatchObject({ min_runtime_version: "2.0.0", supported_channels: ["web"] });
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("agent_extension_package_dependencies"))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("agent_extension_package_compatibility"))).toBe(true);
  });

  it("pins a draft agent version only when the snapshot belongs to that version", async () => {
    const { pool } = { pool: { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ extension_snapshot_id: snapshotId }] })
      .mockResolvedValueOnce({ rows: [snapshotRow()] }) } };
    const repository = new ExtensionSnapshotRepository(pool as never);

    const result = await repository.pinVersion(organizationId, actorId, versionId, snapshotId);

    expect(result.id).toBe(snapshotId);
    expect(pool.query.mock.calls[0][0]).toContain("version.status = 'draft'");
    expect(pool.query.mock.calls[0][0]).toContain("snapshot.agent_version_id = version.id");
  });

  it("refuses to publish when a required declarative dependency is unavailable", async () => {
    const { pool, clientQuery } = transactionalPool([{ rows: [{ dependency_id: "support-skill" }] }]);
    const repository = new ExtensionSnapshotRepository(pool as never);

    await expect(repository.publishPackage(organizationId, actorId, "33333333-3333-4333-8333-333333333333"))
      .rejects.toThrow("EXTENSION_PACKAGE_DEPENDENCY_NOT_PUBLISHED");

    expect(clientQuery.mock.calls[1]?.[0]).toContain("NOT EXISTS");
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });

  it("reads only a run's already-admitted immutable snapshot", async () => {
    const row = snapshotRow();
    const pool = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const repository = new ExtensionSnapshotRepository(pool as never);

    const result = await repository.getRunAdmissionSnapshot(organizationId, "44444444-4444-4444-8444-444444444444");

    expect(result?.id).toBe(snapshotId);
    expect(pool.query.mock.calls[0][0]).toContain("run.extension_snapshot_id");
    expect(pool.query.mock.calls[0][0]).toContain("version.extension_snapshot_id = run.extension_snapshot_id");
    expect(pool.query.mock.calls[0][1]).toEqual([organizationId, "44444444-4444-4444-8444-444444444444"]);
  });

  it("validates a version pin for run admission without resolving current configuration", async () => {
    const row = snapshotRow();
    const pool = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const repository = new ExtensionSnapshotRepository(pool as never);

    const result = await repository.getVersionAdmissionSnapshot(pool as never, organizationId, versionId, snapshotId);

    expect(result?.id).toBe(snapshotId);
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toContain("version.extension_snapshot_id = $3");
    expect(sql).toContain("snapshot.agent_version_id = version.id");
    expect(sql).toContain("FOR SHARE OF version");
    expect(sql).not.toContain("FOR SHARE OF version, snapshot");
    expect(sql).not.toContain("version.configuration");
    expect(sql).not.toContain("version.policy");
    expect(values).toEqual([organizationId, versionId, snapshotId]);
  });

  it("resolves a version's pinned declarations and persists one deterministic snapshot", async () => {
    const row = snapshotRow();
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: versionId, configuration: {}, policy: {} }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] }) };
    const repository = new ExtensionSnapshotRepository(pool as never);

    const result = await repository.ensureSnapshotForVersion(pool as never, organizationId, actorId, versionId);

    expect(result).toEqual(row);
    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(pool.query.mock.calls[3][0]).toContain("INSERT INTO agent_extension_snapshots");
    expect(pool.query.mock.calls[3][1]?.[0]).toBe(organizationId);
    expect(pool.query.mock.calls[3][1]?.[1]).toBe(versionId);
  });

  it("projects pinned MCP revisions into the immutable capability snapshot", async () => {
    const row = snapshotRow();
    const providerVersionId = "33333333-3333-4333-8333-333333333333";
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: versionId, configuration: {}, policy: {} }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        provider_version_id: providerVersionId,
        provider_id: "mcp-notes",
        provider_name: "Notes",
        provider_status: "approved",
        health_status: "healthy",
        revision: 3,
        status: "published",
        protocol_version: "2025-06-18",
        tools: [{ name: "search", description: "Search notes", inputSchema: { type: "object" } }],
        checksum: "d".repeat(64),
      }] })
      .mockResolvedValueOnce({ rows: [row] }) };
    const repository = new ExtensionSnapshotRepository(pool as never);

    await repository.ensureSnapshotForVersion(pool as never, organizationId, actorId, versionId);

    const persistedSnapshot = JSON.parse(String(pool.query.mock.calls[3]?.[1]?.[4])) as {
      mcpCapabilities: Array<{ declaration: { id: string; providerId: string; toolName: string; version: string } }>;
    };
    expect(persistedSnapshot.mcpCapabilities).toEqual([
      expect.objectContaining({
        declaration: expect.objectContaining({
          id: `remote_mcp.${providerVersionId}.search`,
          providerId: "mcp-notes",
          toolName: "search",
          version: "3.0.0",
        }),
      }),
    ]);
  });

  it("rejects executable package declarations before storage", async () => {
    const pool = { query: vi.fn() };
    const repository = new ExtensionSnapshotRepository(pool as never);

    await expect(repository.createPackage(organizationId, actorId, {
      declaration: {
        kind: "plugin",
        id: "unsafe",
        version: "1.0.0",
        checksum: "c".repeat(64),
        handler: "not-allowed",
      } as never,
    })).rejects.toThrow("EXTENSION_PACKAGE_EXECUTABLE_NOT_ALLOWED");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("keeps the migration and repository lifecycle model insert-only for package content", async () => {
    const migration = await readFile(new URL("../migrations/111_agent_extension_snapshots.sql", import.meta.url), "utf8");

    expect(migration).toContain("agent_extension_package_dependencies");
    expect(migration).toContain("agent_extension_package_compatibility");
    expect(migration).toContain("agent_extension_snapshots_immutable");
    expect(migration).toContain("agent_versions_extension_snapshot_fk");
    expect(migration).toContain("prevent_agent_extension_package_content_mutation");
  });
});
