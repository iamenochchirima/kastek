import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("memory retention and quality migrations", () => {
  it("defines policy precedence, quality evidence, and durable queues", async () => {
    const sql = await readFile(new URL("../migrations/137_memory_retention_quality.sql", import.meta.url), "utf8");
    for (const table of [
      "agent_memory_retention_rules",
      "agent_memory_quality_events",
      "agent_memory_revalidation_jobs",
      "agent_memory_conflicts",
      "agent_memory_maintenance_jobs",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain("revalidate_after_days");
    expect(sql).toContain("retention_days");
    expect(sql).toContain("idempotency_key");
    expect(sql).toContain("conflict_type IN ('fact_key', 'entity_overlap', 'validity_overlap', 'explicit_correction')");
    expect(sql).toContain("installation_id UUID NOT NULL REFERENCES agent_installations");
  });

  it("enforces tenant, workspace, installation, and revision boundaries", async () => {
    const sql = await readFile(new URL("../migrations/138_memory_retention_scope_validation.sql", import.meta.url), "utf8");
    for (const trigger of [
      "kasitek_validate_memory_retention_rule_scope",
      "kasitek_validate_memory_quality_event_scope",
      "kasitek_validate_memory_revalidation_job_scope",
      "kasitek_validate_memory_conflict_scope",
    ]) expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${trigger}`);
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("kasitek_agents_operator_scope");
    expect(sql).toContain("kasitek_prevent_memory_quality_event_mutation");
  });

  it("routes user, agent, and workspace forgetting through the durable deletion queue", async () => {
    const sql = await readFile(new URL("../migrations/140_memory_deletion_scope_targets.sql", import.meta.url), "utf8");
    expect(sql).toContain("'user', 'agent', 'workspace'");
    expect(sql).toContain("memory_deletion_jobs_scope_target_idx");
  });
});
