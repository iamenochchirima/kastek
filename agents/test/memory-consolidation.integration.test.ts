import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { MemoryConsolidationJobRepository } from "../src/db/repositories/memory-consolidation-job-repository";
import { MemoryConsolidationWorker } from "../src/memory/consolidation-worker";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory consolidation (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const conversations = new ConversationRepository(pool);
  const jobsRepository = new MemoryConsolidationJobRepository(pool);
  const organizationId = `memory-consolidation-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  let conversationId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Consolidation test', $3, 'test')", [agentId, organizationId, `consolidation-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status, policy) VALUES ($1, $2, 1, 'test', 'test', 'test', 'published', $3::jsonb)", [versionId, agentId, JSON.stringify({ memory: { mode: "automatic", maxWritesPerRun: 3 } })]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', 'test')", [installationId, agentId, versionId, organizationId]);
    const conversation = await conversations.createConversation({ organizationId, installationId, conversationKind: "personal" });
    conversationId = conversation.id;
    for (let index = 0; index < 4; index += 1) {
      const runId = randomUUID();
      await pool.query(
        `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'message', 'completed', $7, 'test')`,
        [runId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
      );
      await conversations.appendMessage({
        organizationId,
        conversationId,
        direction: "inbound",
        content: { text: index === 0 ? "I prefer concise updates." : index === 3 ? "We decided that launches use the blue checklist." : `Context message ${index}` },
        runId,
      });
    }
  });

  it("enqueues one job per inbound run and proposes review-pending memories after the threshold", async () => {
    const jobs = await pool.query<{ id: string; status: string }>("SELECT id, status FROM memory_consolidation_jobs WHERE organization_id = $1 ORDER BY created_at", [organizationId]);
    expect(jobs.rows).toHaveLength(4);
    expect(jobs.rows.every((job) => job.status === "queued")).toBe(true);

    const [firstClaims, secondClaims] = await Promise.all([
      jobsRepository.claimDue("consolidation-a", 4, 120_000),
      jobsRepository.claimDue("consolidation-b", 4, 120_000),
    ]);
    expect(firstClaims.length + secondClaims.length).toBe(1);
    const claimed = firstClaims[0] ?? secondClaims[0];
    expect(claimed?.conversation_id).toBe(conversationId);
    await jobsRepository.markRetryable({
      jobId: claimed!.id,
      workerId: claimed!.lease_owner!,
      maxAttempts: 3,
      error: { code: "TEST_REQUEUE" },
    });

    const worker = new MemoryConsolidationWorker(pool, {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      minInboundMessages: 4,
    }, { workerId: "consolidation-test" });
    for (let index = 0; index < 4; index += 1) await worker.runOnce();

    const memories = await pool.query<{ status: string; provenance: Record<string, unknown> }>(
      "SELECT status, provenance FROM memory_records WHERE organization_id = $1 AND agent_definition_id = $2",
      [organizationId, agentId],
    );
    expect(memories.rows).toHaveLength(2);
    expect(memories.rows.every((memory) => memory.status === "review_pending")).toBe(true);
    expect(memories.rows.every((memory) => memory.provenance.extractionVersion === "deterministic-v1")).toBe(true);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
