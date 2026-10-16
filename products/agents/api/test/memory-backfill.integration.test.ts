import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/db/repositories/memory-repository";
import { MemoryProjectionRepository } from "../src/db/repositories/memory-projection-repository";
import { MemoryRevisionRetrievalRepository } from "../src/db/repositories/memory-revision-retrieval-repository";
import { MemoryProjectionWorker } from "../src/memory/projection-worker";
import { MemoryBackfillService } from "../src/memory/migration";
import { OperatorControlRepository } from "../src/db/repositories/operator-control-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory v2 legacy backfill (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const organizationId = `memory-backfill-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const semanticId = randomUUID();
  const episodicId = randomUUID();
  const workingId = randomUUID();
  const proceduralId = randomUUID();
  const unscopedId = randomUUID();
  const backfill = new MemoryBackfillService(pool);
  const legacyMemory = new MemoryRepository(pool);
  const v2Retrieval = new MemoryRevisionRetrievalRepository(pool);
  const projections = new MemoryProjectionRepository(pool);
  const controls = new OperatorControlRepository(pool);

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1,$2,'Backfill test',$3,'test')",
      [agentId, organizationId, `backfill-${agentId}`],
    );
    await pool.query(
      "INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1,$2,1,'test','backfill-test','test','published')",
      [versionId, agentId],
    );
    await pool.query(
      "INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1,$2,$3,$4,'organization',$4,'kasitek_hosted','test')",
      [installationId, agentId, versionId, organizationId],
    );

    const insert = async (input: {
      id: string;
      memoryType: "semantic" | "episodic" | "working" | "procedural";
      canonicalText: string;
      factKey?: string;
      agentDefinitionId?: string | null;
      installationId?: string | null;
      sourceType?: "explicit" | "imported" | "inferred";
    }) => {
      await pool.query(
        `INSERT INTO memory_records (
           id, organization_id, agent_definition_id, installation_id, namespace, memory_type,
           canonical_text, content, source_type, provenance, sensitivity, confidence, fact_key,
           status, created_by
         ) VALUES ($1,$2,$3,$4,'agent_private',$5,$6,$7::jsonb,$8,$9::jsonb,'normal',0.9,$10,'active','test')`,
        [
          input.id,
          organizationId,
          input.agentDefinitionId === undefined ? agentId : input.agentDefinitionId,
          input.installationId === undefined ? installationId : input.installationId,
          input.memoryType,
          input.canonicalText,
          JSON.stringify({ value: input.canonicalText }),
          input.sourceType ?? "explicit",
          JSON.stringify({ source: "legacy-fixture" }),
          input.factKey ?? null,
        ],
      );
    };

    await insert({ id: semanticId, memoryType: "semantic", canonicalText: "Customer prefers concise replies", factKey: "reply_style" });
    await insert({ id: episodicId, memoryType: "episodic", canonicalText: "Customer completed onboarding", factKey: "onboarding_complete" });
    await insert({ id: workingId, memoryType: "working", canonicalText: "Temporary working summary" });
    await insert({ id: proceduralId, memoryType: "procedural", canonicalText: "Always verify identity", factKey: "verify_identity" });
    await insert({ id: unscopedId, memoryType: "semantic", canonicalText: "Missing installation scope", installationId: null });
  });

  it("dry-runs and then migrates only supported scoped memories with receipts", async () => {
    const dryRun = await backfill.run({ organizationId, dryRun: true });
    expect(dryRun).toMatchObject({ dryRun: true, scanned: 5, migrated: 2, skipped: 3, failed: 0, receipts: 5 });
    expect(dryRun.sourceCounts).toMatchObject({
      organization: { [organizationId]: 5 },
      workspace: { [organizationId]: 4, __missing__: 1 },
      agent: { [agentId]: 5 },
      namespace: { agent_private: 5 },
      state: { active: 5 },
      type: { semantic: 2, episodic: 1, working: 1, procedural: 1 },
      sensitivity: { normal: 5 },
    });
    expect(Object.values(dryRun.targetCounts).every(dimension => Object.keys(dimension).length === 0)).toBe(true);

    const dryReceipts = await pool.query<{ legacy_memory_id: string; status: string; canonical_revision_id: string | null }>(
      "SELECT legacy_memory_id::text, status, canonical_revision_id FROM agent_memory_migration_receipts WHERE organization_id = $1 ORDER BY legacy_memory_id",
      [organizationId],
    );
    expect(dryReceipts.rows).toHaveLength(5);
    expect(dryReceipts.rows.every((row) => row.status === "dry_run" || row.status === "skipped")).toBe(true);
    expect(dryReceipts.rows.every((row) => row.canonical_revision_id === null)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM agent_memory_revisions WHERE organization_id = $1", [organizationId])).rows[0]?.count).toBe(0);

    const migrated = await backfill.run({ organizationId, dryRun: false });
    expect(migrated).toMatchObject({ dryRun: false, scanned: 5, migrated: 2, skipped: 3, failed: 0, receipts: 5 });
    expect(migrated.targetCounts).toMatchObject({
      organization: { [organizationId]: 2 },
      workspace: { [organizationId]: 2 },
      agent: { [agentId]: 2 },
      namespace: { agent_private: 2 },
      state: { active: 2 },
      type: { semantic: 1, episodic: 1 },
      sensitivity: { normal: 2 },
    });

    const embeddingProvider = {
      provider: "backfill-fixture",
      model: "backfill-fixture-v1",
      dimensions: 1_536,
      embed: async (texts: readonly string[]) => texts.map(() => new Array(1_536).fill(0)),
    };
    await projections.enqueueRebuild({ organizationId, workspaceId: organizationId, limit: 50 });
    await controls.setFeatureFlag({
      scopeType: "organization",
      scopeId: organizationId,
      organizationId,
      flagKey: "memory_projection_enabled",
      enabled: false,
      reason: "pause projection rollout for backfill fixture",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      actorId: "test-operator",
    });
    const projectionWorker = new MemoryProjectionWorker(pool, {
      batchSize: 50,
      leaseMs: 120_000,
      pollIntervalMs: 1_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
    }, { embeddingProvider, controls, workerId: `backfill-projection-${organizationId}` });
    const pausedProjectionTasks = await projectionWorker.runOnce(organizationId);
    expect(pausedProjectionTasks).toBe(6);
    const pausedReadiness = await pool.query("SELECT readiness_state, last_error_code FROM agent_memory_projection_readiness WHERE organization_id = $1 ORDER BY projection_kind", [organizationId]);
    expect(pausedReadiness.rows).toHaveLength(6);
    expect(pausedReadiness.rows.every((row) => row.readiness_state === "accepted" && row.last_error_code === "MEMORY_PROJECTION_ROLLOUT_DISABLED")).toBe(true);
    await pool.query("UPDATE agent_memory_projection_outbox SET next_attempt_at = now() WHERE organization_id = $1", [organizationId]);
    await controls.setFeatureFlag({
      scopeType: "organization",
      scopeId: organizationId,
      organizationId,
      flagKey: "memory_projection_enabled",
      enabled: true,
      reason: "resume projection rollout for backfill fixture",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      actorId: "test-operator",
    });
    const claimedProjectionTasks = await projectionWorker.runOnce(organizationId);
    expect(claimedProjectionTasks).toBe(6);
    await expect(projectionWorker.runOnce(organizationId)).resolves.toBe(0);
    const readinessRows = await pool.query("SELECT projection_kind, readiness_state, last_error_code FROM agent_memory_projection_readiness WHERE organization_id = $1 ORDER BY projection_kind", [organizationId]);
    expect(claimedProjectionTasks).toBe(6);
    expect(readinessRows.rows).toHaveLength(6);
    expect(readinessRows.rows.every((row) => row.readiness_state === "visible" && row.last_error_code === null)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM agent_memory_revisions WHERE organization_id = $1 AND visible_at IS NOT NULL", [organizationId])).rows[0]?.count).toBe(2);

    const legacyResults = await legacyMemory.searchMemory({ organizationId, agentId, installationId, actorId: "test" }, "Customer prefers concise replies");
    const v2Results = await v2Retrieval.search({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      memoryKinds: ["semantic"],
      query: "Customer prefers concise replies",
      freshness: "current",
      readableNamespaces: ["agent_private"],
      limit: 10,
    });
    const legacyEpisodicResults = await legacyMemory.searchMemory({ organizationId, agentId, installationId, actorId: "test" }, "Customer completed onboarding");
    const v2EpisodicResults = await v2Retrieval.search({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      memoryKinds: ["episodic"],
      query: "Customer completed onboarding",
      freshness: "historical",
      readableNamespaces: ["agent_private"],
      limit: 10,
    });
    expect(legacyResults.map((row) => row.canonical_text)).toContain("Customer prefers concise replies");
    expect(v2Results.map((row) => row.text)).toContain("Customer prefers concise replies");
    expect(legacyEpisodicResults.map((row) => row.canonical_text)).toContain("Customer completed onboarding");
    expect(v2EpisodicResults.map((row) => row.text)).toContain("Customer completed onboarding");

    const revisions = await pool.query<{ canonical_text: string; provenance: Record<string, unknown>; lifecycle_state: string }>(
      "SELECT canonical_text, provenance, lifecycle_state FROM agent_memory_revisions WHERE organization_id = $1 ORDER BY canonical_text",
      [organizationId],
    );
    expect(revisions.rows).toHaveLength(2);
    expect(revisions.rows.map((row) => row.canonical_text)).toEqual([
      "Customer completed onboarding",
      "Customer prefers concise replies",
    ]);
    expect(revisions.rows.every((row) => row.lifecycle_state === "active")).toBe(true);
    expect(revisions.rows.every((row) => typeof row.provenance.legacyMemoryId === "string" && typeof row.provenance.migrationChecksum === "string")).toBe(true);

    const receipts = await pool.query<{ legacy_memory_id: string; status: string; canonical_revision_id: string | null; skip_reason: string | null }>(
      "SELECT legacy_memory_id::text, status, canonical_revision_id, skip_reason FROM agent_memory_migration_receipts WHERE organization_id = $1",
      [organizationId],
    );
    expect(receipts.rows.filter((row) => row.status === "migrated")).toHaveLength(2);
    expect(receipts.rows.filter((row) => row.status === "skipped").map((row) => row.skip_reason).sort()).toEqual(["missing_scope", "procedural_separate", "summary_not_promoted"].sort());
    expect(receipts.rows.filter((row) => row.status === "migrated").every((row) => row.canonical_revision_id)).toBe(true);
  });

  it("is safe to rerun without creating duplicate revisions", async () => {
    const before = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_memory_revisions WHERE organization_id = $1", [organizationId]);
    const rerun = await backfill.run({ organizationId, dryRun: false });
    const after = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_memory_revisions WHERE organization_id = $1", [organizationId]);
    expect(rerun).toMatchObject({ migrated: 2, skipped: 3, failed: 0, receipts: 5 });
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_operator_feature_flags WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_provider_projection_receipts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_projection_outbox WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_projection_readiness WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_fts_projections WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_temporal_projections WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_vector_projections WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_migration_receipts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_relations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revision_sources WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_revisions WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
