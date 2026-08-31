import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, query } from "../src/db/pool";
import { runWithDatabaseContext } from "../src/db/context";

const adminUrl = process.env.AGENTS_DATABASE_URL;
const restrictedUrl = process.env.AGENTS_RLS_TEST_DATABASE_URL;
const runIntegration = Boolean(adminUrl && restrictedUrl && process.env.RUN_AGENTS_RLS_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("conversation and durable-run RLS (integration)", () => {
  const adminPool = createPool({ AGENTS_DATABASE_URL: adminUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const restrictedPool = createPool({ AGENTS_DATABASE_URL: restrictedUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const organizationA = `rls-conversation-a-${randomUUID()}`;
  const organizationB = `rls-conversation-b-${randomUUID()}`;
  const definitionA = randomUUID();
  const definitionB = randomUUID();
  const versionA = randomUUID();
  const versionB = randomUUID();
  const installationA = randomUUID();
  const installationB = randomUUID();
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const participantA = randomUUID();
  const participantB = randomUUID();
  const messageA = randomUUID();
  const messageB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const stepA = randomUUID();
  const stepB = randomUUID();
  const attemptA = randomUUID();
  const attemptB = randomUUID();
  const checkpointA = randomUUID();
  const checkpointB = randomUUID();
  const modelCallA = randomUUID();
  const modelCallB = randomUUID();
  const toolInvocationA = randomUUID();
  const toolInvocationB = randomUUID();
  const eventA = randomUUID();
  const eventB = randomUUID();
  const deliveryA = randomUUID();
  const deliveryB = randomUUID();
  const attachmentA = randomUUID();
  const attachmentB = randomUUID();
  const handoffRequestA = randomUUID();
  const handoffRequestB = randomUUID();
  const handoffOfferA = randomUUID();
  const handoffOfferB = randomUUID();
  const assignmentA = randomUUID();
  const assignmentB = randomUUID();
  const scenarioA = randomUUID();
  const scenarioB = randomUUID();
  const evaluationRunA = randomUUID();
  const evaluationRunB = randomUUID();

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [definitionA, organizationA, "Conversation RLS A", `conversation-rls-${definitionA}`, "rls-test", definitionB, organizationB, "Conversation RLS B", `conversation-rls-${definitionB}`, "rls-test"],
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
      `INSERT INTO conversations (id, installation_id, organization_id, channel_type, channel_key, external_conversation_id, status, conversation_kind)
       VALUES ($1, $2, $3, 'test', 'rls', $4, 'active', 'test'), ($5, $6, $7, 'test', 'rls', $8, 'active', 'test')`,
      [conversationA, installationA, organizationA, `conversation-${conversationA}`, conversationB, installationB, organizationB, `conversation-${conversationB}`],
    );
    await adminPool.query(
      `INSERT INTO participants (id, conversation_id, organization_id, participant_type, external_id)
       VALUES ($1, $2, $3, 'user', $4), ($5, $6, $7, 'user', $8)`,
      [participantA, conversationA, organizationA, `user-${participantA}`, participantB, conversationB, organizationB, `user-${participantB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, input, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'message', 'completed', '{}'::jsonb, gen_random_uuid(), 'rls-test'),
              ($7, $8, $9, $10, $11, $12, 'message', 'completed', '{}'::jsonb, gen_random_uuid(), 'rls-test')`,
      [runA, organizationA, definitionA, versionA, installationA, conversationA, runB, organizationB, definitionB, versionB, installationB, conversationB],
    );
    await adminPool.query(
      `INSERT INTO messages (id, conversation_id, organization_id, participant_id, direction, message_type, content, provider, provider_message_id, sequence_number, run_id)
       VALUES ($1, $2, $3, $4, 'inbound', 'text', '{}'::jsonb, 'platform', $5, 1, $6),
              ($7, $8, $9, $10, 'inbound', 'text', '{}'::jsonb, 'platform', $11, 1, $12)`,
      [messageA, conversationA, organizationA, participantA, `provider-${messageA}`, runA, messageB, conversationB, organizationB, participantB, `provider-${messageB}`, runB],
    );
    await adminPool.query(
      `INSERT INTO conversation_summaries (conversation_id, organization_id, summary)
       VALUES ($1, $2, 'summary A'), ($3, $4, 'summary B')`,
      [conversationA, organizationA, conversationB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO run_steps (id, run_id, organization_id, sequence_number, step_type, status)
       VALUES ($1, $2, $3, 1, 'context', 'completed'), ($4, $5, $6, 1, 'context', 'completed')`,
      [stepA, runA, organizationA, stepB, runB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO run_attempts (id, run_id, organization_id, attempt_number, status)
       VALUES ($1, $2, $3, 1, 'completed'), ($4, $5, $6, 1, 'completed')`,
      [attemptA, runA, organizationA, attemptB, runB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO run_workflow_state (run_id, organization_id, state)
       VALUES ($1, $2, '{}'::jsonb), ($3, $4, '{}'::jsonb)`,
      [runA, organizationA, runB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO run_workflow_checkpoints (id, run_id, organization_id, sequence_number, node_id, status, idempotency_key)
       VALUES ($1, $2, $3, 1, 'start', 'completed', $4), ($5, $6, $7, 1, 'start', 'completed', $8)`,
      [checkpointA, runA, organizationA, `checkpoint-${checkpointA}`, checkpointB, runB, organizationB, `checkpoint-${checkpointB}`],
    );
    await adminPool.query(
      `INSERT INTO run_budgets (run_id, organization_id)
       VALUES ($1, $2), ($3, $4)`,
      [runA, organizationA, runB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO run_budget_reservations (id, run_id, organization_id, reservation_key, estimated_tokens, estimated_cost_usd, status)
       VALUES ($1, $2, $3, $4, 1, 0, 'released'), ($5, $6, $7, $8, 1, 0, 'released')`,
      [randomUUID(), runA, organizationA, `reservation-${runA}`, randomUUID(), runB, organizationB, `reservation-${runB}`],
    );
    await adminPool.query(
      `INSERT INTO model_calls (id, organization_id, run_id, provider, model, funding_source, status, operation_key)
       VALUES ($1, $2, $3, 'openai', 'test', 'user', 'completed', $4), ($5, $6, $7, 'openai', 'test', 'user', 'completed', $8)`,
      [modelCallA, organizationA, runA, `model-${modelCallA}`, modelCallB, organizationB, runB, `model-${modelCallB}`],
    );
    await adminPool.query(
      `INSERT INTO tool_invocations (id, run_id, organization_id, provider_tool_call_id, sequence_number, tool_name, tool_version, risk_class, arguments_hash, status)
       VALUES ($1, $2, $3, $4, 1, 'test', '1', 'read', 'hash', 'completed'), ($5, $6, $7, $8, 1, 'test', '1', 'read', 'hash', 'completed')`,
      [toolInvocationA, runA, organizationA, `tool-${toolInvocationA}`, toolInvocationB, runB, organizationB, `tool-${toolInvocationB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_events (id, organization_id, run_id, installation_id, event_type, payload)
       VALUES ($1, $2, $3, $4, 'test', '{}'::jsonb), ($5, $6, $7, $8, 'test', '{}'::jsonb)`,
      [eventA, organizationA, runA, installationA, eventB, organizationB, runB, installationB],
    );
    await adminPool.query(
      `INSERT INTO delivery_attempts (id, organization_id, conversation_id, message_id, channel_type, status, attempt_number)
       VALUES ($1, $2, $3, $4, 'test', 'sent', 1), ($5, $6, $7, $8, 'test', 'sent', 1)`,
      [deliveryA, organizationA, conversationA, messageA, deliveryB, organizationB, conversationB, messageB],
    );
    await adminPool.query(
      `INSERT INTO agent_attachment_references (id, organization_id, installation_id, run_id, object_key, sha256, mime_type, size_bytes, scan_status)
       VALUES ($1, $2, $3, $4, $5, repeat('a', 64), 'text/plain', 1, 'clean'), ($6, $7, $8, $9, $10, repeat('b', 64), 'text/plain', 1, 'clean')`,
      [attachmentA, organizationA, installationA, runA, `attachment-${attachmentA}`, attachmentB, organizationB, installationB, runB, `attachment-${attachmentB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_handoff_requests (id, organization_id, installation_id, conversation_id, agent_definition_id, agent_version_id, run_id, channel_type, reason, summary, requested_by, expires_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'test', 'other', 'handoff A', 'rls-test', now() + interval '1 hour', $8),
              ($9, $10, $11, $12, $13, $14, $15, 'test', 'other', 'handoff B', 'rls-test', now() + interval '1 hour', $16)`,
      [handoffRequestA, organizationA, installationA, conversationA, definitionA, versionA, runA, `handoff-request-${handoffRequestA}`, handoffRequestB, organizationB, installationB, conversationB, definitionB, versionB, runB, `handoff-request-${handoffRequestB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_handoff_offers (id, organization_id, installation_id, conversation_id, agent_definition_id, agent_version_id, source_run_id, source_message_id, channel_type, reason, summary, offered_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'test', 'other', 'offer A', 'rls-test', $9),
              ($10, $11, $12, $13, $14, $15, $16, $17, 'test', 'other', 'offer B', 'rls-test', $18)`,
      [handoffOfferA, organizationA, installationA, conversationA, definitionA, versionA, runA, messageA, `handoff-offer-${handoffOfferA}`, handoffOfferB, organizationB, installationB, conversationB, definitionB, versionB, runB, messageB, `handoff-offer-${handoffOfferB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_operator_run_assignments (id, run_id, organization_id, assignee_id, assigned_by, expected_status)
       VALUES ($1, $2, $3, 'operator-a', 'rls-test', 'completed'), ($4, $5, $6, 'operator-b', 'rls-test', 'completed')`,
      [assignmentA, runA, organizationA, assignmentB, runB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO evaluation_scenarios (id, organization_id, agent_definition_id, name, created_by)
       VALUES ($1, $2, $3, 'scenario A', 'rls-test'), ($4, $5, $6, 'scenario B', 'rls-test')`,
      [scenarioA, organizationA, definitionA, scenarioB, organizationB, definitionB],
    );
    await adminPool.query(
      `INSERT INTO evaluation_runs (id, organization_id, scenario_id, agent_version_id, run_id, status, evaluator_version, created_by)
       VALUES ($1, $2, $3, $4, $5, 'passed', 'test', 'rls-test'), ($6, $7, $8, $9, $10, 'passed', 'test', 'rls-test')`,
      [evaluationRunA, organizationA, scenarioA, versionA, runA, evaluationRunB, organizationB, scenarioB, versionB, runB],
    );
  });

  const organizationTables = [
    "conversations",
    "participants",
    "messages",
    "conversation_summaries",
    "agent_runs",
    "run_steps",
    "run_attempts",
    "run_workflow_state",
    "run_workflow_checkpoints",
    "run_budgets",
    "run_budget_reservations",
    "model_calls",
    "tool_invocations",
    "agent_events",
    "delivery_attempts",
    "agent_attachment_references",
    "agent_handoff_requests",
    "agent_handoff_offers",
    "agent_operator_run_assignments",
    "evaluation_scenarios",
    "evaluation_runs",
  ] as const;

  it("exposes only the current organization across conversation and run projections", async () => {
    const counts = await runWithDatabaseContext({ organizationId: organizationA, actorId: "rls-test" }, async () => {
      const rows = [] as Array<{ table: string; count: number }>;
      for (const table of organizationTables) {
        const result = await query<{ count: string }>(restrictedPool, `SELECT count(*)::text AS count FROM ${table} WHERE organization_id = $1`, [organizationA]);
        const hidden = await query<{ count: string }>(restrictedPool, `SELECT count(*)::text AS count FROM ${table} WHERE organization_id = $1`, [organizationB]);
        rows.push({ table, count: Number(result.rows[0]?.count ?? 0) });
        expect(Number(hidden.rows[0]?.count ?? 0), table).toBe(0);
      }
      return rows;
    });
    expect(counts.every((row) => row.count === 1)).toBe(true);
  });

  it("rejects a cross-organization run write", async () => {
    await expect(runWithDatabaseContext({ organizationId: organizationA, actorId: "rls-test" }, () => query(
      restrictedPool,
      `INSERT INTO agent_runs (organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, input, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'message', '{}'::jsonb, gen_random_uuid(), 'rls-test')`,
      [organizationB, definitionB, versionB, installationB, conversationB],
    ))).rejects.toMatchObject({ code: "P0001" });
  });

  it("rejects a cross-organization conversation write at the RLS boundary", async () => {
    await expect(runWithDatabaseContext({ organizationId: organizationB, actorId: "rls-test" }, () => query(
      restrictedPool,
      `INSERT INTO conversations (installation_id, organization_id, channel_type, channel_key, external_conversation_id, conversation_kind)
       VALUES ($1, $2, 'test', 'rls', $3, 'test')`,
      [installationA, organizationA, `cross-tenant-${randomUUID()}`],
    ))).rejects.toMatchObject({ code: "42501" });
  });

  it("allows both organizations only under explicit platform operator scope", async () => {
    const result = await runWithDatabaseContext(
      { organizationId: "platform", actorId: "system:rls-test", operator: true },
      () => query<{ organization_id: string }>(restrictedPool, "SELECT organization_id FROM agent_runs WHERE id IN ($1, $2) ORDER BY organization_id", [runA, runB]),
    );
    expect(result.rows).toEqual([{ organization_id: organizationA }, { organization_id: organizationB }]);
  });

  afterAll(async () => {
    await adminPool.query("DELETE FROM evaluation_runs WHERE id IN ($1, $2)", [evaluationRunA, evaluationRunB]);
    await adminPool.query("DELETE FROM evaluation_scenarios WHERE id IN ($1, $2)", [scenarioA, scenarioB]);
    await adminPool.query("DELETE FROM agent_handoff_offers WHERE id IN ($1, $2)", [handoffOfferA, handoffOfferB]);
    await adminPool.query("DELETE FROM agent_handoff_requests WHERE id IN ($1, $2)", [handoffRequestA, handoffRequestB]);
    await adminPool.query("DELETE FROM agent_operator_run_assignments WHERE id IN ($1, $2)", [assignmentA, assignmentB]);
    await adminPool.query("DELETE FROM agent_attachment_references WHERE id IN ($1, $2)", [attachmentA, attachmentB]);
    await adminPool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id IN ($1, $2)", [organizationA, organizationB]);
    await adminPool.query("DELETE FROM delivery_attempts WHERE id IN ($1, $2)", [deliveryA, deliveryB]);
    await adminPool.query("DELETE FROM agent_events WHERE id IN ($1, $2)", [eventA, eventB]);
    await adminPool.query("DELETE FROM tool_invocations WHERE id IN ($1, $2)", [toolInvocationA, toolInvocationB]);
    await adminPool.query("DELETE FROM model_calls WHERE id IN ($1, $2)", [modelCallA, modelCallB]);
    await adminPool.query("DELETE FROM run_budget_reservations WHERE run_id IN ($1, $2)", [runA, runB]);
    await adminPool.query("DELETE FROM run_budgets WHERE run_id IN ($1, $2)", [runA, runB]);
    await adminPool.query("DELETE FROM run_workflow_checkpoints WHERE id IN ($1, $2)", [checkpointA, checkpointB]);
    await adminPool.query("DELETE FROM run_workflow_state WHERE run_id IN ($1, $2)", [runA, runB]);
    await adminPool.query("DELETE FROM run_attempts WHERE id IN ($1, $2)", [attemptA, attemptB]);
    await adminPool.query("DELETE FROM run_steps WHERE id IN ($1, $2)", [stepA, stepB]);
    await adminPool.query("DELETE FROM messages WHERE id IN ($1, $2)", [messageA, messageB]);
    await adminPool.query("DELETE FROM participants WHERE id IN ($1, $2)", [participantA, participantB]);
    await adminPool.query("DELETE FROM conversation_summaries WHERE conversation_id IN ($1, $2)", [conversationA, conversationB]);
    await adminPool.query("DELETE FROM agent_runs WHERE organization_id IN ($1, $2)", [organizationA, organizationB]);
    await adminPool.query("DELETE FROM conversations WHERE organization_id IN ($1, $2)", [organizationA, organizationB]);
    await adminPool.query("DELETE FROM agent_installations WHERE id IN ($1, $2)", [installationA, installationB]);
    await adminPool.query("DELETE FROM agent_versions WHERE id IN ($1, $2)", [versionA, versionB]);
    await adminPool.query("DELETE FROM agent_definitions WHERE id IN ($1, $2)", [definitionA, definitionB]);
    await restrictedPool.end();
    await adminPool.end();
  });
});
