import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RetentionRepository } from "../src/db/repositories/retention-repository";
import { MemoryRetentionRepository } from "../src/db/repositories/memory-retention-repository";
import { MemoryRetentionWorker } from "../src/memory/retention-worker";
import { createOperatorCommand, approveOperatorCommand } from "../src/http/operator-commands";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("retention and legal-hold controls (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const retention = new RetentionRepository(pool);
  const memoryRetention = new MemoryRetentionRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  const organizationId = `retention-${randomUUID()}`;
  const actorId = `retention-operator-${randomUUID()}`;
  const secondActorId = `retention-operator-${randomUUID()}`;
  const commandDependencies = {
    pool,
    retention,
    memoryRetention,
    killSwitches,
    runs: undefined as never,
    effectReceipts: undefined as never,
  };
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const workspaceId = `workspace-${randomUUID()}`;
  const factId = randomUUID();
  const revisionId = randomUUID();
  const commandIds: string[] = [];
  let holdId = "";

  const workerSettings = {
    batchSize: 10,
    leaseMs: 120_000,
    pollIntervalMs: 5_000,
    maxAttempts: 3,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 10_000,
    retentionIntervalMs: 3_600_000,
    revalidationIntervalMs: 900_000,
    conflictIntervalMs: 300_000,
    candidateBatchSize: 100,
  };

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, 'Retention test agent', $3, $4)`,
      [agentId, organizationId, `retention-${agentId}`, actorId],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status)
       VALUES ($1, $2, 1, 'retention test', $3, $4, 'published')`,
      [versionId, agentId, `retention-${versionId}`, actorId],
    );
    await pool.query(
      `INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by)
       VALUES ($1, $2, $3, $4, 'business', $5, 'kasitek_hosted', $6)`,
      [installationId, agentId, versionId, organizationId, workspaceId, actorId],
    );
    const oldObservedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO agent_memory_facts (
         id, organization_id, workspace_id, agent_definition_id, installation_id,
         agent_version_id, namespace, memory_type, subject_key, predicate_key,
         fact_key, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'agent_private', 'semantic', $7, 'preference', $8, $9)`,
      [factId, organizationId, workspaceId, agentId, installationId, versionId, `subject-${factId}`, `retention:${factId}`, actorId],
    );
    await pool.query(
      `INSERT INTO agent_memory_revisions (
         id, fact_id, organization_id, revision_number, transition_type,
         lifecycle_state, canonical_text, typed_value, valid_from, observed_at,
         confidence, source_trust, sensitivity, provenance, evidence_digest,
         extraction_version, idempotency_key, operation_fingerprint, created_by
       ) VALUES ($1, $2, $3, 1, 'assertion', 'active', 'old canonical retention record',
                 '{"value":"retention"}'::jsonb, $4, $4, 1, 'user_explicit',
                 'normal', '{}'::jsonb, $5, 'retention-integration', $6, $5, $7)`,
      [revisionId, factId, organizationId, oldObservedAt, "a".repeat(64), `retention:${revisionId}`, actorId],
    );
  });

  it("keeps held canonical memory out of retention, then expires it after release", async () => {
    const policy = await retention.setPolicy({ organizationId, memoryDays: 30, conversationDays: 30, eventDays: 30, auditDays: 365, attachmentDays: 7, actorId });
    expect(policy).toMatchObject({ organization_id: organizationId, memory_days: 30, revision: 1 });

    const holdCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `legal-hold-${randomUUID()}`,
      command: { commandType: "create_legal_hold", targetId: organizationId, payload: { organizationId, scopeType: "organization", scopeId: organizationId, reason: "preserve for investigation" } },
      dependencies: commandDependencies,
    });
    commandIds.push(String(holdCommand.command.id));
    const createdHold = await approveOperatorCommand({ actorId: secondActorId, commandId: String(holdCommand.command.id), dependencies: commandDependencies });
    holdId = String((createdHold.result as { legalHoldId: string }).legalHoldId);
    expect(createdHold).toMatchObject({ status: "completed", result: { status: "active", legalHoldId: holdId } });
    expect((await retention.preview(organizationId)).eligible).toMatchObject({ memory: 0 });

    const worker = new MemoryRetentionWorker(pool, workerSettings, { workerId: `retention-test-${randomUUID()}` });
    const heldScan = await worker.runOnce(organizationId);
    expect(heldScan).toBeGreaterThanOrEqual(1);
    expect((await pool.query<{ lifecycle_state: string }>("SELECT lifecycle_state FROM agent_memory_revisions WHERE id = $1", [revisionId])).rows[0]?.lifecycle_state).toBe("active");

    const releaseCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `legal-release-${randomUUID()}`,
      command: { commandType: "release_legal_hold", targetId: holdId, payload: { expectedOrganizationId: organizationId, expectedStatus: "active" } },
      dependencies: commandDependencies,
    });
    commandIds.push(String(releaseCommand.command.id));
    expect(await approveOperatorCommand({ actorId: secondActorId, commandId: String(releaseCommand.command.id), dependencies: commandDependencies })).toMatchObject({ status: "completed", result: { status: "released", legalHoldId: holdId } });
    expect((await retention.preview(organizationId)).eligible).toMatchObject({ memory: 1 });

    const applyCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `retention-apply-${randomUUID()}`,
      command: { commandType: "apply_retention_policy", targetId: organizationId, payload: { expectedOrganizationId: organizationId } },
      dependencies: commandDependencies,
    });
    commandIds.push(String(applyCommand.command.id));
    const queued = await approveOperatorCommand({ actorId: secondActorId, commandId: String(applyCommand.command.id), dependencies: commandDependencies });
    expect(queued).toMatchObject({ status: "completed", result: { status: "queued", workspacesQueued: 1 } });

    const releasedScan = await worker.runOnce(organizationId);
    expect(releasedScan).toBeGreaterThanOrEqual(1);
    const revisions = await pool.query<{ lifecycle_state: string; transition_type: string; predecessor_revision_id: string | null }>(
      "SELECT lifecycle_state, transition_type, predecessor_revision_id::text FROM agent_memory_revisions WHERE fact_id = $1 ORDER BY revision_number",
      [factId],
    );
    expect(revisions.rows).toHaveLength(2);
    expect(revisions.rows[1]).toMatchObject({ lifecycle_state: "expired", transition_type: "expiration", predecessor_revision_id: revisionId });
    expect((await retention.preview(organizationId)).eligible).toMatchObject({ memory: 0 });

    const audit = await pool.query<{ id: string }>(
      "SELECT id::text FROM audit_records WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1",
      [organizationId],
    );
    const auditId = audit.rows[0]?.id;
    expect(auditId).toBeTruthy();
    await expect(pool.query("UPDATE audit_records SET action = 'tampered' WHERE id = $1", [auditId])).rejects.toThrow("append-only");
    await expect(pool.query("DELETE FROM audit_records WHERE id = $1", [auditId])).rejects.toThrow("append-only");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_operator_commands WHERE id = ANY($1::uuid[])", [commandIds]);
    await pool.query("DELETE FROM agent_memory_maintenance_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revisions WHERE fact_id = $1", [factId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE id = $1", [factId]);
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.query("DELETE FROM agent_legal_holds WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_retention_policies WHERE organization_id = $1", [organizationId]);
    await pool.end();
  });
});
