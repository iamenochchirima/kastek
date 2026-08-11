import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import type { AgentRepository } from "../src/db/repositories/agent-repository";
import type { RunRepository } from "../src/db/repositories/run-repository";
import type { AppConfig } from "../src/config";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  INTERNAL_AUTH_AUDIENCE: "test",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
};

const fakePool = {
  query: async () => ({ rows: [{ ok: 1 }] }),
} as never;

describe("Agent Platform HTTP foundation", () => {
  it("requires an explicit organization and actor scope", async () => {
    const app = buildApp({ config, pool: fakePool });
    const response = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "Test" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("creates an agent through the scoped control-plane contract", async () => {
    const agents = {
      createAgent: async () => ({ id: "agent-1", name: "Test" }),
    } as unknown as AgentRepository;
    const app = buildApp({ config, pool: fakePool, agents });
    const response = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { name: "Test agent" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "agent-1" });
    await app.close();
  });

  it("accepts a run and keeps it queued for Temporal when disabled locally", async () => {
    const runs = {
      createRun: async () => ({ id: "run-1", status: "received" }),
    } as unknown as RunRepository;
    const app = buildApp({ config, pool: fakePool, runs });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { installationId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ runId: "run-1", durable: false });
    await app.close();
  });

  it("signals approval and cancellation without handling either in process memory", async () => {
    const signals: Array<{ type: string; value: unknown }> = [];
    const runs = {
      getRun: async (_organizationId: string, runId: string) => ({
        id: runId,
        status: runId === "approval-run" ? "awaiting_approval" : "running",
      }),
    } as unknown as RunRepository;
    const app = buildApp({
      config,
      pool: fakePool,
      runs,
      signalApproval: async (runId, value) => signals.push({ type: `approval:${runId}`, value }),
      signalCancellation: async (runId, value) => signals.push({ type: `cancel:${runId}`, value }),
    });
    const approval = await app.inject({
      method: "POST",
      url: "/v1/runs/approval-run/approval",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { decision: "approved", argumentsHash: "a".repeat(64) },
    });
    const cancellation = await app.inject({
      method: "POST",
      url: "/v1/runs/running-run/cancel",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      payload: { reason: "operator stop" },
    });
    expect(approval.statusCode).toBe(202);
    expect(cancellation.statusCode).toBe(202);
    expect(signals).toEqual([
      { type: "approval:approval-run", value: { decision: "approved", argumentsHash: "a".repeat(64), approvedBy: "user-1" } },
      { type: "cancel:running-run", value: { reason: "user-1: operator stop" } },
    ]);
    await app.close();
  });

  it("returns a durable run timeline assembled from events, steps, and tool calls", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      runs: {
        getRun: async () => ({ id: "run-1", status: "completed" }),
        listEvents: async () => [{ event_type: "run.completed" }],
      } as unknown as RunRepository,
      runSteps: { listSteps: async () => [{ sequence_number: 1, step_type: "context" }] } as never,
      toolInvocations: { list: async () => [{ tool_name: "platform.current_time" }] } as never,
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs/run-1/timeline",
      headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run: { id: "run-1" },
      events: [{ event_type: "run.completed" }],
      steps: [{ step_type: "context" }],
      toolCalls: [{ tool_name: "platform.current_time" }],
    });
    await app.close();
  });

  it("returns an organization-scoped operational summary", async () => {
    const app = buildApp({
      config,
      pool: fakePool,
      runs: { operationalSummary: async () => ({ runsByStatus: [{ status: "completed", count: 2 }], oldestQueuedAt: null }) } as never,
      modelCalls: { usageSummary: async () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostUsd: 0.01, failedCalls: 0 }) } as never,
      toolInvocations: { outcomeSummary: async () => [{ status: "completed", count: 1 }] } as never,
    });
    const response = await app.inject({ method: "GET", url: "/v1/operations/summary", headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ organizationId: "org-1", runs: { runsByStatus: [{ status: "completed", count: 2 }] }, models: { totalTokens: 15 }, tools: [{ status: "completed", count: 1 }] });
    await app.close();
  });
});
