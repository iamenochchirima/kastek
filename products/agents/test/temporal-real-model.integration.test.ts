import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { ToolInvocationRepository } from "../src/db/repositories/tool-invocation-repository";
import { agentRunWorkflow } from "../src/temporal/workflows";
import { createActivities } from "../src/temporal/activities";
import { ToolRegistry } from "../src/tools/registry";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS ?? process.env.TEMPORAL_ADDRESS;
const runIntegration = Boolean(
  databaseUrl
  && temporalAddress
  && process.env.RUN_REAL_MODEL_INTEGRATION_TESTS === "true"
  && process.env.OPENROUTER_API_KEY?.trim(),
);

describe.skipIf(!runIntegration)("real model through the decomposed Temporal runtime (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const runs = new RunRepository(pool);
  const conversations = new ConversationRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const connections: NativeConnection[] = [];
  const workers: Worker[] = [];
  const organizationId = `real-model-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  let conversationId: string;
  const workerRunners: Promise<void>[] = [];

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Temporal real model test', $3, 'test')",
      [agentId, organizationId, `real-model-${agentId}`],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, configuration, created_by, status)
       VALUES ($1, $2, 1, $3, 'real-model-test', $4::jsonb, 'test', 'published')`,
      [
        versionId,
        agentId,
        "When asked to run the controlled integration, call test.real_read exactly once with value parallel-runtime-smoke, then summarize the returned value.",
        JSON.stringify({ provider: process.env.KASIAI_MODEL_PROVIDER ?? "openrouter", model: process.env.KASIAI_MODEL }),
      ],
    );
    await pool.query(
      `INSERT INTO agent_installations
        (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', $5::jsonb, 'test')`,
      [installationId, agentId, versionId, organizationId, JSON.stringify({ environment: "playground", maxModelCalls: 3, maxToolCalls: 8 })],
    );
    const conversation = await conversations.createConversation({
      organizationId,
      installationId,
      conversationKind: "personal",
    });
    conversationId = conversation.id;
    // Seed enough durable history for the first real model step to exercise
    // the bounded compaction path. The separate session-context plan owns the
    // first-turn/no-progress policy; this test remains about Temporal and
    // parallel tool execution.
    for (let index = 0; index < 24; index += 1) {
      await conversations.appendMessage({
        organizationId,
        conversationId,
        direction: index % 2 === 0 ? "inbound" : "outbound",
        content: { text: `Prior integration transcript message ${index + 1}.` },
      });
    }
  });

  afterAll(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.getState() === "INITIALIZED" || worker.getState() === "RUNNING") await worker.shutdown();
    }
    await Promise.allSettled(workerRunners.splice(0));
    for (const connection of connections.splice(0)) await connection.close();
    await pool.end();
  });

  it("executes a real model tool round through model, prepare, tool, and commit Activities", async () => {
    const tools = new ToolRegistry();
    let providerInvocations = 0;
    tools.register({
      name: "test.real_read",
      version: "1.0.0",
      description: "Controlled read-only integration fixture. Use it only for the Temporal runtime test.",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 5_000,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      handler: async (_context, argumentsValue) => {
        providerInvocations += 1;
        return { value: argumentsValue.value };
      },
    });
    await pool.query(
      `INSERT INTO agent_tool_grants (organization_id, agent_version_id, installation_id, tool_name, granted_by)
       VALUES ($1, $2, $3, 'test.real_read', 'test')`,
      [organizationId, versionId, installationId],
    );

    const config = loadConfig({
      ...process.env,
      TEMPORAL_MODE: "local",
      TEMPORAL_ADDRESS: temporalAddress!,
      TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE ?? "default",
      TEMPORAL_TASK_QUEUE: `real-model-${randomUUID()}`,
      // Billing is a separate kasitek-core boundary. Keep this integration
      // fixture focused on the real provider + Temporal + tool path; the
      // credit reservation contract is covered by its own repository/core
      // checks and synthetic organizations are not valid billing tenants.
      CREDIT_BILLING_MODE: "disabled",
      // Context/memory-v2 has its own integration plan. The parallel runtime
      // fixture uses the stable legacy transcript path until that plan closes
      // the memory journal identity contract.
      MEMORY_V2_ENABLED: "false",
      MEMORY_RETRIEVAL_GATE_ENABLED: "false",
    });
    const taskQueue = config.TEMPORAL_TASK_QUEUE;
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const activities = createActivities(pool, { config, tools });
    const worker = await Worker.create({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue,
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
    const run = await runs.createRun(organizationId, "real-model-test", {
      installationId,
      triggerType: "manual",
      idempotencyKey: `real-model-${randomUUID()}`,
      input: { message: "Run the controlled integration test now." },
      conversationId,
    });
    const workflowId = `agent-run-${run.id}`;
    await client.workflow.start(agentRunWorkflow, {
      taskQueue,
      workflowId,
      args: [{ runId: run.id, organizationId, actorId: "real-model-test" }],
    });
    try {
      await client.workflow.getHandle(workflowId).result();
    } finally {
      await worker.shutdown();
      await workerRun;
    }

    const completedRun = await runs.getRunById(run.id);
    const invocations = await toolInvocations.list(organizationId, run.id);
    expect(completedRun?.status).toBe("completed");
    expect(providerInvocations).toBe(1);
    expect(invocations.filter((entry) => entry.tool_name === "test.real_read")).toEqual([
      expect.objectContaining({ status: "completed", batch_id: `${run.id}:batch:0` }),
    ]);
  }, 180_000);
});
