import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { MemoryConsolidationJobRepository } from "../src/db/repositories/memory-consolidation-job-repository";
import { MemoryRevisionRepository } from "../src/db/repositories/memory-revision-repository";
import { MemoryRevisionConsolidationWorker } from "../src/memory/revision-consolidation-worker";
import { extractMemoryCandidates } from "../src/memory/consolidation";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory revision consolidation (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const conversations = new ConversationRepository(pool);
  const jobs = new MemoryConsolidationJobRepository(pool);
  const revisions = new MemoryRevisionRepository(pool);
  const organizationId = `memory-revision-worker-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  let conversationId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1,$2,'Revision consolidation test',$3,'test')", [agentId, organizationId, `revision-worker-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status, policy) VALUES ($1,$2,1,'test','test','test','published',$3::jsonb)", [versionId, agentId, JSON.stringify({ memory: { mode: "automatic" } })]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1,$2,$3,$4,'organization',$4,'kasitek_hosted','test')", [installationId, agentId, versionId, organizationId]);
    const conversation = await conversations.createConversation({ organizationId, installationId, conversationKind: "personal" });
    conversationId = conversation.id;
    const messages = [
      "I prefer concise updates.",
      "Please keep the launch notes short.",
      "We decided that launches use the blue checklist.",
      "Remember that customer replies should be concise.",
    ];
    for (const text of messages) {
      const runId = randomUUID();
      await pool.query(
        `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'test')`,
        [runId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
      );
      await conversations.appendMessage({ organizationId, conversationId, direction: "inbound", content: { text }, runId });
    }
  });

  it("replays leased jobs without duplicate canonical revisions", async () => {
    const worker = new MemoryRevisionConsolidationWorker(pool, {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 4,
      extractionTimeoutMs: 2_000,
    }, { workerId: "memory-revision-integration" });

    for (let index = 0; index < 4; index += 1) await worker.runOnce(organizationId);

    const facts = await pool.query<{ id: string; fact_key: string }>("SELECT id, fact_key FROM agent_memory_facts WHERE organization_id = $1", [organizationId]);
    const revisionsRows = await pool.query<{ id: string; lifecycle_state: string; source_trust: string }>(
      `SELECT revision.id, revision.lifecycle_state, revision.source_trust
         FROM agent_memory_revisions revision
        WHERE revision.organization_id = $1`,
      [organizationId],
    );
    const jobMetadata = await pool.query<{ extractor_model: string | null; extractor_provider: string | null }>(
      "SELECT extractor_model, extractor_provider FROM memory_consolidation_jobs WHERE organization_id = $1",
      [organizationId],
    );
    expect(facts.rows).toHaveLength(2);
    expect(new Set(facts.rows.map((row) => row.fact_key)).size).toBe(2);
    expect(revisionsRows.rows).toHaveLength(3);
    expect(revisionsRows.rows.every((row) => row.lifecycle_state === "review_pending" && row.source_trust === "model_inferred")).toBe(true);
    expect(jobMetadata.rows.every((row) => row.extractor_model === null && row.extractor_provider === null)).toBe(true);

    // The first job is replayed after completion. The stable fact and
    // revision idempotency key prevent a second canonical revision.
    const first = await pool.query<{ trigger_run_id: string }>("SELECT trigger_run_id FROM memory_consolidation_jobs WHERE organization_id = $1 ORDER BY created_at LIMIT 1", [organizationId]);
    await jobs.requestForcedFlush({
      organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      conversationId,
      triggerRunId: first.rows[0]!.trigger_run_id,
      reason: "operator",
    });
    await worker.runOnce(organizationId);
    expect((await pool.query("SELECT id FROM agent_memory_revisions WHERE organization_id = $1", [organizationId])).rows).toHaveLength(3);
  });

  it("keeps a message arriving during extraction eligible for a later job", async () => {
    const firstRunId = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'test')`,
      [firstRunId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
    );
    await conversations.appendMessage({ organizationId, conversationId, direction: "inbound", content: { text: "I prefer updates on Friday." }, runId: firstRunId });
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
    let appended = false;
    const worker = new MemoryRevisionConsolidationWorker(pool, {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 1,
      extractionTimeoutMs: 2_000,
    }, {
      workerId: "memory-revision-arrival-integration",
      extractor: {
        extract: async (evidence) => {
          if (!appended) {
            appended = true;
            const secondRunId = randomUUID();
            await pool.query(
              `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'test')`,
              [secondRunId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
            );
            await conversations.appendMessage({ organizationId, conversationId, direction: "inbound", content: { text: "Remember that Friday updates are concise." }, runId: secondRunId });
          }
          return extractMemoryCandidates(evidence);
        },
      },
    });
    await expect(worker.runOnce(organizationId)).resolves.toBe(1);
    const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_consolidation_jobs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1", [organizationId])).rows[0]?.status).toBe("queued");
    await expect(worker.runOnce(organizationId)).resolves.toBe(1);
  });

  it("replays a canonical revision after a process dies before job completion", async () => {
    const killOrganizationId = `memory-consolidation-kill-${randomUUID()}`;
    const killAgentId = randomUUID();
    const killVersionId = randomUUID();
    const killInstallationId = randomUUID();
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1,$2,'Consolidation kill test',$3,'test')", [killAgentId, killOrganizationId, `consolidation-kill-${killAgentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status, policy) VALUES ($1,$2,1,'test','test','test','published',$3::jsonb)", [killVersionId, killAgentId, JSON.stringify({ memory: { mode: "automatic" } })]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1,$2,$3,$4,'organization',$4,'kasitek_hosted','test')", [killInstallationId, killAgentId, killVersionId, killOrganizationId]);
    // The conversation row references the installation, so create it after
    // the installation record and use a fresh repository read.
    const killConversation = await new ConversationRepository(pool).createConversation({ organizationId: killOrganizationId, installationId: killInstallationId, conversationKind: "personal" });
    const killRunId = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'kill-test')`,
      [killRunId, killOrganizationId, killAgentId, killVersionId, killInstallationId, killConversation.id, randomUUID()],
    );
    await new ConversationRepository(pool).appendMessage({ organizationId: killOrganizationId, conversationId: killConversation.id, direction: "inbound", content: { text: "I prefer concise updates." }, runId: killRunId });

    const before = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM memory_consolidation_jobs WHERE organization_id = $1 ORDER BY created_at LIMIT 1",
      [killOrganizationId],
    );
    expect(before.rows).toHaveLength(1);

    const child = fork(fileURLToPath(new URL("./fixtures/memory-consolidation-kill-child.ts", import.meta.url)), [], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      execArgv: ["--import", "tsx"],
      env: { ...process.env, AGENTS_DATABASE_URL: databaseUrl, MEMORY_KILL_ORGANIZATION_ID: killOrganizationId, MEMORY_KILL_WORKER_ID: "kill-worker-1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });

    try {
      const [message] = await once(child, "message");
      expect(message).toMatchObject({ type: "revision-committed" });
      child.kill("SIGKILL");
      const [exitCode, signal] = await once(child, "exit");
      expect(exitCode).toBeNull();
      expect(signal).toBe("SIGKILL");
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    // Expire the successor boundary explicitly rather than waiting for the
    // repository's production 30-second minimum lease. This is the same
    // database transition the lease clock would make after worker death.
    await pool.query("UPDATE memory_consolidation_jobs SET lease_expires_at = now(), next_attempt_at = now() WHERE id = $1 AND status = 'running'", [before.rows[0]!.id]);
    const successor = new MemoryRevisionConsolidationWorker(pool, {
      batchSize: 1,
      leaseMs: 500,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 1,
      extractionTimeoutMs: 2_000,
    }, { workerId: "kill-worker-2" });
    await expect(successor.runOnce(killOrganizationId)).resolves.toBe(1);

    const after = await pool.query<{ status: string; attempt_count: number }>("SELECT status, attempt_count FROM memory_consolidation_jobs WHERE id = $1", [before.rows[0]!.id]);
    expect(after.rows[0]).toMatchObject({ status: "completed" });
    expect(Number(after.rows[0]?.attempt_count)).toBeGreaterThanOrEqual(2);
    const revisionsAfter = await pool.query<{ idempotency_key: string }>("SELECT idempotency_key FROM agent_memory_revisions WHERE organization_id = $1", [killOrganizationId]);
    expect(revisionsAfter.rows.length).toBeGreaterThan(0);
    expect(new Set(revisionsAfter.rows.map(row => row.idempotency_key)).size).toBe(revisionsAfter.rows.length);

    await pool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM agent_memory_relations WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM agent_memory_revisions WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [killOrganizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [killAgentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [killAgentId]);
  }, 15_000);

  afterAll(async () => {
    await pool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_relations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
