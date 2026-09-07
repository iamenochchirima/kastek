import { describe, expect, it, vi } from "vitest";
import { RunRepository } from "../src/db/repositories/run-repository";

const organizationId = "org-run-snapshot";
const installationId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const snapshotId = "55555555-5555-4555-8555-555555555555";

function poolWithInstallation(extensionSnapshotId: string | null, admissionRows: unknown[] = []) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM agent_installations")) {
      return {
        rows: [{
          agent_definition_id: "agent-definition",
          agent_version_id: versionId,
          extension_snapshot_id: extensionSnapshotId,
          status: "active",
          execution_mode: "kasitek_hosted",
          policy: {},
        }],
      };
    }
    if (sql.includes("FROM agent_versions version")) return { rows: admissionRows };
    return { rows: [] };
  });
  const client = { query: clientQuery, release: vi.fn() };
  return {
    pool: { connect: vi.fn(async () => client) },
    clientQuery,
  };
}

describe("RunRepository extension snapshot admission", () => {
  it("starts immutable snapshot initialization for an unpinned version", async () => {
    const { pool, clientQuery } = poolWithInstallation(null);
    const repository = new RunRepository(pool as never);

    await expect(repository.createRun(organizationId, "actor", {
      installationId,
      triggerType: "manual",
      input: { message: "hello" },
    })).rejects.toThrow("EXTENSION_SNAPSHOT_VERSION_NOT_FOUND");

    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("SELECT version.id, version.configuration"))).toBe(true);
  });

  it("rejects a snapshot that is not the version's immutable pin", async () => {
    const { pool, clientQuery } = poolWithInstallation(snapshotId);
    const repository = new RunRepository(pool as never);

    await expect(repository.createRun(organizationId, "actor", {
      installationId,
      triggerType: "manual",
      input: { message: "hello" },
    })).rejects.toThrow("EXTENSION_SNAPSHOT_RUN_ADMISSION_INVALID");

    const admissionQuery = clientQuery.mock.calls.find(([sql]) => sql.includes("FROM agent_versions version"));
    expect(admissionQuery?.[0]).toContain("version.extension_snapshot_id = $3");
    expect(admissionQuery?.[1]).toEqual([organizationId, versionId, snapshotId]);
  });
});
