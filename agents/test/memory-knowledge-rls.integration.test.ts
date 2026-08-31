import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, query } from "../src/db/pool";
import { runWithDatabaseContext } from "../src/db/context";

const adminUrl = process.env.AGENTS_DATABASE_URL;
const restrictedUrl = process.env.AGENTS_RLS_TEST_DATABASE_URL;
const runIntegration = Boolean(adminUrl && restrictedUrl && process.env.RUN_AGENTS_RLS_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory and knowledge RLS (integration)", () => {
  const adminPool = createPool({ AGENTS_DATABASE_URL: adminUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const restrictedPool = createPool({ AGENTS_DATABASE_URL: restrictedUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const organizationA = `rls-org-a-${randomUUID()}`;
  const organizationB = `rls-org-b-${randomUUID()}`;
  const definitionA = randomUUID();
  const definitionB = randomUUID();
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const memoryA = randomUUID();
  const memoryB = randomUUID();
  const chunkA = randomUUID();
  const chunkB = randomUUID();

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [definitionA, organizationA, "RLS test A", `rls-${definitionA}`, "rls-test", definitionB, organizationB, "RLS test B", `rls-${definitionB}`, "rls-test"],
    );
    await adminPool.query(
      `INSERT INTO memory_records (id, organization_id, agent_definition_id, namespace, memory_type, canonical_text, source_type, created_by)
       VALUES ($1, $2, $3, 'agent_private', 'semantic', 'tenant A memory', 'explicit', 'rls-test'),
              ($4, $5, $6, 'agent_private', 'semantic', 'tenant B memory', 'explicit', 'rls-test')`,
      [memoryA, organizationA, definitionA, memoryB, organizationB, definitionB],
    );
    await adminPool.query(
      `INSERT INTO knowledge_sources (id, organization_id, agent_definition_id, name, source_type, created_by)
       VALUES ($1, $2, $3, 'Tenant A source', 'manual', 'rls-test'),
              ($4, $5, $6, 'Tenant B source', 'manual', 'rls-test')`,
      [sourceA, organizationA, definitionA, sourceB, organizationB, definitionB],
    );
    await adminPool.query(
      `INSERT INTO knowledge_chunks (id, source_id, organization_id, agent_definition_id, revision, chunk_index, canonical_text)
       VALUES ($1, $2, $3, $4, 1, 0, 'Tenant A knowledge'),
              ($5, $6, $7, $8, 1, 0, 'Tenant B knowledge')`,
      [chunkA, sourceA, organizationA, definitionA, chunkB, sourceB, organizationB, definitionB],
    );
  });

  it("keeps memory and knowledge rows inside the current organization", async () => {
    const rows = await runWithDatabaseContext({ organizationId: organizationA, actorId: "rls-test" }, async () => {
      const memories = await query<{ organization_id: string }>(restrictedPool, "SELECT organization_id FROM memory_records WHERE id IN ($1, $2)", [memoryA, memoryB]);
      const chunks = await query<{ organization_id: string }>(restrictedPool, "SELECT organization_id FROM knowledge_chunks WHERE id IN ($1, $2)", [chunkA, chunkB]);
      return { memories: memories.rows, chunks: chunks.rows };
    });
    expect(rows.memories).toEqual([{ organization_id: organizationA }]);
    expect(rows.chunks).toEqual([{ organization_id: organizationA }]);
  });

  it("rejects writes that claim another organization", async () => {
    await expect(runWithDatabaseContext({ organizationId: organizationA, actorId: "rls-test" }, () => query(
      restrictedPool,
      `INSERT INTO memory_records (organization_id, agent_definition_id, namespace, memory_type, canonical_text, source_type, created_by)
       VALUES ($1, $2, 'agent_private', 'semantic', 'cross tenant write', 'explicit', 'rls-test')`,
      [organizationB, definitionB],
    ))).rejects.toMatchObject({ code: "42501" });
  });

  it("allows only an explicit platform operator scope to inspect both test tenants", async () => {
    const result = await runWithDatabaseContext(
      { organizationId: "platform", actorId: "system:rls-test", operator: true },
      () => query<{ organization_id: string }>(restrictedPool, "SELECT organization_id FROM memory_records WHERE id IN ($1, $2) ORDER BY organization_id", [memoryA, memoryB]),
    );
    expect(result.rows).toEqual([{ organization_id: organizationA }, { organization_id: organizationB }]);
  });

  afterAll(async () => {
    await adminPool.query("DELETE FROM knowledge_chunks WHERE id IN ($1, $2)", [chunkA, chunkB]);
    await adminPool.query("DELETE FROM knowledge_sources WHERE id IN ($1, $2)", [sourceA, sourceB]);
    await adminPool.query("DELETE FROM memory_records WHERE id IN ($1, $2)", [memoryA, memoryB]);
    await adminPool.query("DELETE FROM agent_definitions WHERE id IN ($1, $2)", [definitionA, definitionB]);
    await restrictedPool.end();
    await adminPool.end();
  });
});
