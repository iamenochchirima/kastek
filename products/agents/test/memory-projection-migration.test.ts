import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("memory projection migrations", () => {
  it("defines canonical-scope projection queues and rebuildable local indexes", async () => {
    const sql = await readFile(new URL("../migrations/135_memory_projection_outbox.sql", import.meta.url), "utf8");
    for (const table of [
      "agent_memory_projection_outbox",
      "agent_memory_projection_readiness",
      "agent_memory_fts_projections",
      "agent_memory_temporal_projections",
      "agent_memory_vector_projections",
    ]) {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS " + table);
    }
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("kasitek_enqueue_memory_projection_work");
    expect(sql).toContain("kasitek_validate_memory_projection_scope");
    expect(sql).toContain("readiness_state");
    expect(sql).toContain("vector(1536)");
  });

  it("keeps provider acceptance, indexing, and visibility as separate receipts", async () => {
    const sql = await readFile(new URL("../migrations/136_memory_provider_projection_receipts.sql", import.meta.url), "utf8");
    expect(sql).toContain("agent_memory_provider_projection_receipts");
    expect(sql).toContain("provider_state IN ('accepted', 'indexed', 'visible', 'failed', 'deleted')");
    expect(sql).toContain("provider_record_id");
    expect(sql).toContain("kasitek_validate_memory_provider_projection_scope");
    expect(sql).toContain("ALTER TABLE agent_memory_provider_projection_receipts FORCE ROW LEVEL SECURITY");
  });
});
