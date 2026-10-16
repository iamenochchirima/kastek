import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { legacyMemoryChecksum, mapLegacyMemory } from "../src/memory/migration";

describe("canonical memory revision migration", () => {
  it("keeps summaries and procedures out of factual backfill while preserving scoped facts", () => {
    const base = { agent_definition_id: "agent-1", installation_id: "installation-1", workspace_id: "workspace-1" };
    expect(mapLegacyMemory({ ...base, namespace: "agent_private", memory_type: "working", status: "active" })).toMatchObject({ status: "skipped", reason: "summary_not_promoted" });
    expect(mapLegacyMemory({ ...base, namespace: "agent_private", memory_type: "procedural", status: "active" })).toMatchObject({ status: "skipped", reason: "procedural_separate" });
    expect(mapLegacyMemory({ ...base, namespace: "agent_private", memory_type: "semantic", status: "active" })).toMatchObject({ status: "migrated", namespace: "agent_private", memoryType: "semantic", lifecycleState: "active" });
  });

  it("produces a stable source checksum for migration receipts", () => {
    const row = { id: "legacy-1", canonical_text: "Customer prefers concise replies", content: { value: "concise" }, status: "active", fact_key: "reply_style", supersedes_memory_id: null, updated_at: "2026-09-07T00:00:00.000Z" } as never;
    expect(legacyMemoryChecksum(row)).toMatch(/^[a-f0-9]{64}$/);
    expect(legacyMemoryChecksum(row)).toBe(legacyMemoryChecksum({ ...row }));
  });

  it("defines append-only facts, revisions, source lineage, relations, and tenant policies", async () => {
    const sql = await readFile(new URL("../migrations/131_memory_revision_foundation.sql", import.meta.url), "utf8");
    for (const table of [
      "agent_memory_facts",
      "agent_memory_revisions",
      "agent_memory_revision_sources",
      "agent_memory_relations",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("operation_fingerprint");
    expect(sql).toContain("predecessor_revision_id");
    expect(sql).toContain("valid_from");
    expect(sql).toContain("valid_to");
    expect(sql).toContain("source_event_id");
    expect(sql).toContain("Memory revisions are immutable");
    expect(sql).toContain("kasitek_agents_current_org_scope");
  });

  it("closes relation scope drift and relation mutation in the follow-up guard", async () => {
    const sql = await readFile(new URL("../migrations/157_memory_relation_scope_and_immutability.sql", import.meta.url), "utf8");
    expect(sql).toContain("from_fact.workspace_id IS DISTINCT FROM to_fact.workspace_id");
    expect(sql).toContain("from_fact.installation_id IS DISTINCT FROM to_fact.installation_id");
    expect(sql).toContain("from_fact.end_user_id IS DISTINCT FROM to_fact.end_user_id");
    expect(sql).toContain("agent_memory_relations_immutable_trigger");
    expect(sql).toContain("Memory relations are immutable");
  });
});
