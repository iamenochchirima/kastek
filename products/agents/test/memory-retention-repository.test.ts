import { describe, expect, it, vi } from "vitest";
import { MemoryRetentionRepository } from "../src/db/repositories/memory-retention-repository";

describe("canonical memory retention requests", () => {
  it("queues v2 workspace maintenance without touching legacy memory rows", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ workspace_id: "workspace-1" }], rowCount: 1 }) };
    const repository = new MemoryRetentionRepository(pool as never);

    await expect(repository.requestRetentionScan("org-1")).resolves.toEqual({ queued: 1 });
    const sql = String(pool.query.mock.calls[0]?.[0]);
    expect(sql).toContain("agent_memory_maintenance_jobs");
    expect(sql).toContain("agent_memory_facts");
    expect(sql).not.toContain("memory_records");
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ["org-1"]);
  });
});
