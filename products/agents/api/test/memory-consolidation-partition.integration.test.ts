import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { MemoryConsolidationJobRepository } from "../src/db/repositories/memory-consolidation-job-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory consolidation partitioning (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const conversations = new ConversationRepository(pool);
  const jobs = new MemoryConsolidationJobRepository(pool);
  const organizationId = `memory-partition-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const conversationCount = Math.max(1, Number(process.env.MEMORY_PARTITION_CONVERSATIONS ?? 32));
  const workerCount = Math.max(1, Number(process.env.MEMORY_PARTITION_WORKERS ?? 4));
  const conversationIds: string[] = [];
  const runIdsByConversation = new Map<string, string[]>();

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1,$2,'Partition test',$3,'test')", [agentId, organizationId, `partition-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status, policy) VALUES ($1,$2,1,'test','test','test','published',$3::jsonb)", [versionId, agentId, JSON.stringify({ memory: { mode: "automatic" } })]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1,$2,$3,$4,'organization',$4,'kasitek_hosted','test')", [installationId, agentId, versionId, organizationId]);
    for (let conversationIndex = 0; conversationIndex < conversationCount; conversationIndex += 1) {
      const conversationId = (await conversations.createConversation({ organizationId, installationId, conversationKind: "personal" })).id;
      conversationIds.push(conversationId);
      const runIds: string[] = [];
      for (let messageIndex = 0; messageIndex < 2; messageIndex += 1) {
        const runId = randomUUID();
        runIds.push(runId);
        await pool.query(
          `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'test')`,
          [runId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
        );
        await conversations.appendMessage({ organizationId, conversationId, direction: "inbound", content: { text: `partition message ${conversationIndex}-${messageIndex}` }, runId });
      }
      runIdsByConversation.set(conversationId, runIds);
    }
  }, 60_000);

  it("claims one ordered job per conversation across concurrent workers", async () => {
    const workerLimit = Math.ceil(conversationCount / workerCount);
    const firstWorkers = await Promise.all(Array.from({ length: workerCount }, (_, index) =>
      jobs.claimDue(`partition-worker-${index}`, workerLimit, 120_000, organizationId)));
    const firstClaims = firstWorkers.flat();
    expect(firstClaims).toHaveLength(conversationCount);
    expect(new Set(firstClaims.map((job) => job.conversation_id))).toEqual(new Set(conversationIds));
    for (const job of firstClaims) {
      expect(job.trigger_run_id).toBe(runIdsByConversation.get(job.conversation_id)?.[0]);
      await jobs.markRetryable({ jobId: job.id, workerId: job.lease_owner!, maxAttempts: 3, retryAfterMs: 60_000, error: { code: "PARTITION_TEST_REQUEUE" } });
    }

    const secondWorkers = await Promise.all(Array.from({ length: workerCount }, (_, index) =>
      jobs.claimDue(`partition-worker-${index}-second`, workerLimit, 120_000, organizationId)));
    const secondClaims = secondWorkers.flat();
    expect(secondClaims).toHaveLength(conversationCount);
    expect(new Set(secondClaims.map((job) => job.conversation_id))).toEqual(new Set(conversationIds));
    for (const job of secondClaims) {
      expect(job.trigger_run_id).toBe(runIdsByConversation.get(job.conversation_id)?.[1]);
      await jobs.markRetryable({ jobId: job.id, workerId: job.lease_owner!, maxAttempts: 3, retryAfterMs: 60_000, error: { code: "PARTITION_TEST_REQUEUE" } });
    }
  });

  afterAll(async () => {
    await pool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1 OR conversation_id IN (SELECT id FROM conversations WHERE organization_id = $1)", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  }, 60_000);
});
