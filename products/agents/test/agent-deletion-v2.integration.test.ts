import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { MemoryCheckpointRepository } from "../src/db/repositories/memory-checkpoint-repository";
import { MemoryDeletionWorker } from "../src/memory/deletion-worker";
import { MemoryProviderDeletionWorker } from "../src/memory/provider-deletion-worker";
import { createEvidenceItem, evidenceDigest } from "../src/memory/contracts";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

async function deleteMemoryEvidence(pool: Pool, organizationId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('kasitek.actor_id', 'system:memory-deletion', true)");
    await client.query("DELETE FROM memory_checkpoints WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM memory_source_events WHERE organization_id = $1", [organizationId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!runIntegration)("agent deletion and memory v2 cutover (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const checkpoints = new MemoryCheckpointRepository(pool);
  const organizationId = `agent-delete-v2-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const runId = randomUUID();
  const approvalGroupId = randomUUID();
  const actorId = "agent-delete-v2-test";
  const workspaceId = `workspace-${randomUUID()}`;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, 'Agent deletion v2', $3, $4)`,
      [agentId, organizationId, `agent-delete-v2-${agentId}`, actorId],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status)
       VALUES ($1, $2, 1, 'test', 'agent-delete-v2', $3, 'published')`,
      [versionId, agentId, actorId],
    );
    await pool.query(
      `INSERT INTO agent_installations
       (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
       VALUES ($1, $2, $3, $4, 'business', $5, 'kasitek_hosted', '{"environment":"playground"}', $6)`,
      [installationId, agentId, versionId, organizationId, workspaceId, actorId],
    );
    await pool.query(
      `INSERT INTO agent_runs
       (id, organization_id, agent_definition_id, agent_version_id, installation_id, trigger_type, status, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'completed', $6, $7)`,
      [runId, organizationId, agentId, versionId, installationId, randomUUID(), actorId],
    );
    await pool.query(
      `INSERT INTO agent_approval_groups
       (id, organization_id, installation_id, run_id, batch_id, turn_key, plan_digest, policy_revision, status, decision, decided_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1', 'consumed', 'approved', $8, now() + interval '1 hour')`,
      [approvalGroupId, organizationId, installationId, runId, `${runId}:batch:1`, "turn:1", "a".repeat(64), actorId],
    );
  });

  it("archives first, purges v2 evidence, confirms providers, then removes the agent", async () => {
    const item = createEvidenceItem({
      id: "agent-delete-message",
      actor: "end_user",
      occurredAt: "2026-09-08T00:00:00.000Z",
      sourceType: "message",
      rawContent: "The customer prefers concise replies.",
      includeContent: false,
    });
    const evidence = {
      contractVersion: "memory-v2" as const,
      scope: { organizationId, workspaceId, agentDefinitionId: agentId, agentVersionId: versionId, installationId },
      sourceEventIds: [item.id],
      items: [item],
      evidenceDigest: evidenceDigest([item]),
      redaction: "content_redacted" as const,
      capturedAt: item.occurredAt,
    };
    await checkpoints.commit({
      scope: { organizationId, workspaceId, agentDefinitionId: agentId, agentVersionId: versionId, installationId },
      runId,
      turnId: "turn-delete",
      compactionGeneration: 1,
      sourceBoundary: "messages:1-1",
      evidence,
      idempotencyKey: `agent-delete-v2:${agentId}`,
    });
    const sourceEventId = (await pool.query<{ id: string }>(
      "SELECT source_event_id AS id FROM memory_checkpoints WHERE organization_id = $1 AND run_id = $2",
      [organizationId, runId],
    )).rows[0]!.id;

    const factId = randomUUID();
    const revisionId = randomUUID();
    const digest = "d".repeat(64);
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO agent_memory_facts (
         id, organization_id, workspace_id, agent_definition_id, installation_id,
         agent_version_id, namespace, memory_type, subject_key, predicate_key,
         fact_key, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'agent_private', 'semantic', 'customer', 'reply_style', 'customer:reply_style', $7)`,
      [factId, organizationId, workspaceId, agentId, installationId, versionId, actorId],
    );
    await pool.query(
      `INSERT INTO agent_memory_revisions (
         id, fact_id, organization_id, revision_number, transition_type,
         lifecycle_state, canonical_text, typed_value, valid_from, confidence,
         source_trust, sensitivity, provenance, evidence_digest, extraction_version,
         idempotency_key, operation_fingerprint, created_by
       ) VALUES ($1, $2, $3, 1, 'assertion', 'active', 'Customer prefers concise replies', '{"value":"concise"}'::jsonb,
                 $4, 1, 'user_explicit', 'normal', '{}'::jsonb, $5, 'agent-delete-v2', $6, $5, $7)`,
      [revisionId, factId, organizationId, now, digest, `agent-delete-v2:${revisionId}`, actorId],
    );
    await pool.query(
      `INSERT INTO agent_memory_revision_sources
       (revision_id, organization_id, source_event_id, source_event_type, source_run_id, source_occurred_at, source_digest)
       VALUES ($1, $2, $3, 'checkpoint', $4, $5, $6)`,
      [revisionId, organizationId, sourceEventId, runId, now, digest],
    );
    await pool.query(
      `INSERT INTO agent_memory_provider_projection_receipts (
         organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, fact_id, revision_id, provider_name, provider_record_id,
         operation, provider_state, accepted_at, indexed_at, visible_at,
         provider_operation_id, content_digest
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'fake-provider', $8, 'upsert',
                 'visible', $9, $9, $9, $10, $11)`,
      [organizationId, workspaceId, agentId, versionId, installationId, factId, revisionId, `remote-${factId}`, now, `provider-op-${revisionId}`, digest],
    );

    const requested = await agents.deleteAgent(organizationId, actorId, agentId);
    expect(requested).toMatchObject({ agentId, deleted: false, status: "queued" });
    expect(requested.deletionJobId).toBeTruthy();
    expect((await pool.query<{ status: string }>("SELECT status FROM agent_definitions WHERE id = $1", [agentId])).rows[0]?.status).toBe("archived");
    expect((await pool.query<{ status: string }>("SELECT status FROM agent_installations WHERE id = $1", [installationId])).rows[0]?.status).toBe("disabled");

    const memoryWorker = new MemoryDeletionWorker(pool, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 1_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      holdRetryMs: 60_000,
    }, { workerId: `agent-delete-memory-${agentId}` });
    await expect(memoryWorker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [requested.deletionJobId])).rows[0]?.status).toBe("provider_pending");
    expect((await pool.query("SELECT 1 FROM memory_source_events WHERE agent_definition_id = $1", [agentId])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM memory_checkpoints WHERE agent_definition_id = $1", [agentId])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM agent_memory_facts WHERE agent_definition_id = $1", [agentId])).rows).toHaveLength(0);

    const providerWorker = new MemoryProviderDeletionWorker(pool, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 1_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
    }, {
      workerId: `agent-delete-provider-${agentId}`,
      adapters: [{
        providerName: "fake-provider",
        delete: async (input) => expect(input.providerRecordId).toBe(`remote-${factId}`),
      }],
    });
    await expect(providerWorker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [requested.deletionJobId])).rows[0]?.status).toBe("completed");

    await expect(memoryWorker.runOnce(organizationId)).resolves.toBe(0);
    expect((await pool.query("SELECT 1 FROM agent_definitions WHERE id = $1", [agentId])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM agent_installations WHERE id = $1", [installationId])).rows).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_memory_provider_deletion_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_deletion_jobs WHERE organization_id = $1", [organizationId]);
    await deleteMemoryEvidence(pool, organizationId);
    await pool.query("DELETE FROM agent_memory_relations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revision_sources WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revisions WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_approval_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_approval_groups WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
