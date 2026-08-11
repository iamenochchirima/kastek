import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeRepository } from "../src/db/repositories/knowledge-repository";
import { MemoryRepository } from "../src/db/repositories/memory-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory and knowledge isolation (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const memory = new MemoryRepository(pool);
  const knowledge = new KnowledgeRepository(pool);
  const organizationId = `memory-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  let memoryId = "";
  let sourceId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Memory test', $3, 'test')", [agentId, organizationId, `memory-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1, $2, 1, 'test', 'test', 'test', 'published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'test')", [installationId, agentId, versionId, organizationId]);
  });

  it("retrieves only records in the caller's organization and scope", async () => {
    const created = await memory.createMemory({
      organizationId,
      agentId,
      installationId,
      namespace: "agent_private",
      memoryType: "semantic",
      canonicalText: "The user prefers short replies",
      sourceType: "explicit",
      actorId: "user-1",
    });
    memoryId = created.id;
    const found = await memory.searchMemory({ organizationId, agentId, installationId, actorId: "user-1" }, "prefers short replies");
    expect(found.map((entry) => entry.id)).toContain(memoryId);
    const otherAgent = await memory.searchMemory({ organizationId, agentId: randomUUID(), installationId, actorId: "user-1" }, "prefers short replies");
    expect(otherAgent.map((entry) => entry.id)).not.toContain(memoryId);
  });

  it("deletes canonical memory and records a deletion job", async () => {
    await memory.deleteMemory({ organizationId, agentId, installationId, actorId: "user-1" }, memoryId, "user-1");
    const found = await memory.searchMemory({ organizationId, agentId, installationId, actorId: "user-1" }, "prefers short replies");
    expect(found.map((entry) => entry.id)).not.toContain(memoryId);
  });

  it("ingests and retrieves knowledge chunks with provenance", async () => {
    const source = await knowledge.createSource({ organizationId, agentId, installationId, name: "Test source", sourceType: "manual", actorId: "user-1", provenance: { test: true } });
    sourceId = source.id;
    await knowledge.addChunks({ sourceId, scope: { organizationId, agentId, installationId }, revision: 1, chunks: [{ text: "Kasitek supports scoped knowledge retrieval", provenance: { source: "test" } }] });
    const found = await knowledge.search({ organizationId, agentId, installationId }, "scoped knowledge retrieval");
    expect(found[0]?.canonical_text).toContain("scoped knowledge");
    await knowledge.deleteSource({ organizationId, agentId, installationId }, sourceId, "user-1");
    expect(await knowledge.search({ organizationId, agentId, installationId }, "scoped knowledge retrieval")).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM memory_deletion_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM knowledge_chunks WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM knowledge_sources WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
