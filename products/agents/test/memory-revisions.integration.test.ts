import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRevisionRepository } from "../src/db/repositories/memory-revision-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory revision domain (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const revisions = new MemoryRevisionRepository(pool);
  const organizationId = `memory-revisions-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const conversationId = randomUUID();
  let factId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1,$2,'Revision test',$3,'test')", [agentId, organizationId, `revision-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1,$2,1,'test','test','test','published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1,$2,$3,$4,'organization',$4,'kasitek_hosted','test')", [installationId, agentId, versionId, organizationId]);
    await pool.query("INSERT INTO conversations (id, installation_id, organization_id, external_conversation_id, title) VALUES ($1,$2,$3,$4,'Scope matrix test')", [conversationId, installationId, organizationId, conversationId]);
  });

  it("keeps current and historical truth in one stable fact lineage", async () => {
    const firstAt = new Date(Date.now() - 120_000).toISOString();
    const correctedAt = new Date(Date.now() - 60_000).toISOString();
    const fact = await revisions.createFact({ organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, namespace: "agent_private", memoryType: "semantic", subjectKey: "actor:user-1", predicateKey: "reply_style", factKey: `fact:${organizationId}:reply_style` });
    factId = fact.id;
    const first = await revisions.appendRevision(fact.id, {
      memoryType: "semantic", lifecycleState: "active", canonicalText: "Concise replies", typedValue: { value: "concise" }, validFrom: firstAt, observedAt: firstAt, sourceTrust: "user_explicit", evidenceDigest: "digest-concise", extractionVersion: "test-v1", sourceEventIds: ["event-concise"], idempotencyKey: "revision:concise", createdBy: "test",
    });
    const duplicate = await revisions.appendRevision(fact.id, {
      memoryType: "semantic", lifecycleState: "active", canonicalText: "Concise replies", typedValue: { value: "concise" }, validFrom: firstAt, observedAt: firstAt, sourceTrust: "user_explicit", evidenceDigest: "digest-concise", extractionVersion: "test-v1", sourceEventIds: ["event-concise"], idempotencyKey: "revision:concise", createdBy: "test",
    });
    expect(duplicate.status).toBe("replayed");
    const corrected = await revisions.appendRevision(fact.id, {
      memoryType: "semantic", transitionType: "correction", predecessorRevisionId: first.revision.id, lifecycleState: "active", canonicalText: "Detailed replies", typedValue: { value: "detailed" }, validFrom: correctedAt, observedAt: correctedAt, sourceTrust: "user_explicit", evidenceDigest: "digest-detailed", extractionVersion: "test-v1", sourceEventIds: ["event-detailed"], idempotencyKey: "revision:detailed", createdBy: "test",
    }, first.revision.id);
    expect((await revisions.resolveCurrent(organizationId, fact.id))?.id).toBe(corrected.revision.id);
    expect((await revisions.resolveCurrent(organizationId, fact.id, firstAt))?.id).toBe(first.revision.id);
    expect((await revisions.listRevisions(organizationId, fact.id))).toHaveLength(2);
    expect((await pool.query("SELECT relation_type FROM agent_memory_relations WHERE organization_id = $1 AND from_revision_id = $2 AND to_revision_id = $3", [organizationId, corrected.revision.id, first.revision.id])).rows[0]?.relation_type).toBe("supersedes");
  });

  it("allows only one compare-and-set correction to win", async () => {
    const current = await revisions.resolveCurrent(organizationId, factId);
    expect(current).not.toBeNull();
    const makeCorrection = (value: string) => revisions.appendRevision(factId, {
      memoryType: "semantic", transitionType: "correction", predecessorRevisionId: current!.id, lifecycleState: "active", canonicalText: value, typedValue: { value }, validFrom: new Date().toISOString(), observedAt: new Date().toISOString(), sourceTrust: "user_explicit", evidenceDigest: `digest-${value}`, extractionVersion: "test-v1", sourceEventIds: [`event-${value}`], idempotencyKey: `revision:${value}`, createdBy: "test",
    }, current!.id);
    const results = await Promise.allSettled([makeCorrection("one"), makeCorrection("two")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "MEMORY_STALE_EXPECTED_REVISION" });
  });

  it("reads each factual namespace only through its own scope tuple", async () => {
    const scopes = [
      { namespace: "end_user_private" as const, endUserId: "customer-scope-1", subjectKey: "customer-scope-1" },
      { namespace: "conversation" as const, conversationId, subjectKey: `conversation:${conversationId}` },
      { namespace: "agent_private" as const, subjectKey: `agent:${agentId}` },
      { namespace: "workspace_shared" as const, subjectKey: `workspace:${organizationId}` },
    ];
    const facts = await Promise.all(scopes.map(async (scope) => {
      const fact = await revisions.createFact({
        organizationId,
        workspaceId: organizationId,
        agentDefinitionId: agentId,
        agentVersionId: versionId,
        installationId,
        ...scope,
        memoryType: "semantic",
        predicateKey: "scope_matrix",
        factKey: "fact:scope-matrix",
      });
      await revisions.appendRevision(fact.id, {
        memoryType: "semantic", lifecycleState: "active", canonicalText: `${scope.namespace} value`, typedValue: { namespace: scope.namespace }, validFrom: new Date().toISOString(), sourceTrust: "user_explicit", evidenceDigest: `digest:${scope.namespace}`, extractionVersion: "scope-test-v1", sourceEventIds: [`event:${scope.namespace}`], idempotencyKey: `revision:scope:${scope.namespace}`, createdBy: "test",
      });
      return { ...scope, fact };
    }));
    for (const scope of facts) {
      await expect(revisions.findFact({
        organizationId,
        workspaceId: organizationId,
        agentDefinitionId: agentId,
        agentVersionId: versionId,
        installationId,
        ...scope,
        memoryType: "semantic",
        predicateKey: "scope_matrix",
        factKey: "fact:scope-matrix",
      })).resolves.toMatchObject({ id: scope.fact.id, namespace: scope.namespace });
    }
    await expect(revisions.findFact({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      namespace: "conversation",
      conversationId: randomUUID(),
      memoryType: "semantic",
      subjectKey: `conversation:${conversationId}`,
      predicateKey: "scope_matrix",
      factKey: "fact:scope-matrix",
    })).resolves.toBeNull();
    await expect(revisions.findFact({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      namespace: "end_user_private",
      endUserId: "another-customer",
      subjectKey: "customer-scope-1",
      predicateKey: "scope_matrix",
      factKey: "fact:scope-matrix",
      memoryType: "semantic",
    })).resolves.toBeNull();
  });

  it("persists extractor relations in the same transaction as the revision", async () => {
    const relatedFact = await revisions.createFact({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      namespace: "agent_private",
      memoryType: "semantic",
      subjectKey: "actor:related",
      predicateKey: "related_fact",
      factKey: `fact:${organizationId}:related`,
    });
    const related = await revisions.appendRevision(relatedFact.id, {
      memoryType: "semantic", lifecycleState: "active", canonicalText: "Related fact", typedValue: { value: "related" }, validFrom: new Date().toISOString(), sourceTrust: "user_explicit", evidenceDigest: "digest-related", extractionVersion: "test-v1", sourceEventIds: ["relation-source"], idempotencyKey: "revision:related", createdBy: "test",
    });
    const fromFact = await revisions.createFact({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      namespace: "agent_private",
      memoryType: "semantic",
      subjectKey: "actor:from",
      predicateKey: "derived_fact",
      factKey: `fact:${organizationId}:derived`,
    });
    const derived = await revisions.appendRevision(fromFact.id, {
      memoryType: "semantic", lifecycleState: "review_pending", canonicalText: "Derived fact", typedValue: { value: "derived" }, validFrom: new Date().toISOString(), sourceTrust: "model_inferred", evidenceDigest: "digest-derived", extractionVersion: "test-v1", sourceEventIds: ["relation-derived"], idempotencyKey: "revision:derived", createdBy: "test",
    }, undefined, [{ relationType: "derived_from", sourceEventId: "relation-source" }]);
    expect((await revisions.listRelations(organizationId, derived.revision.id)).map((relation) => relation.toRevisionId)).toContain(related.revision.id);

    const explicitRelation = await revisions.createRelation({
      organizationId,
      fromRevisionId: derived.revision.id,
      toRevisionId: related.revision.id,
      relationType: "about",
      metadata: { source: "first" },
      createdBy: "test",
    });
    await expect(revisions.createRelation({
      organizationId,
      fromRevisionId: derived.revision.id,
      toRevisionId: related.revision.id,
      relationType: "about",
      metadata: { source: "second" },
      createdBy: "other",
    })).resolves.toMatchObject({ id: explicitRelation.id, metadata: { source: "first" }, createdBy: "test" });
    await expect(pool.query("UPDATE agent_memory_relations SET metadata = '{}'::jsonb WHERE id = $1", [explicitRelation.id])).rejects.toThrow("Memory relations are immutable");

    const atomicFact = await revisions.createFact({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      namespace: "agent_private",
      memoryType: "semantic",
      subjectKey: "actor:atomic",
      predicateKey: "atomic_fact",
      factKey: `fact:${organizationId}:atomic`,
    });
    await expect(revisions.appendRevision(atomicFact.id, {
      memoryType: "semantic", lifecycleState: "review_pending", canonicalText: "Should roll back", typedValue: { value: "rollback" }, validFrom: new Date().toISOString(), sourceTrust: "model_inferred", evidenceDigest: "digest-rollback", extractionVersion: "test-v1", sourceEventIds: ["relation-rollback"], idempotencyKey: "revision:rollback", createdBy: "test",
    }, undefined, [{ relationType: "supports", sourceEventId: "missing-relation-source" }])).rejects.toThrow("MEMORY_RELATION_TARGET_NOT_FOUND");
    expect(await revisions.listRevisions(organizationId, atomicFact.id)).toHaveLength(0);
  });

  it("enqueues an explicit provider projection with the canonical revision", async () => {
    const fact = await revisions.createFact({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      namespace: "agent_private",
      memoryType: "semantic",
      subjectKey: "actor:provider",
      predicateKey: "provider_fact",
      factKey: `fact:${organizationId}:provider`,
    });
    const revision = await revisions.appendRevision(fact.id, {
      memoryType: "semantic", lifecycleState: "review_pending", canonicalText: "Provider projection fact", typedValue: { value: "provider" }, validFrom: new Date().toISOString(), sourceTrust: "model_inferred", evidenceDigest: "digest-provider", extractionVersion: "test-v1", sourceEventIds: ["provider-source"], idempotencyKey: "revision:provider", createdBy: "test",
      providerProjection: { providerName: "test-memory-provider", projectionVersion: "provider-v1", payload: { route: "test" } },
    });
    const providerTask = await pool.query<{ projection_kind: string; provider_name: string; payload: Record<string, unknown> }>(
      "SELECT projection_kind, provider_name, payload FROM agent_memory_projection_outbox WHERE revision_id = $1 AND projection_kind = 'provider'",
      [revision.revision.id],
    );
    expect(providerTask.rows).toHaveLength(1);
    expect(providerTask.rows[0]).toMatchObject({ projection_kind: "provider", provider_name: "test-memory-provider", payload: { route: "test" } });
    expect((await pool.query("SELECT readiness_state FROM agent_memory_projection_readiness WHERE revision_id = $1 AND projection_kind = 'provider'", [revision.revision.id])).rows[0]?.readiness_state).toBe("accepted");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_memory_relations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_memory_facts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
