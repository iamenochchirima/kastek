import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { MemoryConsolidationJobRepository } from "../src/db/repositories/memory-consolidation-job-repository";
import { MemoryRevisionConsolidationWorker } from "../src/memory/revision-consolidation-worker";

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

    const firstJob = await pool.query<{ trigger_run_id: string }>("SELECT trigger_run_id FROM memory_consolidation_jobs WHERE organization_id = $1 ORDER BY created_at LIMIT 1", [organizationId]);
    await expect(jobsRepository.requestForcedFlush({
      organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      conversationId,
      triggerRunId: firstJob.rows[0]!.trigger_run_id,
      reason: "pre_compaction",
    })).resolves.toBe(true);
    await expect(pool.query<{ flush_reason: string }>("SELECT flush_reason FROM memory_consolidation_jobs WHERE organization_id = $1 AND trigger_run_id = $2", [organizationId, firstJob.rows[0]!.trigger_run_id]))
      .resolves.toMatchObject({ rows: [{ flush_reason: "pre_compaction" }] });

    const [firstClaims, secondClaims] = await Promise.all([
      jobsRepository.claimDue("consolidation-a", 4, 120_000, organizationId),
      jobsRepository.claimDue("consolidation-b", 4, 120_000, organizationId),
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

    // Simulate a lost worker: the successor may reclaim the expired lease,
    // while the old owner is fenced from completing it.
    const crashed = (await jobsRepository.claimDue("crashed-worker", 1, 120_000, organizationId))[0];
    expect(crashed).toBeDefined();
    await pool.query("UPDATE memory_consolidation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [crashed!.id]);
    const successor = (await jobsRepository.claimDue("successor-worker", 1, 120_000, organizationId))[0];
    expect(successor?.id).toBe(crashed!.id);
    await expect(jobsRepository.markCompleted({ jobId: crashed!.id, workerId: "crashed-worker", sourceMessageCount: 4, candidateCount: 2 })).resolves.toBe(false);
    await expect(jobsRepository.markRetryable({ jobId: successor!.id, workerId: "successor-worker", maxAttempts: 3, error: { code: "TEST_REQUEUE_AFTER_RECOVERY" } })).resolves.toBe("queued");

    // A bounded shutdown records the interruption and leaves the source job
    // queued for a successor rather than losing the evidence window.
    const interrupted = (await jobsRepository.claimDue("shutdown-worker", 1, 120_000, organizationId))[0];
    expect(interrupted).toBeDefined();
    await expect(jobsRepository.abandonLeases({ workerId: "shutdown-worker", reason: "MEMORY_WORKER_SHUTDOWN_TIMEOUT" })).resolves.toBe(1);
    await expect(pool.query<{ status: string; abandonment_count: number; last_abandoned_by: string; last_abandonment_reason: string }>(
      "SELECT status, abandonment_count, last_abandoned_by, last_abandonment_reason FROM memory_consolidation_jobs WHERE id = $1",
      [interrupted!.id],
    )).resolves.toMatchObject({ rows: [{ status: "queued", abandonment_count: 1, last_abandoned_by: "shutdown-worker", last_abandonment_reason: "MEMORY_WORKER_SHUTDOWN_TIMEOUT" }] });

    const worker = new MemoryRevisionConsolidationWorker(pool, {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      minInboundMessages: 4,
    }, { workerId: "consolidation-test" });
    for (let index = 0; index < 4; index += 1) await worker.runOnce(organizationId);

    const memories = await pool.query<{ lifecycle_state: string; provenance: Record<string, unknown> }>(
      `SELECT revision.lifecycle_state, revision.provenance
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       WHERE revision.organization_id = $1 AND fact.agent_definition_id = $2`,
      [organizationId, agentId],
    );
    expect(memories.rows).toHaveLength(2);
    expect(memories.rows.every((memory) => memory.lifecycle_state === "review_pending")).toBe(true);
    expect(memories.rows.every((memory) => memory.provenance.extractionVersion === "deterministic-v1")).toBe(true);

    // Replaying the same source run/extraction version is idempotent and does
    // not create another legacy candidate.
    await jobsRepository.requestForcedFlush({
      organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      conversationId,
      triggerRunId: firstJob.rows[0]!.trigger_run_id,
      reason: "operator",
    });
    await worker.runOnce(organizationId);
    const replayed = await pool.query(
      `SELECT revision.id
       FROM agent_memory_revisions revision
       JOIN agent_memory_facts fact ON fact.id = revision.fact_id
       WHERE revision.organization_id = $1 AND fact.agent_definition_id = $2`,
      [organizationId, agentId],
    );
    expect(replayed.rows).toHaveLength(2);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_relations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revision_sources WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revisions WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
