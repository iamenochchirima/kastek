import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { OperatorControlRepository } from "../src/db/repositories/operator-control-repository";
import { MemoryRevisionConsolidationWorker } from "../src/memory/revision-consolidation-worker";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory rollout controls (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const conversations = new ConversationRepository(pool);
  const controls = new OperatorControlRepository(pool);
  const organizationId = `memory-rollout-${randomUUID()}`;
  const otherOrganizationId = `memory-rollout-other-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const conversationId = randomUUID();
  const runId = randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Memory rollout test', $3, 'test')",
      [agentId, organizationId, `memory-rollout-${agentId}`],
    );
    await pool.query(
      "INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status, policy) VALUES ($1, $2, 1, 'test', $3, 'test', 'published', $4::jsonb)",
      [versionId, agentId, `checksum-${versionId}`, JSON.stringify({ memory: { mode: "automatic" } })],
    );
    await pool.query(
      "INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', 'test')",
      [installationId, agentId, versionId, organizationId],
    );
    await pool.query(
      `INSERT INTO conversations (id, organization_id, installation_id, conversation_kind)
       VALUES ($1, $2, $3, 'personal')`,
      [conversationId, organizationId, installationId],
    );
    await pool.query(
      `INSERT INTO agent_runs
        (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id,
         trigger_type, status, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'message', 'completed', $7, 'test')`,
      [runId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
    );
    await conversations.appendMessage({
      organizationId,
      conversationId,
      direction: "inbound",
      content: { text: "I prefer concise updates." },
      runId,
    });
  });

  it("applies scoped memory flags and releases queued consolidation when disabled", async () => {
    const keys = ["memory_v2_writes_enabled", "memory_v2_retrieval_enabled", "memory_consolidation_enabled", "memory_projection_enabled"] as const;
    for (const flagKey of keys) {
      await expect(controls.isFeatureEnabled(organizationId, flagKey, installationId)).resolves.toBe(true);
      await expect(controls.isFeatureEnabled(otherOrganizationId, flagKey, randomUUID())).resolves.toBe(true);
      await controls.setFeatureFlag({
        scopeType: "organization",
        scopeId: organizationId,
        organizationId,
        flagKey,
        enabled: false,
        reason: "staged memory rollout test",
        expiresAt,
        actorId: "test-operator",
      });
      await expect(controls.isFeatureEnabled(organizationId, flagKey, installationId)).resolves.toBe(false);
      await expect(controls.isFeatureEnabled(otherOrganizationId, flagKey, randomUUID())).resolves.toBe(true);
    }

    await controls.setFeatureFlag({
      scopeType: "installation",
      scopeId: installationId,
      organizationId,
      flagKey: "memory_v2_retrieval_enabled",
      enabled: true,
      reason: "installation canary",
      expiresAt,
      actorId: "test-operator",
    });
    await expect(controls.isFeatureEnabled(organizationId, "memory_v2_retrieval_enabled", installationId)).resolves.toBe(true);
    await expect(controls.isFeatureEnabled(organizationId, "memory_v2_retrieval_enabled")).resolves.toBe(false);

    const worker = new MemoryRevisionConsolidationWorker(pool, {
      batchSize: 1,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      minInboundMessages: 1,
    }, { workerId: "memory-rollout-disabled-worker", controls });
    await expect(worker.runOnce(organizationId)).resolves.toBe(1);
    await expect(pool.query<{ status: string; attempt_count: number; last_error_code: string }>(
      `SELECT status, attempt_count, last_error_code
         FROM memory_consolidation_jobs
        WHERE organization_id = $1 AND trigger_run_id = $2`,
      [organizationId, runId],
    )).resolves.toMatchObject({ rows: [{ status: "queued", attempt_count: 0, last_error_code: "MEMORY_CONSOLIDATION_ROLLOUT_DISABLED" }] });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_operator_feature_flags WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
