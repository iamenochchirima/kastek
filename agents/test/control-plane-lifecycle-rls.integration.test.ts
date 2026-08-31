import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, query } from "../src/db/pool";
import { runWithDatabaseContext } from "../src/db/context";

const adminUrl = process.env.AGENTS_DATABASE_URL;
const restrictedUrl = process.env.AGENTS_RLS_TEST_DATABASE_URL;
const runIntegration = Boolean(adminUrl && restrictedUrl && process.env.RUN_AGENTS_RLS_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("control-plane and lifecycle RLS (integration)", () => {
  const adminPool = createPool({ AGENTS_DATABASE_URL: adminUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const restrictedPool = createPool({ AGENTS_DATABASE_URL: restrictedUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const organizationA = `rls-control-a-${randomUUID()}`;
  const organizationB = `rls-control-b-${randomUUID()}`;
  const definitionA = randomUUID();
  const definitionB = randomUUID();
  const versionA = randomUUID();
  const versionB = randomUUID();
  const installationA = randomUUID();
  const installationB = randomUUID();
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const memoryJobA = randomUUID();
  const memoryJobB = randomUUID();
  const audioJobA = randomUUID();
  const audioJobB = randomUUID();
  const calendarEventA = randomUUID();
  const calendarEventB = randomUUID();
  const readinessA = randomUUID();
  const readinessB = randomUUID();
  const auditA = randomUUID();
  const auditB = randomUUID();
  const retentionA = randomUUID();
  const retentionB = randomUUID();
  const legalHoldA = randomUUID();
  const legalHoldB = randomUUID();
  const featureFlagA = randomUUID();
  const featureFlagB = randomUUID();
  let globalFeatureFlag = randomUUID();
  let globalFeatureFlagCreated = false;
  const operatorHoldA = randomUUID();
  const operatorHoldB = randomUUID();
  const commandId = randomUUID();
  const exportId = randomUUID();
  const notificationId = randomUUID();
  const projectionKey = `projection-${randomUUID()}`;
  const outboxA = `control-outbox-${randomUUID()}`;
  const outboxB = `control-outbox-${randomUUID()}`;

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, 'Control RLS A', $3, 'rls-test'), ($4, $5, 'Control RLS B', $6, 'rls-test')`,
      [definitionA, organizationA, `control-${definitionA}`, definitionB, organizationB, `control-${definitionB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, status, instructions, checksum, created_by)
       VALUES ($1, $2, 1, 'published', 'test', $3, 'rls-test'), ($4, $5, 1, 'published', 'test', $6, 'rls-test')`,
      [versionA, definitionA, `checksum-${versionA}`, versionB, definitionB, `checksum-${versionB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, status, created_by, execution_mode, release_mode)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'active', 'rls-test', 'kasitek_hosted', 'pinned'),
              ($5, $6, $7, $8, 'organization', $8, 'active', 'rls-test', 'kasitek_hosted', 'pinned')`,
      [installationA, definitionA, versionA, organizationA, installationB, definitionB, versionB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO conversations (id, installation_id, organization_id, channel_type, channel_key, external_conversation_id, conversation_kind)
       VALUES ($1, $2, $3, 'test', 'control', $4, 'test'), ($5, $6, $7, 'test', 'control', $8, 'test')`,
      [conversationA, installationA, organizationA, `conversation-${conversationA}`, conversationB, installationB, organizationB, `conversation-${conversationB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, input, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'message', 'completed', '{}'::jsonb, gen_random_uuid(), 'rls-test'),
              ($7, $8, $9, $10, $11, $12, 'message', 'completed', '{}'::jsonb, gen_random_uuid(), 'rls-test')`,
      [runA, organizationA, definitionA, versionA, installationA, conversationA, runB, organizationB, definitionB, versionB, installationB, conversationB],
    );
    await adminPool.query(
      `INSERT INTO memory_consolidation_jobs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_run_id, extraction_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'rls-test'), ($8, $9, $10, $11, $12, $13, $14, 'rls-test')`,
      [memoryJobA, organizationA, definitionA, versionA, installationA, conversationA, runA, memoryJobB, organizationB, definitionB, versionB, installationB, conversationB, runB],
    );
    await adminPool.query(
      `INSERT INTO audio_transcription_jobs (id, organization_id, installation_id, actor_id, correlation_id, idempotency_key, asset_id, dispatch_kind, dispatch_input)
       VALUES ($1, $2, $3, 'actor-a', gen_random_uuid(), $4, $5, 'platform', '{}'::jsonb),
              ($6, $7, $8, 'actor-b', gen_random_uuid(), $9, $10, 'platform', '{}'::jsonb)`,
      [audioJobA, organizationA, installationA, `audio-${audioJobA}`, `asset-${audioJobA}`, audioJobB, organizationB, installationB, `audio-${audioJobB}`, `asset-${audioJobB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_readiness_evaluation_state (installation_id, organization_id)
       VALUES ($1, $2), ($3, $4)`,
      [installationA, organizationA, installationB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO internal_calendar_events (id, organization_id, installation_id, title, start_at, end_at, created_by)
       VALUES ($1, $2, $3, 'Calendar A', now(), now() + interval '1 hour', 'rls-test'),
              ($4, $5, $6, 'Calendar B', now(), now() + interval '1 hour', 'rls-test')`,
      [calendarEventA, organizationA, installationA, calendarEventB, organizationB, installationB],
    );
    await adminPool.query(
      `INSERT INTO kasiai_user_preferences (organization_id, installation_id, owner_actor_id, language)
       VALUES ($1, $2, 'actor-a', 'en'), ($3, $4, 'actor-b', 'en')`,
      [organizationA, installationA, organizationB, installationB],
    );
    await adminPool.query(
      `INSERT INTO audit_records (id, organization_id, actor_type, actor_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'user', 'actor-a', 'control.test', 'test', $5), ($3, $4, 'user', 'actor-b', 'control.test', 'test', $6)`,
      [auditA, organizationA, auditB, organizationB, `audit-${auditA}`, `audit-${auditB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_retention_policies (id, organization_id, updated_by)
       VALUES ($1, $2, 'operator'), ($3, $4, 'operator')`,
      [retentionA, organizationA, retentionB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO agent_legal_holds (id, organization_id, scope_type, scope_id, reason, created_by)
       VALUES ($1, $2, 'organization', $2, 'hold A test', 'operator'), ($3, $4, 'organization', $4, 'hold B test', 'operator')`,
      [legalHoldA, organizationA, legalHoldB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO agent_operator_feature_flags (id, scope_type, scope_id, organization_id, flag_key, enabled, reason, expires_at, created_by)
       VALUES ($1, 'organization', $2, $2, 'agent_execution_enabled', true, 'flag A', now() + interval '1 hour', 'operator'),
              ($3, 'organization', $4, $4, 'agent_execution_enabled', true, 'flag B', now() + interval '1 hour', 'operator')`,
      [featureFlagA, organizationA, featureFlagB, organizationB],
    );
    const existingGlobalFlag = await adminPool.query<{ id: string }>(
      `SELECT id::text AS id
       FROM agent_operator_feature_flags
       WHERE scope_type = 'global' AND scope_id = 'global' AND flag_key = 'agent_execution_enabled'
       LIMIT 1`,
    );
    if (existingGlobalFlag.rows[0]?.id) {
      globalFeatureFlag = existingGlobalFlag.rows[0].id;
    } else {
      globalFeatureFlagCreated = true;
      await adminPool.query(
        `INSERT INTO agent_operator_feature_flags (id, scope_type, scope_id, organization_id, flag_key, enabled, reason, expires_at, created_by)
         VALUES ($1, 'global', 'global', NULL, 'agent_execution_enabled', true, 'global flag', now() + interval '1 hour', 'operator')`,
        [globalFeatureFlag],
      );
    }
    await adminPool.query(
      `INSERT INTO agent_operator_holds (id, organization_id, scope_type, scope_id, hold_type, reason, expires_at, created_by)
       VALUES ($1, $2, 'organization', $2, 'execution', 'hold A', now() + interval '1 hour', 'operator'),
              ($3, $4, 'organization', $4, 'execution', 'hold B', now() + interval '1 hour', 'operator')`,
      [operatorHoldA, organizationA, operatorHoldB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO agent_operator_commands (id, command_type, target_id, actor_id, status, required_approvals, idempotency_key)
       VALUES ($1, 'cancel_run', $2, 'operator', 'executing', 1, $3)`,
      [commandId, runA, `command-${commandId}`],
    );
    await adminPool.query(
      `INSERT INTO agent_export_requests (id, command_id, organization_id, requested_by, scope_type, scope_id)
       VALUES ($1, $2, $3, 'operator', 'run', $4)`,
      [exportId, commandId, organizationA, runA],
    );
    await adminPool.query(
      `INSERT INTO agent_operator_notifications (id, event_key, severity, kind, title, body)
       VALUES ($1, $2, 'info', 'test', 'Control RLS', 'test notification')`,
      [notificationId, `notification-${notificationId}`],
    );
    await adminPool.query(
      `INSERT INTO agent_operator_projections (projection_key, payload)
       VALUES ($1, '{}'::jsonb)`,
      [projectionKey],
    );
    await adminPool.query(
      `INSERT INTO analytics_outbox
        (outbox_id, source_service, source_domain, source_stream_key, record_category, record_id,
         contract_name, schema_version, scope_kind, scope_external_id, idempotency_key, envelope, payload_hash)
       VALUES ($1, 'agent-platform', 'control-test', $2, 'event', $3, 'agent.control.test@1', 1,
               'core_organization', $4, $5, '{}'::jsonb, repeat('a', 64)),
              ($6, 'agent-platform', 'control-test', $7, 'event', $8, 'agent.control.test@1', 1,
               'core_organization', $9, $10, '{}'::jsonb, repeat('b', 64))`,
      [outboxA, `organization:${organizationA}:control`, `record-${outboxA}`, organizationA, `idempotency-${outboxA}`, outboxB, `organization:${organizationB}:control`, `record-${outboxB}`, organizationB, `idempotency-${outboxB}`],
    );
  });

  it("keeps lifecycle sidecars tenant-scoped and preserves global flag visibility", async () => {
    const result = await runWithDatabaseContext({ organizationId: organizationA, actorId: "actor-a" }, async () => {
      const ids: Record<string, string[]> = {
        memory_consolidation_jobs: [memoryJobA, memoryJobB],
        audio_transcription_jobs: [audioJobA, audioJobB],
        agent_readiness_evaluation_state: [installationA, installationB],
        internal_calendar_events: [calendarEventA, calendarEventB],
        audit_records: [auditA, auditB],
        agent_retention_policies: [retentionA, retentionB],
        agent_legal_holds: [legalHoldA, legalHoldB],
        agent_operator_feature_flags: [featureFlagA, featureFlagB, globalFeatureFlag],
        agent_operator_holds: [operatorHoldA, operatorHoldB],
      };
      const counts: Record<string, number> = {};
      for (const [table, tableIds] of Object.entries(ids)) {
        const idColumn = table === "agent_readiness_evaluation_state" ? "installation_id" : "id";
        const rows = await query<{ count: string }>(restrictedPool, `SELECT count(*)::text AS count FROM ${table} WHERE ${idColumn} = ANY($1::uuid[])`, [tableIds]);
        counts[table] = Number(rows.rows[0]?.count ?? 0);
      }
      const preferences = await query(restrictedPool, "SELECT 1 FROM kasiai_user_preferences WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = 'actor-a'", [organizationA, installationA]);
      const outbox = await query(restrictedPool, "SELECT outbox_id FROM analytics_outbox WHERE outbox_id IN ($1, $2)", [outboxA, outboxB]);
      const commands = await query(restrictedPool, "SELECT id FROM agent_operator_commands WHERE id = $1", [commandId]);
      const exports = await query(restrictedPool, "SELECT id FROM agent_export_requests WHERE id = $1", [exportId]);
      const notifications = await query(restrictedPool, "SELECT id FROM agent_operator_notifications WHERE id = $1", [notificationId]);
      return { counts, preferences: preferences.rowCount, outbox: outbox.rows, commands: commands.rowCount, exports: exports.rowCount, notifications: notifications.rowCount };
    });
    expect(result.counts).toEqual({
      memory_consolidation_jobs: 1,
      audio_transcription_jobs: 1,
      agent_readiness_evaluation_state: 1,
      internal_calendar_events: 1,
      audit_records: 1,
      agent_retention_policies: 1,
      agent_legal_holds: 1,
      agent_operator_feature_flags: 2,
      agent_operator_holds: 1,
    });
    expect(result.preferences).toBe(1);
    expect(result.outbox).toEqual([{ outbox_id: outboxA }]);
    expect(result.commands).toBe(0);
    expect(result.exports).toBe(0);
    expect(result.notifications).toBe(0);
  });

  it("denies cross-tenant outbox writes and migration-ledger access", async () => {
    await expect(runWithDatabaseContext({ organizationId: organizationA, actorId: "actor-a" }, () => query(
      restrictedPool,
      `INSERT INTO analytics_outbox
        (outbox_id, source_service, source_domain, source_stream_key, record_category, record_id,
         contract_name, schema_version, scope_kind, scope_external_id, idempotency_key, envelope, payload_hash)
       VALUES ($1, 'agent-platform', 'control-test', $2, 'event', $3, 'agent.control.test@1', 1,
               'core_organization', $4, $5, '{}'::jsonb, repeat('c', 64))`,
      [`cross-${randomUUID()}`, `organization:${organizationB}:control`, `cross-record-${randomUUID()}`, organizationB, `cross-idempotency-${randomUUID()}`],
    ))).rejects.toMatchObject({ code: "42501" });
    await expect(runWithDatabaseContext({ organizationId: organizationA, actorId: "actor-a" }, () => query(restrictedPool, "SELECT count(*) FROM schema_migrations"))).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps operator projections and cross-tenant sidecars available only to operator scope", async () => {
    const result = await runWithDatabaseContext(
      { organizationId: "platform", actorId: "system:rls-test", operator: true },
      async () => ({
        jobs: await query(restrictedPool, "SELECT count(*)::text AS count FROM memory_consolidation_jobs WHERE id IN ($1, $2)", [memoryJobA, memoryJobB]),
        flags: await query(restrictedPool, "SELECT count(*)::text AS count FROM agent_operator_feature_flags WHERE id IN ($1, $2, $3)", [featureFlagA, featureFlagB, globalFeatureFlag]),
        commands: await query(restrictedPool, "SELECT count(*)::text AS count FROM agent_operator_commands WHERE id = $1", [commandId]),
        exports: await query(restrictedPool, "SELECT count(*)::text AS count FROM agent_export_requests WHERE id = $1", [exportId]),
        notifications: await query(restrictedPool, "SELECT count(*)::text AS count FROM agent_operator_notifications WHERE id = $1", [notificationId]),
      }),
    );
    expect(result.jobs.rows[0]?.count).toBe("2");
    expect(result.flags.rows[0]?.count).toBe("3");
    expect(result.commands.rows[0]?.count).toBe("1");
    expect(result.exports.rows[0]?.count).toBe("1");
    expect(result.notifications.rows[0]?.count).toBe("1");
  });

  afterAll(async () => {
    // analytics_outbox content is immutable by design; the random fixture rows
    // remain as durable evidence rather than bypassing the production trigger.
    await adminPool.query("DELETE FROM agent_operator_notifications WHERE id = $1", [notificationId]);
    await adminPool.query("DELETE FROM agent_operator_projections WHERE projection_key = $1", [projectionKey]);
    await adminPool.query("DELETE FROM agent_export_requests WHERE id = $1", [exportId]);
    await adminPool.query("DELETE FROM agent_operator_commands WHERE id = $1", [commandId]);
    await adminPool.query("DELETE FROM agent_operator_holds WHERE id IN ($1, $2)", [operatorHoldA, operatorHoldB]);
    await adminPool.query("DELETE FROM agent_operator_feature_flags WHERE id IN ($1, $2)", [featureFlagA, featureFlagB]);
    if (globalFeatureFlagCreated) {
      await adminPool.query("DELETE FROM agent_operator_feature_flags WHERE id = $1", [globalFeatureFlag]);
    }
    await adminPool.query("DELETE FROM agent_legal_holds WHERE id IN ($1, $2)", [legalHoldA, legalHoldB]);
    await adminPool.query("DELETE FROM agent_retention_policies WHERE id IN ($1, $2)", [retentionA, retentionB]);
    // audit_records are append-only by design; the random fixture rows remain as
    // immutable evidence rather than bypassing the production trigger in tests.
    await adminPool.query("DELETE FROM kasiai_user_preferences WHERE organization_id IN ($1, $2)", [organizationA, organizationB]);
    await adminPool.query("DELETE FROM internal_calendar_events WHERE id IN ($1, $2)", [calendarEventA, calendarEventB]);
    await adminPool.query("DELETE FROM agent_readiness_evaluation_state WHERE installation_id IN ($1, $2)", [installationA, installationB]);
    await adminPool.query("DELETE FROM audio_transcription_jobs WHERE id IN ($1, $2)", [audioJobA, audioJobB]);
    await adminPool.query("DELETE FROM memory_consolidation_jobs WHERE id IN ($1, $2)", [memoryJobA, memoryJobB]);
    await adminPool.query("DELETE FROM agent_runs WHERE id IN ($1, $2)", [runA, runB]);
    await adminPool.query("DELETE FROM conversations WHERE id IN ($1, $2)", [conversationA, conversationB]);
    await adminPool.query("DELETE FROM agent_installations WHERE id IN ($1, $2)", [installationA, installationB]);
    await adminPool.query("DELETE FROM agent_versions WHERE id IN ($1, $2)", [versionA, versionB]);
    await adminPool.query("DELETE FROM agent_definitions WHERE id IN ($1, $2)", [definitionA, definitionB]);
    await restrictedPool.end();
    await adminPool.end();
  });
});
