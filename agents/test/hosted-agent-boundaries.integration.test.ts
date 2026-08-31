import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { InstallationGrantRepository } from "../src/db/repositories/installation-grant-repository";
import { ScheduleRepository } from "../src/db/repositories/schedule-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ReadinessRepository } from "../src/db/repositories/readiness-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("hosted agent lifecycle and isolation (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const grants = new InstallationGrantRepository(pool);
  const schedules = new ScheduleRepository(pool);
  const runs = new RunRepository(pool);
  const readiness = new ReadinessRepository(pool);
  const conversations = new ConversationRepository(pool);
  const organizationA = `hosted-boundary-a-${randomUUID()}`;
  const organizationB = `hosted-boundary-b-${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let installationId = "";

  it("keeps definitions, versions, and installations organization-scoped", async () => {
    const agent = await agents.createAgent(organizationA, "owner-a", { name: "Boundary agent" });
    agentId = agent.id;
    await agents.updateAgent(organizationA, "owner-a", agent.id, { name: "Boundary agent renamed", description: "A private description" });
    const definitionFacts = await pool.query<{ action: string; status: string; changed_fields: string[] }>(
      `SELECT envelope->'data'->>'action' AS action,
              envelope->'data'->>'status' AS status,
              ARRAY(SELECT jsonb_array_elements_text(envelope->'data'->'changed_fields')) AS changed_fields
       FROM analytics_outbox
       WHERE source_stream_key = $1 AND envelope->>'subject' = $2 AND contract_name = 'agent.definition.lifecycle@1'
       ORDER BY source_sequence`,
      [`organization:${organizationA}:definitions`, `definition:${agent.id}`],
    );
    expect(definitionFacts.rows).toEqual([
      { action: "created", status: "active", changed_fields: [] },
      { action: "updated", status: "active", changed_fields: ["description", "name", "slug"] },
    ]);
    expect(await pool.query("SELECT 1 FROM analytics_outbox WHERE source_stream_key = $1", [`organization:${organizationB}:definitions`])).toMatchObject({ rows: [] });
    const version = await agents.createVersion(organizationA, "owner-a", agent.id, {
      instructions: "Follow the published workflow.",
      configuration: {
        workflow: {
          version: 1,
          entryNodeId: "start",
          nodes: [
            { id: "start", type: "deterministic", config: { operation: "set", path: "ready", value: true } },
          ],
          edges: [],
          stateSchema: { ready: { type: "boolean" } },
        },
      },
      policy: { allowedTools: ["platform.current_time"], maxConcurrentRuns: 2 },
    });
    versionId = version.id;
    await agents.publishVersion(organizationA, "owner-a", agent.id, version.id);
    const versionFacts = await pool.query<{ action: string; status: string; version_number: number }>(
      `SELECT envelope->'data'->>'action' AS action,
              envelope->'data'->>'status' AS status,
              (envelope->'data'->>'version_number')::integer AS version_number
       FROM analytics_outbox
       WHERE source_stream_key = $1 AND contract_name = 'agent.version.lifecycle@1'
       ORDER BY source_sequence`,
      [`organization:${organizationA}:versions`],
    );
    expect(versionFacts.rows).toEqual([
      { action: "created", status: "draft", version_number: 1 },
      { action: "published", status: "published", version_number: 1 },
    ]);
    expect(await pool.query("SELECT 1 FROM analytics_outbox WHERE source_stream_key = $1", [`organization:${organizationB}:versions`])).toMatchObject({ rows: [] });

    expect(await agents.getAgent(organizationB, agent.id)).toBeNull();
    expect(await agents.getVersion(organizationB, version.id)).toBeNull();
    expect((await agents.listAgents(organizationB)).some((entry) => entry.id === agent.id)).toBe(false);
    await expect(agents.createInstallation(organizationB, "owner-b", {
      agentVersionId: version.id,
      scopeType: "organization",
      scopeId: organizationB,
      settings: {},
    })).rejects.toThrow("Published agent version not found");

    const installation = await agents.createInstallation(organizationA, "owner-a", {
      agentVersionId: version.id,
      scopeType: "organization",
      scopeId: organizationA,
      settings: { environment: "test" },
    });
    installationId = installation.id;
    expect(await agents.getInstallation(organizationB, installation.id)).toBeNull();
    expect(await agents.setInstallationSettings(organizationA, installation.id, "owner-a", { region: "local" })).toMatchObject({
      settings: { environment: "test", region: "local" },
    });
    expect((await agents.setInstallationStatus(organizationA, installation.id, "paused", "owner-a")).status).toBe("paused");
    expect((await agents.setInstallationStatus(organizationA, installation.id, "active", "owner-a")).status).toBe("active");
    const installationFacts = await pool.query<{ action: string; status: string; previous_status: string | null; agent_audience: string; execution_mode: string }>(
      `SELECT envelope->'data'->>'action' AS action, envelope->'data'->>'status' AS status,
              envelope->'data'->>'previous_status' AS previous_status,
              envelope->'data'->>'agent_audience' AS agent_audience,
              envelope->'data'->>'execution_mode' AS execution_mode
       FROM analytics_outbox
       WHERE source_stream_key = $1 AND contract_name = 'agent.installation.lifecycle@1'
       ORDER BY source_sequence`,
      [`organization:${organizationA}:installations`],
    );
    expect(installationFacts.rows).toEqual([
      { action: "created", status: "active", previous_status: null, agent_audience: "personal", execution_mode: "kasitek_hosted" },
      { action: "paused", status: "paused", previous_status: "active", agent_audience: "personal", execution_mode: "kasitek_hosted" },
      { action: "activated", status: "active", previous_status: "paused", agent_audience: "personal", execution_mode: "kasitek_hosted" },
    ]);

    const conversation = await conversations.createConversation({
      organizationId: organizationA,
      installationId,
      channelType: "platform",
      channelKey: "analytics-boundary",
      conversationKind: "test",
    });
    const activeConversationRun = await runs.createRun(organizationA, "owner-a", {
      installationId,
      conversationId: conversation.id,
      idempotencyKey: `conversation-admission-${randomUUID()}`,
      input: { message: "first" },
      triggerType: "message",
    });
    await expect(runs.createRun(organizationA, "owner-a", {
      installationId,
      conversationId: conversation.id,
      idempotencyKey: `conversation-admission-${randomUUID()}`,
      input: { message: "second" },
      triggerType: "message",
    })).rejects.toMatchObject({ code: "conversation_run_active", statusCode: 409, runId: activeConversationRun.id });
    await runs.transitionRun(activeConversationRun.id, "received", "queued");
    await runs.transitionRun(activeConversationRun.id, "queued", "running");
    await runs.transitionRun(activeConversationRun.id, "running", "completed");
    const afterCompletionRun = await runs.createRun(organizationA, "owner-a", {
      installationId,
      conversationId: conversation.id,
      idempotencyKey: `conversation-admission-${randomUUID()}`,
      input: { message: "after completion" },
      triggerType: "message",
    });
    expect(afterCompletionRun).toMatchObject({ created: true, conversation_id: conversation.id });
    await runs.transitionRun(afterCompletionRun.id, "received", "queued");
    await runs.transitionRun(afterCompletionRun.id, "queued", "running");
    await runs.transitionRun(afterCompletionRun.id, "running", "completed");
    await conversations.appendMessage({
      organizationId: organizationA,
      conversationId: conversation.id,
      direction: "inbound",
      content: { text: "private inbound transcript" },
      sourceChannel: "platform",
    });
    await conversations.appendMessage({
      organizationId: organizationA,
      conversationId: conversation.id,
      direction: "outbound",
      content: { text: "private outbound transcript" },
      provider: "kasitek-human",
      sourceChannel: "platform",
    });
    await conversations.markInstallationOpened(organizationA, conversation.id);
    const conversationFacts = await pool.query<{
      contract_name: string;
      action: string;
      conversation_kind: string;
      responder_type: string | null;
      response_time_ms: number | null;
      envelope: Record<string, unknown>;
    }>(
      `SELECT contract_name,
              envelope->'data'->>'action' AS action,
              envelope->'data'->>'conversation_kind' AS conversation_kind,
              envelope->'data'->>'responder_type' AS responder_type,
              (envelope->'data'->>'response_time_ms')::integer AS response_time_ms,
              envelope
       FROM analytics_outbox
       WHERE (source_stream_key = $1 AND envelope->>'subject' = $3)
          OR (source_stream_key = $2 AND envelope->>'subject' LIKE 'message:%')
       ORDER BY source_sequence`,
      [
        `organization:${organizationA}:conversations`,
        `organization:${organizationA}:messages`,
        `conversation:${conversation.id}`,
      ],
    );
    expect(conversationFacts.rows.filter((row) => row.contract_name === "agent.conversation.lifecycle@1").map((row) => row.action)).toEqual(["created", "opened"]);
    const messageFacts = conversationFacts.rows.filter((row) => row.contract_name === "agent.conversation.message@1");
    expect(messageFacts).toHaveLength(2);
    expect(messageFacts.map((row) => row.responder_type)).toEqual(["human", "human"]);
    expect(messageFacts.every((row) => row.conversation_kind === "test" && row.response_time_ms === null)).toBe(true);
    expect(JSON.stringify(conversationFacts.rows)).not.toContain("private inbound transcript");
    expect(await pool.query("SELECT 1 FROM analytics_outbox WHERE source_stream_key = $1", [`organization:${organizationB}:messages`])).toMatchObject({ rows: [] });
    await expect(agents.setInstallationStatus(organizationB, installation.id, "disabled", "owner-b")).rejects.toThrow("Installation not found");
  });

  it("records deletion as a terminal definition lifecycle fact before removing data", async () => {
    const deletable = await agents.createAgent(organizationA, "owner-a", { name: "Deleted boundary agent" });
    await agents.deleteAgent(organizationA, "owner-a", deletable.id);
    const facts = await pool.query<{ action: string; status: string; changed_fields: string[] }>(
      `SELECT envelope->'data'->>'action' AS action,
              envelope->'data'->>'status' AS status,
              ARRAY(SELECT jsonb_array_elements_text(envelope->'data'->'changed_fields')) AS changed_fields
       FROM analytics_outbox
       WHERE source_stream_key = $1 AND envelope->>'subject' = $2 AND contract_name = 'agent.definition.lifecycle@1'
       ORDER BY source_sequence`,
      [`organization:${organizationA}:definitions`, `definition:${deletable.id}`],
    );
    expect(facts.rows).toEqual([
      { action: "created", status: "active", changed_fields: [] },
      { action: "deleted", status: "deleted", changed_fields: ["status"] },
    ]);
    expect(await agents.getAgent(organizationA, deletable.id)).toBeNull();
  });

  it("scopes resource, connector, and schedule grants to the installation organization", async () => {
    expect(installationId).toBeTruthy();
    await grants.grantResource({ organizationId: organizationA, installationId, resourceType: "workspace", resourceId: "workspace-a", actorId: "owner-a" });
    await grants.grantConnector({ organizationId: organizationA, installationId, connectorId: "provider.mail", actorId: "owner-a" });
    expect(await grants.effective(organizationA, installationId)).toEqual({
      resources: [{ resourceType: "workspace", resourceId: "workspace-a" }],
      connectors: ["provider.mail"],
    });
    expect(await grants.effective(organizationB, installationId)).toEqual({ resources: [], connectors: [] });
    await expect(grants.grantResource({ organizationId: organizationB, installationId, resourceType: "workspace", resourceId: "workspace-b", actorId: "owner-b" })).rejects.toThrow("Installation not found");
    await expect(grants.grantConnector({ organizationId: organizationB, installationId, connectorId: "provider.crm", actorId: "owner-b" })).rejects.toThrow("Installation not found");

    const schedule = await schedules.create({
      organizationId: organizationA,
      installationId,
      expression: "0 * * * *",
      timezone: "Africa/Johannesburg",
      scheduleInput: { prompt: "refresh" },
      actorId: "owner-a",
    });
    expect(schedule.status).toBe("active");
    expect((await schedules.list(organizationA, installationId)).map((entry) => entry.id)).toContain(schedule.id);
    expect(await schedules.list(organizationB, installationId)).toEqual([]);
    expect((await schedules.setStatus(organizationA, schedule.id, "paused", "owner-a")).status).toBe("paused");
    expect((await schedules.setStatus(organizationA, schedule.id, "paused", "owner-a")).status).toBe("paused");
    const scheduleFacts = await pool.query<{ action: string; status: string; previous_status: string | null }>(
      `SELECT envelope->'data'->>'action' AS action, envelope->'data'->>'status' AS status,
              envelope->'data'->>'previous_status' AS previous_status
       FROM analytics_outbox
       WHERE source_stream_key = $1 AND contract_name = 'agent.schedule.lifecycle@1'
       ORDER BY source_sequence`,
      [`organization:${organizationA}:schedules`],
    );
    expect(scheduleFacts.rows).toEqual([
      { action: "created", status: "active", previous_status: null },
      { action: "paused", status: "paused", previous_status: "active" },
    ]);
    const readinessInput = {
      organizationId: organizationA,
      installationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      executionMode: "kasitek_hosted" as const,
      status: "ready" as const,
      workflowStatus: "ready" as const,
      credentialStatus: "ready" as const,
      blockerCodes: [] as const,
      requiredCapabilityCount: 1,
      missingCapabilityCount: 0,
      requiredConnectionCount: 0,
      missingConnectionCount: 0,
      evaluationSource: "readiness_route" as const,
      correlationId: null,
    };
    expect(await readiness.recordSnapshot({ ...readinessInput, observedAt: "2026-08-22T10:05:00.000Z" })).toBe(true);
    expect(await readiness.recordSnapshot({ ...readinessInput, observedAt: "2026-08-22T10:06:00.000Z" })).toBe(false);
    expect(await readiness.recordSnapshot({
      ...readinessInput,
      status: "blocked",
      blockerCodes: ["installation_inactive"],
      requiredCapabilityCount: 1,
      missingCapabilityCount: 1,
      observedAt: "2026-08-22T10:07:00.000Z",
    })).toBe(true);
    const readinessFacts = await pool.query<{ status: string; blocker_set: string }>(
      `SELECT envelope->'data'->>'status' AS status, envelope->'data'->>'blocker_set' AS blocker_set
       FROM analytics_outbox
       WHERE source_stream_key = $1 AND contract_name = 'agent.readiness.snapshot@1'
       ORDER BY source_sequence`,
      [`organization:${organizationA}:readiness`],
    );
    expect(readinessFacts.rows).toEqual([
      { status: "ready", blocker_set: "none" },
      { status: "blocked", blocker_set: "installation_inactive" },
    ]);
    const sweepNow = new Date("2030-08-22T10:10:00.000Z");
    const claimed = await readiness.claimDueEvaluations({ owner: "readiness-test", organizationId: organizationA, limit: 10, leaseDurationMs: 60_000, now: sweepNow });
    expect(claimed).toEqual([{ installationId, organizationId: organizationA, actorId: "owner-a" }]);
    expect(await readiness.claimDueEvaluations({ owner: "another-readiness-test", organizationId: organizationA, limit: 10, leaseDurationMs: 60_000, now: sweepNow })).toEqual([]);
    expect(await readiness.completeEvaluation({ installationId, owner: "readiness-test", evaluatedAt: sweepNow, nextEvaluationAt: new Date("2030-08-22T10:15:00.000Z") })).toBe(true);
    expect(await readiness.claimDueEvaluations({ owner: "readiness-test", organizationId: organizationA, limit: 10, leaseDurationMs: 60_000, now: new Date("2030-08-22T10:14:59.000Z") })).toEqual([]);
    expect(await readiness.claimDueEvaluations({ owner: "readiness-test", organizationId: organizationA, limit: 10, leaseDurationMs: 60_000, now: new Date("2030-08-22T10:15:00.000Z") })).toEqual([{ installationId, organizationId: organizationA, actorId: "owner-a" }]);
    await readiness.releaseEvaluation({ installationId, owner: "readiness-test", retryAt: new Date("2030-08-22T10:15:00.000Z") });
    await expect(schedules.setStatus(organizationB, schedule.id, "disabled", "owner-b")).rejects.toThrow("Schedule not found");
  });

  it("enforces the published version concurrency budget per installation", async () => {
    expect(installationId).toBeTruthy();
    const first = await runs.createRun(organizationA, "owner-a", {
      installationId,
      idempotencyKey: `concurrency-first-${randomUUID()}`,
      input: { message: "first" },
      triggerType: "manual",
    });
    const second = await runs.createRun(organizationA, "owner-a", {
      installationId,
      idempotencyKey: `concurrency-second-${randomUUID()}`,
      input: { message: "second" },
      triggerType: "manual",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    await expect(runs.createRun(organizationA, "owner-a", {
      installationId,
      idempotencyKey: `concurrency-third-${randomUUID()}`,
      input: { message: "third" },
      triggerType: "manual",
    })).rejects.toThrow("AGENT_CONCURRENCY_LIMIT");
  });

  it("rejects invalid workflow configuration before persisting a version", async () => {
    expect(agentId).toBeTruthy();
    await expect(agents.createVersion(organizationA, "owner-a", agentId, {
      instructions: "invalid",
      configuration: {
        workflow: {
          version: 1,
          entryNodeId: "missing",
          nodes: [{ id: "start", type: "route" }],
          edges: [],
          stateSchema: {},
        },
      },
      policy: {},
    })).rejects.toThrow("entry node does not exist");
    expect((await agents.listVersions(organizationA, agentId)).map((version) => version.id)).toEqual([versionId]);
  });

  beforeAll(async () => { await pool.query("SELECT 1"); });

  afterAll(async () => {
    if (installationId) {
      await pool.query("DELETE FROM messages WHERE organization_id = $1 AND run_id IS NOT NULL", [organizationA]);
      await pool.query("DELETE FROM run_workflow_state WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM participants WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_schedules WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installation_resource_grants WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installation_connector_grants WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installation_credentials WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationA]);
      await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationA]);
    }
    if (versionId) await pool.query("DELETE FROM agent_tool_grants WHERE organization_id = $1 AND agent_version_id = $2", [organizationA, versionId]);
    if (versionId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    if (agentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
