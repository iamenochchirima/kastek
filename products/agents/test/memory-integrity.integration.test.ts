import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCheckpointRepository } from "../src/db/repositories/memory-checkpoint-repository";
import { MemorySourceEventRepository } from "../src/db/repositories/memory-source-event-repository";
import { MemoryRevisionRepository } from "../src/db/repositories/memory-revision-repository";
import { createEvidenceItem, evidenceDigest } from "../src/memory/contracts";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory v2 integrity guards (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const checkpoints = new MemoryCheckpointRepository(pool);
  const sources = new MemorySourceEventRepository(pool);
  const revisions = new MemoryRevisionRepository(pool);
  const organizationId = `memory-integrity-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const runId = randomUUID();
  let factId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1,$2,'Memory integrity test',$3,'test')", [agentId, organizationId, `memory-integrity-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1,$2,1,'test','test','test','published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1,$2,$3,$4,'organization',$4,'kasitek_hosted','test')", [installationId, agentId, versionId, organizationId]);
    await pool.query("INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, trigger_type, status, correlation_id, created_by) VALUES ($1,$2,$3,$4,$5,'manual','completed',$6,'test')", [runId, organizationId, agentId, versionId, installationId, randomUUID()]);
  });

  it("rejects every canonical fact scope mutation that leaves its installation tuple", async () => {
    const fact = await revisions.createFact({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      namespace: "agent_private",
      memoryType: "semantic",
      subjectKey: "actor:test",
      predicateKey: "preference",
      factKey: `fact:${organizationId}:integrity`,
    });
    factId = fact.id;
    const mutations = [
      ["workspace_id", "other-workspace"],
      ["organization_id", "other-organization"],
      ["agent_definition_id", randomUUID()],
      ["installation_id", randomUUID()],
      ["agent_version_id", randomUUID()],
      ["namespace", "conversation"],
      ["conversation_id", randomUUID()],
      ["end_user_id", "another-user"],
    ] as const;
    for (const [column, value] of mutations) {
      await expect(pool.query(`UPDATE agent_memory_facts SET ${column} = $2 WHERE id = $1`, [fact.id, value])).rejects.toThrow();
    }
  });

  it("freezes source evidence and only permits deletion through the deletion actor", async () => {
    const item = createEvidenceItem({ id: "integrity-message", actor: "end_user", occurredAt: "2026-09-08T00:00:00.000Z", sourceType: "message", rawContent: "A captured source", includeContent: false });
    const evidence = {
      contractVersion: "memory-v2" as const,
      scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId },
      sourceEventIds: [item.id],
      items: [item],
      evidenceDigest: evidenceDigest([item]),
      redaction: "content_redacted" as const,
      capturedAt: item.occurredAt,
    };
    const recorded = await sources.record({
      scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, runId, turnId: "integrity-turn" },
      eventType: "integrity.test",
      sourceBoundary: "integrity:source",
      evidence,
      idempotencyKey: "integrity:source",
    });
    await expect(pool.query("UPDATE memory_source_events SET evidence_digest = 'tampered' WHERE id = $1", [recorded.event.id])).rejects.toThrow();
    await expect(pool.query("DELETE FROM memory_source_events WHERE id = $1", [recorded.event.id])).rejects.toThrow();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('kasitek.actor_id', 'system:memory-deletion', true)");
      await client.query("DELETE FROM memory_source_events WHERE id = $1", [recorded.event.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("keeps checkpoint identity immutable and enforces retryable lifecycle transitions", async () => {
    const item = createEvidenceItem({ id: "integrity-checkpoint-message", actor: "end_user", occurredAt: "2026-09-08T00:01:00.000Z", sourceType: "message", rawContent: "Checkpoint evidence", includeContent: false });
    const evidence = {
      contractVersion: "memory-v2" as const,
      scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId },
      sourceEventIds: [item.id],
      items: [item],
      evidenceDigest: evidenceDigest([item]),
      redaction: "content_redacted" as const,
      capturedAt: item.occurredAt,
    };
    const request = {
      scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId },
      runId,
      turnId: "integrity-checkpoint-turn",
      compactionGeneration: 1,
      sourceBoundary: "integrity:checkpoint",
      idempotencyKey: "integrity:checkpoint",
      evidence,
    };
    const committed = await checkpoints.commit(request);
    const committedRow = (await pool.query<{ id: string }>("SELECT id FROM memory_checkpoints WHERE organization_id = $1 AND idempotency_key = $2", [organizationId, request.idempotencyKey])).rows[0];
    expect(committed.status).toBe("committed");

    await expect(pool.query("UPDATE memory_checkpoints SET source_boundary = 'tampered' WHERE id = $1", [committedRow.id])).rejects.toThrow();
    await expect(pool.query("UPDATE memory_checkpoints SET organization_id = 'other-organization' WHERE id = $1", [committedRow.id])).rejects.toThrow();
    await expect(pool.query("UPDATE memory_checkpoints SET status = 'failed', committed_at = NULL, error_code = 'late-failure' WHERE id = $1", [committedRow.id])).rejects.toThrow();
    await expect(pool.query("UPDATE memory_checkpoints SET committed_at = NULL WHERE id = $1", [committedRow.id])).rejects.toThrow();
    await expect(pool.query("UPDATE memory_checkpoints SET error_code = 'stale-error' WHERE id = $1", [committedRow.id])).rejects.toThrow();

    const retryId = randomUUID();
    await pool.query(
      `INSERT INTO memory_checkpoints (
         id, organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, run_id, turn_id, compaction_generation, source_boundary,
         evidence_digest, idempotency_key, source_event_id, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,$9,$10,$11,
         (SELECT source_event_id FROM memory_checkpoints WHERE id = $12), 'requested')`,
      [retryId, organizationId, organizationId, agentId, versionId, installationId, runId, "integrity-retry-turn", "integrity:retry", evidence.evidenceDigest, "integrity:retry", committedRow.id],
    );
    await expect(pool.query("UPDATE memory_checkpoints SET status = 'failed', error_code = 'retryable' WHERE id = $1", [retryId])).resolves.toBeTruthy();
    await expect(pool.query("UPDATE memory_checkpoints SET status = 'committed', committed_at = now(), error_code = NULL, error_digest = NULL WHERE id = $1", [retryId])).resolves.toBeTruthy();
  });

  afterAll(async () => {
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
    await pool.query("DELETE FROM agent_memory_relations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revision_sources WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revisions WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
