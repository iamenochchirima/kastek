import { describe, expect, it, vi } from "vitest";
import { ExtensionSnapshotRepository } from "../src/db/repositories/extension-snapshot-repository";

const organizationId = "org-canonical-extensions";
const actorId = "actor-canonical-extensions";
const versionId = "11111111-1111-4111-8111-111111111111";
const pluginChecksum = "a".repeat(64);
const skillChecksum = "b".repeat(64);

function version(configuration: Record<string, unknown>, policy: Record<string, unknown>) {
  return { id: versionId, configuration, policy };
}

function packageRow(input: {
  kind: "skill" | "plugin";
  id: string;
  version: string;
  checksum: string;
  status?: "draft" | "published" | "deprecated" | "revoked";
  organization_id?: string;
}) {
  return {
    id: `${input.kind}-package-version-id`,
    organization_id: input.organization_id ?? organizationId,
    kind: input.kind,
    package_id: input.id,
    version: input.version,
    name: input.id,
    checksum: input.checksum,
    status: input.status ?? "published",
    declaration: {
      kind: input.kind,
      id: input.id,
      version: input.version,
      checksum: input.checksum,
      available: true,
      installed: true,
      configured: true,
    },
    created_by: actorId,
    created_at: "2026-09-07T00:00:00.000Z",
    published_at: "2026-09-07T00:00:00.000Z",
    deprecated_at: null,
    revoked_at: input.status === "revoked" ? "2026-09-07T00:00:00.000Z" : null,
  };
}

function snapshotRow() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: organizationId,
    agent_version_id: versionId,
    snapshot_key: "extension-snapshot-canonical",
    checksum: "c".repeat(64),
    snapshot: {
      id: "extension-snapshot-canonical",
      checksum: "c".repeat(64),
      agentVersionId: versionId,
      skills: [],
      plugins: [],
      connectors: [],
      mcpCapabilities: [],
      selectedPackages: [],
    },
    created_by: actorId,
    created_at: "2026-09-07T00:00:00.000Z",
  };
}

function canonicalConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    extensions: {
      packages: [
        {
          kind: "skill",
          id: "support.skill",
          version: "1.0.0",
          checksum: skillChecksum,
          configuration: { locale: "en-ZA" },
        },
        {
          kind: "plugin",
          id: "support.plugin",
          version: "2.0.0",
          checksum: pluginChecksum,
          configuration: { queue: "support" },
        },
      ],
      ...overrides,
    },
  };
}

function canonicalPolicy() {
  return {
    extensions: {
      grants: [
        { kind: "skill", id: "support.skill", permissions: ["knowledge.read"] },
        { kind: "plugin", id: "support.plugin", permissions: ["tickets.write"] },
      ],
    },
  };
}

describe("ExtensionSnapshotRepository canonical package reconciliation", () => {
  it("resolves exact package rows and records immutable selection provenance", async () => {
    const insertRow = snapshotRow();
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [version(canonicalConfiguration(), canonicalPolicy())] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        packageRow({ kind: "skill", id: "support.skill", version: "1.0.0", checksum: skillChecksum }),
        packageRow({ kind: "plugin", id: "support.plugin", version: "2.0.0", checksum: pluginChecksum }),
      ] })
      .mockResolvedValueOnce({ rows: [insertRow] }) };
    const repository = new ExtensionSnapshotRepository(pool as never);

    const result = await repository.ensureSnapshotForVersion(pool as never, organizationId, actorId, versionId);

    const insertValues = pool.query.mock.calls[3]?.[1] as unknown[];
    const persistedSnapshot = JSON.parse(String(insertValues[4])) as {
      selectedPackages: Array<Record<string, unknown>>;
      skills: Array<{ declaration: { id: string } }>;
      plugins: Array<{ declaration: { id: string } }>;
    };
    expect(result).toEqual(insertRow);
    expect(persistedSnapshot.skills[0]?.declaration.id).toBe("support.skill");
    expect(persistedSnapshot.plugins[0]?.declaration.id).toBe("support.plugin");
    expect(persistedSnapshot.selectedPackages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        organizationId,
        packageVersionId: "skill-package-version-id",
        kind: "skill",
        id: "support.skill",
        version: "1.0.0",
        checksum: skillChecksum,
        status: "published",
        configuration: { locale: "en-ZA" },
        grantedPermissions: ["knowledge.read"],
      }),
      expect.objectContaining({
        packageVersionId: "plugin-package-version-id",
        kind: "plugin",
        id: "support.plugin",
        version: "2.0.0",
        checksum: pluginChecksum,
        grantedPermissions: ["tickets.write"],
      }),
    ]));
    expect(pool.query.mock.calls[2]?.[0]).toContain("organization_id = $1");
    expect(pool.query.mock.calls[2]?.[0]).toContain("package_id = $3");
  });

  it.each([
    ["missing", [], "EXTENSION_SNAPSHOT_PACKAGE_NOT_FOUND"],
    ["revoked", [packageRow({ kind: "plugin", id: "support.plugin", version: "2.0.0", checksum: pluginChecksum, status: "revoked" })], "EXTENSION_SNAPSHOT_PACKAGE_REVOKED"],
    ["checksum mismatch", [packageRow({ kind: "plugin", id: "support.plugin", version: "2.0.0", checksum: "d".repeat(64) })], "EXTENSION_SNAPSHOT_PACKAGE_CHECKSUM_MISMATCH"],
  ])("fails closed when the selected package is %s", async (_caseName, rows, error) => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [version({ extensions: { packages: [{ kind: "plugin", id: "support.plugin", version: "2.0.0", checksum: pluginChecksum }] } }, { extensions: { grants: [{ kind: "plugin", id: "support.plugin", permissions: ["tickets.write"] }] } })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows }) };
    const repository = new ExtensionSnapshotRepository(pool as never);

    await expect(repository.ensureSnapshotForVersion(pool as never, organizationId, actorId, versionId)).rejects.toThrow(error);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it("rejects canonical mcp_adapter selections instead of coercing or ignoring them", async () => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [version({ extensions: { packages: [{ kind: "mcp_adapter", id: "calendar.adapter", version: "1.0.0", checksum: "e".repeat(64) }] } }, { extensions: { grants: [{ kind: "mcp_adapter", id: "calendar.adapter", permissions: ["calendar.read"] }] } })] })
      .mockResolvedValueOnce({ rows: [] }) };
    const repository = new ExtensionSnapshotRepository(pool as never);

    await expect(repository.ensureSnapshotForVersion(pool as never, organizationId, actorId, versionId))
      .rejects.toThrow("EXTENSION_SNAPSHOT_MCP_ADAPTER_UNSUPPORTED");
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
