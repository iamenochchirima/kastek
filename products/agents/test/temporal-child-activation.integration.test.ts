import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it } from "vitest";
import { agentChildWorkflow } from "../src/temporal/workflows";
import type {
  ChildWorkflowActivities,
  TemporalChildWorkflowInput,
} from "../src/children/temporal-activation";

const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS;
const runIntegration = Boolean(temporalAddress && process.env.RUN_TEMPORAL_INTEGRATION_TESTS === "true");

const input: TemporalChildWorkflowInput = {
  scope: {
    invocationId: "invocation-integration",
    parentRunId: "parent-run",
    organizationId: "org",
    installationId: "installation",
    correlationId: "correlation",
    causationId: "parent-run",
    childAgentDefinitionId: "child-agent",
    childAgentVersionId: "child-v1",
    capabilityGrants: [],
    resourceGrants: [],
  },
  input: { task: "research" },
  operationId: "parent-run:child:invocation-integration",
  budget: { contextTokens: 100, modelTokens: 100, toolCalls: 2, graphSteps: 2, wallTimeMs: 5_000 },
  timeoutMs: 5_000,
  retryPolicy: {
    maximumAttempts: 2,
    initialIntervalMs: 1,
    maximumIntervalMs: 10,
    backoffCoefficient: 1,
    retryableCodes: ["CHILD_RETRYABLE"],
  },
};

describe.skipIf(!runIntegration)("Temporal child activation (integration)", () => {
  const workers: Worker[] = [];
  const runs: Promise<void>[] = [];
  const connections: NativeConnection[] = [];

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.getState() === "INITIALIZED" || worker.getState() === "RUNNING") worker.shutdown();
    }
    await Promise.all(runs.splice(0));
    for (const connection of connections.splice(0)) await connection.close();
  });

  it("retries a retryable activity and returns durable lineage/progress evidence", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-child-${randomUUID()}`;
    const calls: number[] = [];
    const progress: string[] = [];
    const terminal: string[] = [];
    const activities: ChildWorkflowActivities = {
      executeChild: async ({ attempt }) => {
        calls.push(attempt);
        if (attempt === 1) return { status: "failed", retryable: true, error: { code: "CHILD_RETRYABLE", message: "temporary" } };
        return { status: "succeeded", output: { answer: 42 } };
      },
      recordChildProgress: async ({ evidence }) => { progress.push(evidence.phase); },
      recordChildOutcome: async ({ outcome }) => { terminal.push(outcome.status); },
    };
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities,
    });
    workers.push(worker);
    runs.push(worker.run());
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentChildWorkflow, {
      workflowId: "agent-child-integration-retry",
      taskQueue,
      args: [input],
    });

    const result = await handle.result();
    expect(result).toMatchObject({
      status: "succeeded",
      output: { answer: 42 },
      lineage: {
        invocationId: input.scope.invocationId,
        parentRunId: input.scope.parentRunId,
        attempts: 2,
      },
    });
    expect(calls).toEqual([1, 2]);
    expect(progress).toContain("completed");
    expect(terminal).toEqual(["succeeded"]);
  }, 30_000);

  it("preserves a partial result as a typed terminal outcome", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-child-partial-${randomUUID()}`;
    const activities: ChildWorkflowActivities = {
      executeChild: async () => ({ status: "partial", partialOutput: { completed: ["one"] }, error: { code: "CHILD_TIMEOUT", message: "deadline" } }),
      recordChildProgress: async () => undefined,
      recordChildOutcome: async () => undefined,
    };
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities,
    });
    workers.push(worker);
    runs.push(worker.run());
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentChildWorkflow, {
      workflowId: "agent-child-integration-partial",
      taskQueue,
      args: [{ ...input, scope: { ...input.scope, invocationId: "invocation-partial" } }],
    });

    await expect(handle.result()).resolves.toMatchObject({
      status: "partial",
      partialOutput: { completed: ["one"] },
      error: { code: "CHILD_TIMEOUT" },
    });
  }, 30_000);
});
