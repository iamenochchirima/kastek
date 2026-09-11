import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import { loadConfig } from "../src/config";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { ApprovalRepository } from "../src/db/repositories/approval-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ToolInvocationRepository } from "../src/db/repositories/tool-invocation-repository";
import { createActivities, createDefaultTools } from "../src/temporal/activities";
import { agentRunWorkflow, approvalGroupSignal, cancellationSignal } from "../src/temporal/workflows";
import { ToolRegistry } from "../src/tools/registry";
import { IntegrationRepository } from "../src/integrations/repository";
import { IntegrationToolService } from "../src/integrations/service";
import { CalendarRepository } from "../src/integrations/calendar-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS ?? process.env.TEMPORAL_ADDRESS;
const runIntegration = Boolean(
  databaseUrl
  && temporalAddress
  && process.env.RUN_REAL_MODEL_INTEGRATION_TESTS === "true"
  && process.env.OPENROUTER_API_KEY?.trim(),
);

const runCalendarSandboxIntegration = runIntegration && process.env.RUN_REAL_APPROVAL_CALENDAR_TESTS === "true";

async function waitFor<T>(read: () => Promise<T | undefined>, predicate: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the real approval group");
}

describe.skipIf(!runIntegration)("real model approval group through HTTP and Temporal (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const runs = new RunRepository(pool);
  const conversations = new ConversationRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const connections: NativeConnection[] = [];
  const workers: Worker[] = [];
  const workerRunners: Promise<void>[] = [];
  const organizationId = `real-approval-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Temporal real approval test', $3, 'test')",
      [agentId, organizationId, `real-approval-${agentId}`],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, configuration, created_by, status)
       VALUES ($1, $2, 1, $3, 'real-approval-test', $4::jsonb, 'test', 'published')`,
      [
        versionId,
        agentId,
        "When asked to run the controlled approval integration, call test.real_approval_effect exactly once with postId approval-runtime-smoke. Wait for the human approval before claiming it ran, then summarize the returned value.",
        JSON.stringify({ provider: process.env.KASIAI_MODEL_PROVIDER ?? "openrouter", model: process.env.KASIAI_MODEL }),
      ],
    );
    await pool.query(
      `INSERT INTO agent_installations
        (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', $5::jsonb, 'test')`,
      [installationId, agentId, versionId, organizationId, JSON.stringify({ environment: "playground", maxModelCalls: 3, maxToolCalls: 8 })],
    );
  });

  afterAll(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.getState() === "INITIALIZED" || worker.getState() === "RUNNING") await worker.shutdown();
    }
    await Promise.allSettled(workerRunners.splice(0));
    for (const connection of connections.splice(0)) await connection.close();
    await pool.end();
  });

  it("waits for approval, accepts the HTTP group decision, and executes the approved effect once", async () => {
    const tools = new ToolRegistry();
    let effectInvocations = 0;
    tools.register({
      name: "test.real_approval_effect",
      version: "1.0.0",
      description: "Controlled external-effect integration fixture. Use it only for the approval runtime test.",
      riskClass: "external-effect",
      requiresApproval: true,
      timeoutMs: 5_000,
      inputSchema: {
        type: "object",
        properties: { postId: { type: "string" } },
        required: ["postId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { accepted: { type: "boolean" }, postId: { type: "string" } },
        required: ["accepted", "postId"],
        additionalProperties: false,
      },
      handler: async (_context, argumentsValue) => {
        effectInvocations += 1;
        return { accepted: true, postId: argumentsValue.postId };
      },
    });
    await pool.query(
      `INSERT INTO agent_tool_grants (organization_id, agent_version_id, installation_id, tool_name, granted_by)
       VALUES ($1, $2, $3, 'test.real_approval_effect', 'test')`,
      [organizationId, versionId, installationId],
    );

    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_MODE: "headers",
      TEMPORAL_MODE: "local",
      TEMPORAL_ADDRESS: temporalAddress!,
      TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE ?? "default",
      TEMPORAL_TASK_QUEUE: `real-approval-${randomUUID()}`,
      CREDIT_BILLING_MODE: "disabled",
      MEMORY_V2_ENABLED: "false",
      MEMORY_RETRIEVAL_GATE_ENABLED: "false",
    });
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const activities = createActivities(pool, { config, tools });
    const worker = await Worker.create({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities,
      maxConcurrentActivityTaskExecutions: 8,
      maxHeartbeatThrottleInterval: "100ms",
      defaultHeartbeatThrottleInterval: "100ms",
    });
    workers.push(worker);
    const workerRun = worker.run();
    workerRunners.push(workerRun);
    const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
    const conversation = await conversations.createConversation({
      organizationId,
      installationId,
      conversationKind: "personal",
    });
    const run = await runs.createRun(organizationId, "real-approval-test", {
      installationId,
      triggerType: "manual",
      idempotencyKey: `real-approval-${randomUUID()}`,
      input: { message: "Run the controlled approval integration test now." },
      conversationId: conversation.id,
    });
    const workflowId = `agent-run-${run.id}`;
    const handle = await client.workflow.start(agentRunWorkflow, {
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      workflowId,
      args: [{ runId: run.id, organizationId, actorId: "real-approval-test" }],
    });

    const active = await waitFor(
      () => approvals.getActiveGroup(organizationId, run.id),
      (value) => value?.group.status === "pending",
    );
    await waitFor(
      async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM agent_events
           WHERE run_id = $1
             AND event_type IN ('agent.approval.prompt_skipped', 'agent.approval.group.displayed')`,
          [run.id],
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      (value) => value > 0,
    );
    // Approval waits may outlive the ten-minute conversation lease. The
    // resumed workflow must reacquire the lease instead of reusing this
    // expired fencing token.
    await pool.query(
      "UPDATE agent_session_leases SET expires_at = now() - interval '1 second' WHERE run_id = $1",
      [run.id],
    );
    const app = buildApp({
      config,
      pool,
      toolRegistry: tools,
      signalApprovalGroup: (runId, signal) => handle.signal(approvalGroupSignal, signal),
    });
    try {
      const request = {
        method: "POST",
        url: `/v1/runs/${run.id}/approval-group`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "approval-operator", "idempotency-key": "real-approval-duplicate" },
        payload: { groupId: active.group.id, planDigest: active.group.plan_digest, decision: "approved" },
      } as const;
      const responses = await Promise.all([app.inject(request), app.inject(request)]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 202]);
      expect(responses.map((response) => response.json())).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: run.id, groupId: active.group.id, status: "approval_group_signalled", decision: "approved" }),
        expect.objectContaining({ runId: run.id, groupId: active.group.id, status: "approval_group_already_signalled", decision: "approved" }),
      ]));
    } finally {
      await app.close();
    }

    await handle.result();
    const completedRun = await runs.getRunById(run.id);
    const invocations = await toolInvocations.list(organizationId, run.id);
    const group = await approvals.getGroup(organizationId, active.group.id);
    expect(completedRun?.status).toBe("completed");
    expect(effectInvocations).toBe(1);
    expect(group?.status).toBe("consumed");
    expect(invocations).toEqual([
      expect.objectContaining({
        tool_name: "test.real_approval_effect",
        status: "completed",
      }),
    ]);
  }, 180_000);

  it.skipIf(!runCalendarSandboxIntegration)("drives the real calendar capability through the Studio message and group decision path", async () => {
    const calendarAgentId = randomUUID();
    const calendarVersionId = randomUUID();
    const calendarInstallationId = randomUUID();
    const taskQueue = `real-calendar-approval-${randomUUID()}`;
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_MODE: "headers",
      TEMPORAL_MODE: "local",
      TEMPORAL_ADDRESS: temporalAddress!,
      TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE ?? "default",
      TEMPORAL_TASK_QUEUE: taskQueue,
      CREDIT_BILLING_MODE: "disabled",
      MEMORY_V2_ENABLED: "false",
      MEMORY_RETRIEVAL_GATE_ENABLED: "false",
    });
    await pool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, 'Temporal real calendar approval test', $3, 'test')`,
      [calendarAgentId, organizationId, `real-calendar-approval-${calendarAgentId}`],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, configuration, created_by, status)
       VALUES ($1, $2, 1, $3, 'real-calendar-approval-test', $4::jsonb, 'test', 'published')`,
      [
        calendarVersionId,
        calendarAgentId,
        "For this controlled approval test, when the user gives internal calendar event IDs, call kasitek.calendar.delete exactly once for each listed ID with source internal. Do not call calendar.list or any other tool. Wait for approval before claiming the events were deleted, then give a concise final summary containing the number of deleted events.",
        JSON.stringify({ provider: process.env.KASIAI_MODEL_PROVIDER ?? "openrouter", model: process.env.KASIAI_MODEL }),
      ],
    );
    await pool.query(
      `INSERT INTO agent_installations
        (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', $5::jsonb, 'test')`,
      [calendarInstallationId, calendarAgentId, calendarVersionId, organizationId, JSON.stringify({ environment: "playground", maxModelCalls: 8, maxToolCalls: 16 })],
    );
    await pool.query(
      `INSERT INTO agent_tool_grants (organization_id, agent_version_id, installation_id, tool_name, granted_by)
       VALUES ($1, $2, $3, 'kasitek.calendar.delete', 'test')`,
      [organizationId, calendarVersionId, calendarInstallationId],
    );
    const calendar = new CalendarRepository(pool);
    const fixtureEvents = await Promise.all(Array.from({ length: 4 }, (_, index) => calendar.create({
      organizationId,
      installationId: calendarInstallationId,
      title: `approval-e2e-real-${randomUUID()}-${index + 1}`,
      description: "real calendar approval sandbox fixture",
      start: new Date(Date.now() + (index + 1) * 60_000).toISOString(),
      end: new Date(Date.now() + (index + 1) * 60_000 + 3_600_000).toISOString(),
      timezone: "UTC",
      idempotencyKey: `approval-e2e-real-${randomUUID()}`,
      createdBy: "real-approval-test",
    })));
    const eventIds = fixtureEvents.map((event) => event.id);

    const integrationRepository = new IntegrationRepository(pool, config.AGENTS_CREDENTIAL_ENCRYPTION_KEY);
    const integrationTools = new IntegrationToolService(integrationRepository, config);
    const tools = createDefaultTools(undefined, undefined, integrationTools);
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const activities = createActivities(pool, { config, tools });
    const createWorker = () => Worker.create({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities,
      maxConcurrentActivityTaskExecutions: 8,
      maxHeartbeatThrottleInterval: "100ms",
      defaultHeartbeatThrottleInterval: "100ms",
    });
    const worker = await createWorker();
    workers.push(worker);
    const workerRun = worker.run();
    workerRunners.push(workerRun);
    const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
    let handle: ReturnType<typeof client.workflow.getHandle>;
    const app = buildApp({
      config,
      pool,
      toolRegistry: tools,
      startWorkflow: async (runId) => {
        const run = await runs.getRunById(runId);
        if (!run) throw new Error("real calendar approval run was not found");
        handle = await client.workflow.start(agentRunWorkflow, {
          taskQueue,
          workflowId: `agent-run-${runId}`,
          args: [{ runId, organizationId: run.organization_id, actorId: run.created_by }],
        });
      },
      signalApprovalGroup: (runId, signal) => {
        if (!handle) throw new Error(`approval workflow handle is unavailable for ${runId}`);
        return handle.signal(approvalGroupSignal, signal);
      },
    });
    let runId: string | undefined;
    try {
      const messageResponse = await app.inject({
        method: "POST",
        url: `/v1/installations/${calendarInstallationId}/platform/messages`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "studio-operator" },
        payload: {
          message: `Delete exactly these internal calendar events and nothing else. Use kasitek.calendar.delete once for each event, with source internal: ${eventIds.join(", ")}`,
          idempotencyKey: `real-calendar-approval-${randomUUID()}`,
          createNew: true,
        },
      });
      expect(messageResponse.statusCode).toBe(202);
      const accepted = messageResponse.json() as { conversation: { id: string }; runId: string };
      expect(accepted.runId).toEqual(expect.any(String));
      runId = accepted.runId;
      const active = await waitFor(
        () => approvals.getActiveGroup(organizationId, runId),
        (value) => value?.group.status === "pending",
      );
      await waitFor(
        () => runs.getRunById(runId),
        (value) => value?.status === "awaiting_approval",
      );
      await worker.shutdown();
      await workerRun;
      const replacementWorker = await createWorker();
      workers.push(replacementWorker);
      workerRunners.push(replacementWorker.run());
      const projection = await app.inject({
        method: "GET",
        url: `/v1/runs/${runId}`,
        headers: { "x-organization-id": organizationId, "x-actor-id": "studio-operator" },
      });
      expect(projection.statusCode).toBe(200);
      expect(projection.json().approvalGroup.operations).toHaveLength(eventIds.length);
      expect(active.approvals).toHaveLength(eventIds.length);
      const before = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM internal_calendar_events WHERE organization_id = $1 AND installation_id = $2 AND id = ANY($3::uuid[]) ORDER BY id",
        [organizationId, calendarInstallationId, eventIds],
      );
      expect(before.rows).toHaveLength(eventIds.length);
      expect(before.rows.every((event) => event.status === "active")).toBe(true);

      const decision = {
        groupId: active.group.id,
        planDigest: active.group.plan_digest,
        decision: "approved" as const,
        selectedOperationIds: active.approvals.map((approval) => approval.runtime_operation_id),
      };
      const decisions = await Promise.all([1, 2].map((index) => app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approval-group`,
        headers: {
          "x-organization-id": organizationId,
          "x-actor-id": "studio-operator",
          "idempotency-key": `real-calendar-approval-decision-${index === 1 ? "primary" : "duplicate"}`,
        },
        payload: decision,
      })));
      expect(decisions.map((response) => response.statusCode).sort()).toEqual([200, 202]);
      await handle.result();

      const after = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM internal_calendar_events WHERE organization_id = $1 AND installation_id = $2 AND id = ANY($3::uuid[]) ORDER BY id",
        [organizationId, calendarInstallationId, eventIds],
      );
      expect(after.rows).toHaveLength(eventIds.length);
      expect(after.rows.every((event) => event.status === "cancelled")).toBe(true);
      const completedRun = await runs.getRunById(runId);
      const invocations = await toolInvocations.list(organizationId, runId);
      const group = await approvals.getGroup(organizationId, active.group.id);
      expect(completedRun?.status).toBe("completed");
      expect(completedRun?.output).toEqual(expect.objectContaining({ message: expect.any(String) }));
      expect(group?.status).toBe("consumed");
      expect(invocations.filter((entry) => entry.tool_name === "kasitek.calendar.delete")).toHaveLength(eventIds.length);
      expect(invocations.filter((entry) => entry.tool_name === "kasitek.calendar.delete").every((entry) => entry.status === "completed")).toBe(true);
    } finally {
      if (runId && handle) {
        const current = await runs.getRunById(runId);
        if (current && ["received", "queued", "running", "awaiting_approval"].includes(current.status)) {
          await handle.signal(cancellationSignal, { reason: "real calendar approval test cleanup" }).catch(() => undefined);
          await handle.result().catch(() => undefined);
        }
      }
      await app.close();
      await pool.query(
        "DELETE FROM internal_calendar_events WHERE organization_id = $1 AND installation_id = $2 AND description = 'real calendar approval sandbox fixture'",
        [organizationId, calendarInstallationId],
      );
    }
  }, 240_000);
});
