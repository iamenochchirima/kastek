import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDeletionWorker } from "../src/memory/deletion-worker";
import { MemoryProviderDeletionWorker } from "../src/memory/provider-deletion-worker";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory v2 deletion and provider confirmation (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const organizationId = `memory-v2-delete-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const workspaceId = `workspace-${randomUUID()}`;
  const actorId = "memory-v2-deletion-test";
  const factIds: string[] = [];
  const deletionJobIds: string[] = [];
  const holdIds: string[] = [];
  const organizationSourceEventId = randomUUID();

  async function createFact(input: { provider?: boolean; text: string }): Promise<{ factId: string; revisionId: string }> {
    const factId = randomUUID();
    const revisionId = randomUUID();
    const digest = "a".repeat(64);
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO agent_memory_facts (
         id, organization_id, workspace_id, agent_definition_id, installation_id,
         agent_version_id, namespace, memory_type, subject_key, predicate_key,
         fact_key, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'agent_private', 'semantic', $7, $8, $9, $10)`,
      [factId, organizationId, workspaceId, agentId, installationId, versionId, `subject-${factId}`, "preference", `fact:${factId}`, actorId],
    );
    await pool.query(
      `INSERT INTO agent_memory_revisions (
         id, fact_id, organization_id, revision_number, transition_type,
         lifecycle_state, canonical_text, typed_value, valid_from, confidence,
         source_trust, sensitivity, provenance, evidence_digest, extraction_version,
         idempotency_key, operation_fingerprint, created_by
       ) VALUES ($1, $2, $3, 1, 'assertion', 'active', $4, '{"value":"test"}'::jsonb,
                 $5, 1, 'user_explicit', 'normal', '{}'::jsonb, $6, 'integration-v2', $7, $8, $9)`,
      [revisionId, factId, organizationId, input.text, now, digest, `memory-v2:${revisionId}`, digest, actorId],
    );
    if (input.provider) {
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
      // Exercise the local projection tables as well. They should disappear
      // through the canonical purge and the residual verifier.
      await pool.query(
        `INSERT INTO agent_memory_fts_projections (
           revision_id, fact_id, organization_id, workspace_id, agent_definition_id,
           agent_version_id, installation_id, lifecycle_state, sensitivity,
           canonical_text, search_vector, content_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'normal', $8,
                   to_tsvector('simple', $8), $9)`,
        [revisionId, factId, organizationId, workspaceId, agentId, versionId, installationId, input.text, digest],
      );
      await pool.query(
        `INSERT INTO agent_memory_temporal_projections (
           revision_id, fact_id, organization_id, workspace_id, agent_definition_id,
           agent_version_id, installation_id, memory_type, lifecycle_state,
           valid_from, source_event_ids
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'semantic', 'active', $8, '{}')`,
        [revisionId, factId, organizationId, workspaceId, agentId, versionId, installationId, now],
      );
    }
    factIds.push(factId);
    return { factId, revisionId };
  }

  async function createDeletionJob(targetId: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status, next_attempt_at)
       VALUES ($1, $2, 'memory', $3, 'queued', now()) RETURNING id::text`,
      [organizationId, actorId, targetId],
    );
    deletionJobIds.push(result.rows[0]!.id);
    return result.rows[0]!.id;
  }

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, 'Memory v2 deletion test', $3, $4)`,
      [agentId, organizationId, `memory-v2-delete-${agentId}`, actorId],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status)
       VALUES ($1, $2, 1, 'test', 'memory-v2-delete', $3, 'published')`,
      [versionId, agentId, actorId],
    );
    await pool.query(
      `INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by)
       VALUES ($1, $2, $3, $4, 'business', $5, 'kasitek_hosted', $6)`,
      [installationId, agentId, versionId, organizationId, workspaceId, actorId],
    );
    await pool.query(
      `INSERT INTO memory_source_events (
         id, organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, source_boundary, evidence, evidence_digest, redaction,
         occurred_at, idempotency_key, extraction_version
       ) VALUES ($1, $2, $3, $4, $5, $6, 'organization-delete-source', '{}'::jsonb,
                 $7, 'content_redacted', now(), $8, 'test')`,
      [organizationSourceEventId, organizationId, workspaceId, agentId, versionId, installationId, "e".repeat(64), `organization-delete:${organizationSourceEventId}`],
    );
  });

  it("purges local projections, then confirms remote deletion through a retry-safe adapter", async () => {
    const target = await createFact({ provider: true, text: "provider deletion target" });
    const unrelated = await createFact({ provider: false, text: "unrelated memory must remain" });
    const deletionJobId = await createDeletionJob(target.factId);

    const deletionWorker = new MemoryDeletionWorker(pool, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      holdRetryMs: 60_000,
    }, { workerId: "memory-v2-deletion" });
    await expect(deletionWorker.runOnce(organizationId)).resolves.toBe(1);

    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [deletionJobId])).rows[0]?.status).toBe("provider_pending");
    expect((await pool.query("SELECT id FROM agent_memory_facts WHERE id = $1", [target.factId])).rows).toHaveLength(0);
    for (const table of [
      "agent_memory_revisions",
      "agent_memory_projection_outbox",
      "agent_memory_projection_readiness",
      "agent_memory_fts_projections",
      "agent_memory_temporal_projections",
      "agent_memory_provider_projection_receipts",
    ]) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE fact_id = $1 LIMIT 1`, [target.factId])).rows).toHaveLength(0);
    }
    expect((await pool.query("SELECT id FROM agent_memory_facts WHERE id = $1", [unrelated.factId])).rows).toHaveLength(1);

    let failOnce = true;
    const adapter = {
      providerName: "fake-provider",
      delete: async (input: { operationId: string; providerRecordId: string }) => {
        expect(input.providerRecordId).toBe(`remote-${target.factId}`);
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("provider timed out"), { code: "PROVIDER_TIMEOUT" });
        }
      },
    };
    const providerWorker = new MemoryProviderDeletionWorker(pool, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
    }, { adapters: [adapter], workerId: "memory-v2-provider-deletion" });
    await expect(providerWorker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [deletionJobId])).rows[0]?.status).toBe("provider_pending");
    await pool.query("UPDATE agent_memory_provider_deletion_jobs SET next_attempt_at = now() - interval '1 second' WHERE deletion_job_id = $1", [deletionJobId]);
    await expect(providerWorker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [deletionJobId])).rows[0]?.status).toBe("completed");
    expect((await pool.query<{ status: string; last_error_code: string | null }>("SELECT status, last_error_code FROM agent_memory_provider_deletion_jobs WHERE deletion_job_id = $1", [deletionJobId])).rows[0]).toMatchObject({ status: "completed", last_error_code: null });
  });

  it("holds a purge, then resumes it without deleting an unrelated fact", async () => {
    const target = await createFact({ provider: false, text: "legal hold target" });
    const unrelated = await createFact({ provider: false, text: "legal hold unrelated" });
    const deletionJobId = await createDeletionJob(target.factId);
    const hold = await pool.query<{ id: string }>(
      `INSERT INTO agent_legal_holds (organization_id, scope_type, scope_id, reason, created_by)
       VALUES ($1, 'installation', $2, 'preserve deletion test', $3) RETURNING id::text`,
      [organizationId, installationId, actorId],
    );
    holdIds.push(hold.rows[0]!.id);
    const worker = new MemoryDeletionWorker(pool, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      holdRetryMs: 60_000,
    }, { workerId: "memory-v2-hold-deletion" });
    await expect(worker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [deletionJobId])).rows[0]?.status).toBe("held");
    expect((await pool.query("SELECT id FROM agent_memory_facts WHERE id = $1", [target.factId])).rows).toHaveLength(1);

    await pool.query("UPDATE agent_legal_holds SET status = 'released', released_by = $2, released_at = now() WHERE id = $1", [hold.rows[0]!.id, actorId]);
    await pool.query("UPDATE memory_deletion_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [deletionJobId]);
    await expect(worker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [deletionJobId])).rows[0]?.status).toBe("completed");
    expect((await pool.query("SELECT id FROM agent_memory_facts WHERE id = $1", [target.factId])).rows).toHaveLength(0);
    expect((await pool.query("SELECT id FROM agent_memory_facts WHERE id = $1", [unrelated.factId])).rows).toHaveLength(1);
  });

  it("purges source evidence for an organization deletion", async () => {
    const deletionJobId = await createDeletionJob(organizationId);
    await pool.query("UPDATE memory_deletion_jobs SET target_type = 'organization', target_id = $2 WHERE id = $1", [deletionJobId, organizationId]);
    const worker = new MemoryDeletionWorker(pool, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      holdRetryMs: 60_000,
    }, { workerId: "memory-v2-organization-deletion" });
    await expect(worker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [deletionJobId])).rows[0]?.status).toBe("completed");
    expect((await pool.query("SELECT id FROM memory_source_events WHERE id = $1", [organizationSourceEventId])).rows).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_memory_provider_deletion_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_deletion_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_legal_holds WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
