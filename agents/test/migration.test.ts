import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("foundation migration", () => {
  it("contains the durable scope and run tables", async () => {
    const sql = await readFile(new URL("../migrations/001_agent_platform_foundation.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_definitions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_versions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_installations");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_events");
    expect(sql).toContain("UNIQUE (conversation_id, sequence_number)");
    const modelCallsSql = await readFile(new URL("../migrations/002_model_calls.sql", import.meta.url), "utf8");
    expect(modelCallsSql).toContain("CREATE TABLE IF NOT EXISTS model_calls");
    expect(modelCallsSql).toContain("funding_source");
    const memorySql = await readFile(new URL("../migrations/003_memory_knowledge.sql", import.meta.url), "utf8");
    expect(memorySql).toContain("CREATE TABLE IF NOT EXISTS memory_records");
    expect(memorySql).toContain("CREATE TABLE IF NOT EXISTS knowledge_chunks");
    expect(memorySql).toContain("memory_deletion_jobs");
    const eventsSql = await readFile(new URL("../migrations/004_event_envelopes.sql", import.meta.url), "utf8");
    expect(eventsSql).toContain("spec_version");
    expect(eventsSql).toContain("data_content_type");
    const toolInvocationsSql = await readFile(new URL("../migrations/005_tool_invocations.sql", import.meta.url), "utf8");
    expect(toolInvocationsSql).toContain("CREATE TABLE IF NOT EXISTS tool_invocations");
    expect(toolInvocationsSql).toContain("arguments_hash");
    const runDurabilitySql = await readFile(new URL("../migrations/006_run_attempts_and_idempotency.sql", import.meta.url), "utf8");
    expect(runDurabilitySql).toContain("run_attempts");
    expect(runDurabilitySql).toContain("idempotency_key");
    const grantsSql = await readFile(new URL("../migrations/007_tool_grants.sql", import.meta.url), "utf8");
    expect(grantsSql).toContain("agent_tool_grants");
    expect(grantsSql).toContain("effective_idx");
  });
});
