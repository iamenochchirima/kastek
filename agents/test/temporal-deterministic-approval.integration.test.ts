import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import { loadConfig } from "../src/config";
import { ApprovalRepository } from "../src/db/repositories/approval-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ToolInvocationRepository } from "../src/db/repositories/tool-invocation-repository";
import { SessionTranscriptRepository } from "../src/db/repositories/session-transcript-repository";
import { ModelGateway } from "../src/model/gateway";
import type { CredentialResolver } from "../src/model/credentials";
import { ProviderMetadataClient } from "../src/model/provider-metadata";
import type { ModelAdapter, ModelMessage, ModelRequest, ModelResponse } from "../src/model/types";
import { createActivities } from "../src/temporal/activities";
import { agentRunWorkflow, approvalGroupSignal } from "../src/temporal/workflows";
import { ToolRegistry } from "../src/tools/registry";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS ?? process.env.TEMPORAL_ADDRESS;
const runIntegration = Boolean(
  databaseUrl
  && temporalAddress
  && process.env.RUN_DETERMINISTIC_APPROVAL_INTEGRATION_TESTS === "true",
);

const fixtureModel = "deterministic-approval-fixture";
const operationSizes = [18, 32, 64, 128, 256] as const;

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the deterministic approval group");
}

function operationIds(size: number): string[] {
  return Array.from({ length: size }, (_, index) => `deterministic-operation-${size}-${index + 1}`);
}

function currentTurnMessages(request: ModelRequest): ModelMessage[] {
  const lastUserIndex = request.messages.findLastIndex((message) => message.role === "user");
  return lastUserIndex < 0 ? [] : request.messages.slice(lastUserIndex + 1);
}

function fixtureResponse(request: ModelRequest): ModelResponse {
  const userMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const match = /size=(\d+)/u.exec(userMessage);
  if (!match) throw new Error("Deterministic model fixture could not identify the operation size");
  const size = Number(match[1]);
  const ids = operationIds(size);
  // Earlier approved turns remain in the same canonical session. Only tool
  // results after the current user message belong to this fixture response;
  // otherwise the next size would be mistaken for a continuation of the first
  // tool batch and no approval group would be created.
  const hasToolResults = currentTurnMessages(request).some((message) => message.role === "tool");
  if (hasToolResults) {
    return {
      provider: "openrouter",
      model: fixtureModel,
      message: { role: "assistant", content: `Completed ${size} approved operations.` },
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      latencyMs: 1,
    };
  }
  const toolCalls = ids.map((resourceId, index) => ({
    id: `provider-${size}-${index + 1}`,
    name: "test.deterministic_approval_effect",
    arguments: { resourceId },
  }));
  return {
    provider: "openrouter",
    model: fixtureModel,
    message: { role: "assistant", content: "", toolCalls },
    toolCalls,
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: size, totalTokens: size + 1, estimatedCostUsd: 0 },
    latencyMs: 1,
  };
}

describe.skipIf(!runIntegration)("deterministic model-gateway approval barriers (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const runs = new RunRepository(pool);
  const conversations = new ConversationRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const sessionTranscripts = new SessionTranscriptRepository(pool);
  const organizationId = `deterministic-approval-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const taskQueue = `deterministic-approval-${randomUUID()}`;
  const connections: NativeConnection[] = [];
  const workers: Worker[] = [];
  const workerRunners: Promise<void>[] = [];
  const handles = new Map<string, ReturnType<Client["workflow"]["getHandle"]>>();

  afterAll(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.getState() === "INITIALIZED" || worker.getState() === "RUNNING") await worker.shutdown();
    }
    await Promise.allSettled(workerRunners.splice(0));
    for (const connection of connections.splice(0)) await connection.close();
    await pool.end();
  });

  it("emits and completes exact 18/32/64/128/256-call model batches", async () => {
    await pool.query(
      "INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Deterministic approval test', $3, 'test')",
      [agentId, organizationId, `deterministic-approval-${agentId}`],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, configuration, created_by, status)
       VALUES ($1, $2, 1, $3, 'deterministic-approval-test', $4::jsonb, 'test', 'published')`,
      [
        versionId,
        agentId,
        "Use the deterministic approval model fixture for the requested operation size. Wait for the approval group before claiming completion.",
        JSON.stringify({
          provider: "openrouter",
          model: fixtureModel,
          maxModelCalls: 4,
          maxToolCalls: 300,
          maxTotalTokens: 200_000,
          maxIterations: 4,
        }),
      ],
    );
    await pool.query(
      `INSERT INTO agent_installations
        (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', $5::jsonb, 'test')`,
      [installationId, agentId, versionId, organizationId, JSON.stringify({ environment: "playground", maxModelCalls: 4, maxToolCalls: 300, maxTotalTokens: 200_000 })],
    );
    await pool.query(
      `INSERT INTO agent_tool_grants (organization_id, agent_version_id, installation_id, tool_name, granted_by)
       VALUES ($1, $2, $3, 'test.deterministic_approval_effect', 'test')`,
      [organizationId, versionId, installationId],
    );

    const effectIds: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "test.deterministic_approval_effect",
      version: "1.0.0",
      description: "Offline deterministic external-effect fixture for approval barriers.",
      riskClass: "external-effect",
      parallelSafe: true,
      requiresApproval: true,
      timeoutMs: 5_000,
      inputSchema: {
        type: "object",
        properties: { resourceId: { type: "string", minLength: 1 } },
        required: ["resourceId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { accepted: { type: "boolean" }, resourceId: { type: "string" } },
        required: ["accepted", "resourceId"],
        additionalProperties: false,
      },
      manifest: {
        ownerService: "agents-test",
        requiredScope: "test.deterministic.approval",
        execution: "durable",
        idempotency: "required",
        approval: "always",
        auditClassification: "full",
        redaction: [],
      },
      handler: async (_context, argumentsValue) => {
        const resourceId = String(argumentsValue.resourceId);
        effectIds.push(resourceId);
        return { accepted: true, resourceId };
      },
    });

    const modelRequests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      provider: "openrouter",
      capabilities: { toolCalling: true, structuredOutput: false, streaming: false, vision: false },
      estimateRequestBytes: (request) => Buffer.byteLength(JSON.stringify(request), "utf8"),
      complete: async (request, credentials) => {
        if (credentials.apiKey !== "deterministic-fixture") throw new Error("Unexpected deterministic fixture credential");
        modelRequests.push(request);
        return fixtureResponse(request);
      },
    };
    const gateway = new ModelGateway([adapter], { retryBaseDelayMs: 0 });
    const credentials: CredentialResolver = {
      resolve: async () => ({ apiKey: "deterministic-fixture", fundingSource: "kasitek" }),
    };
    const providerMetadata = new ProviderMetadataClient({
      fetcher: async () => new Response(JSON.stringify({
        data: [{ id: fixtureModel, context_length: 128_000, max_output_tokens: 2_048 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_MODE: "headers",
      TEMPORAL_MODE: "local",
      TEMPORAL_ADDRESS: temporalAddress!,
      TEMPORAL_NAMESPACE: "default",
      TEMPORAL_TASK_QUEUE: taskQueue,
      CREDIT_BILLING_MODE: "disabled",
      MEMORY_V2_ENABLED: "false",
      MEMORY_RETRIEVAL_GATE_ENABLED: "false",
    });
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const activities = createActivities(pool, { config, tools, gateway, credentials, providerMetadata });
    const worker = await Worker.create({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities,
      maxConcurrentActivityTaskExecutions: 64,
      maxHeartbeatThrottleInterval: "100ms",
      defaultHeartbeatThrottleInterval: "100ms",
    });
    workers.push(worker);
    workerRunners.push(worker.run());
    const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
    const app = buildApp({
      config,
      pool,
      toolRegistry: tools,
      signalApprovalGroup: (runId, signal) => {
        const handle = handles.get(runId);
        if (!handle) throw new Error(`Deterministic approval workflow handle is unavailable for ${runId}`);
        return handle.signal(approvalGroupSignal, signal);
      },
    });
    const conversation = await conversations.createConversation({
      organizationId,
      installationId,
      conversationKind: "personal",
    });

    try {
      for (const size of operationSizes) {
        const effectCountBefore = effectIds.length;
        const run = await runs.createRun(organizationId, "deterministic-approval-test", {
          installationId,
          triggerType: "manual",
          idempotencyKey: `deterministic-approval-${size}-${randomUUID()}`,
          input: { message: `Run deterministic approval fixture size=${size}.` },
          conversationId: conversation.id,
        });
        const workflowId = `agent-run-${run.id}`;
        const handle = await client.workflow.start(agentRunWorkflow, {
          taskQueue,
          workflowId,
          args: [{ runId: run.id, organizationId, actorId: "deterministic-approval-test" }],
        });
        handles.set(run.id, handle);
        try {
          const active = await waitFor(
            () => approvals.getActiveGroup(organizationId, run.id),
            (value) => value?.group.status === "pending",
          );
          await waitFor(() => runs.getRunById(run.id), (value) => value?.status === "awaiting_approval");
          const pendingProjection = await sessionTranscripts.readActive(
            { organizationId, installationId, conversationId: conversation.id },
            { allowIncomplete: true },
          );
          const pendingBatchId = `${run.id}:batch:0`;
          const pendingAssistantToolCall = pendingProjection.entries.find(
            (entry) => entry.idempotencyKey === `tool-batch:${pendingBatchId}:assistant`,
          );
          expect(pendingAssistantToolCall?.kind).toBe("assistant_tool_call");
          expect(pendingProjection.entries.filter(
            (entry) => entry.idempotencyKey.startsWith(`tool-batch:${pendingBatchId}:result:`),
          )).toHaveLength(0);
          expect(effectIds.slice(effectCountBefore)).toHaveLength(0);
          expect(active.approvals).toHaveLength(size);
          expect(new Set(active.approvals.map((approval) => approval.runtime_operation_id)).size).toBe(size);

          const projection = await app.inject({
            method: "GET",
            url: `/v1/runs/${run.id}`,
            headers: { "x-organization-id": organizationId, "x-actor-id": "deterministic-approval-test" },
          });
          expect(projection.statusCode).toBe(200);
          expect(projection.json().approvalGroup.operations).toHaveLength(size);

          const decision = {
            groupId: active.group.id,
            planDigest: active.group.plan_digest,
            decision: "approved" as const,
            selectedOperationIds: active.approvals.map((approval) => approval.runtime_operation_id),
          };
          const responses = await Promise.all(["primary", "duplicate"].map((suffix) => app.inject({
            method: "POST",
            url: `/v1/runs/${run.id}/approval-group`,
            headers: {
              "x-organization-id": organizationId,
              "x-actor-id": "deterministic-approval-test",
              "idempotency-key": `deterministic-decision-${size}-${suffix}`,
            },
            payload: decision,
          })));
          expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 202]);
          await handle.result();

          const completedRun = await runs.getRunById(run.id);
          const group = await approvals.getGroup(organizationId, active.group.id);
          const operations = await approvals.listGroupOperations(organizationId, active.group.id);
          const invocations = await toolInvocations.list(organizationId, run.id);
          const transcript = await sessionTranscripts.readActive({ organizationId, installationId, conversationId: conversation.id });
          const expectedIds = operationIds(size);
          const batchId = `${run.id}:batch:0`;
          const assistantToolCall = transcript.entries.find((entry) => entry.idempotencyKey === `tool-batch:${batchId}:assistant`);
          const toolResults = transcript.entries.filter((entry) => entry.idempotencyKey.startsWith(`tool-batch:${batchId}:result:`));
          expect(completedRun?.status).toBe("completed");
          expect(group?.status).toBe("consumed");
          expect(operations).toHaveLength(size);
          expect(operations.every((operation) => operation.status === "consumed")).toBe(true);
          expect(effectIds.slice(-size).sort()).toEqual(expectedIds.slice().sort());
          const completedInvocations = invocations.filter((entry) => entry.tool_name === "test.deterministic_approval_effect");
          expect(completedInvocations).toHaveLength(size);
          expect(completedInvocations.every((entry) => entry.status === "completed")).toBe(true);
          expect(completedInvocations.map((entry) => (entry.arguments as { resourceId: string }).resourceId).sort()).toEqual(expectedIds.slice().sort());
          expect(assistantToolCall).toMatchObject({ kind: "assistant_tool_call", runId: run.id });
          expect(assistantToolCall?.message.role).toBe("assistant");
          expect(assistantToolCall?.message.toolCalls).toHaveLength(size);
          expect(toolResults).toHaveLength(size);
          expect(toolResults.map((entry) => entry.message.runtimeOperationId)).toEqual(
            assistantToolCall?.message.toolCalls?.map((call) => call.runtimeOperationId),
          );
          const continuationRequest = [...modelRequests].reverse().find((request) => {
            return request.messages.some((message) => message.role === "user" && message.content.includes(`size=${size}`))
              && currentTurnMessages(request).some((message) => message.role === "tool");
          });
          const continuationMessages = continuationRequest ? currentTurnMessages(continuationRequest) : [];
          expect(continuationMessages).toContainEqual(expect.objectContaining({
            role: "assistant",
            toolCalls: expect.arrayContaining([
              expect.objectContaining({ name: "test.deterministic_approval_effect", arguments: { resourceId: expectedIds[0] } }),
            ]),
          }));
          expect(continuationMessages.filter((message) => message.role === "tool")).toHaveLength(size);
        } finally {
          handles.delete(run.id);
        }
      }

      expect(modelRequests.filter((request) => currentTurnMessages(request).some((message) => message.role === "tool"))).toHaveLength(operationSizes.length);
      expect(modelRequests.filter((request) => !currentTurnMessages(request).some((message) => message.role === "tool")).map((request) => fixtureResponse(request).toolCalls.length)).toEqual([...operationSizes]);
    } finally {
      await app.close();
    }
  }, 300_000);
});
