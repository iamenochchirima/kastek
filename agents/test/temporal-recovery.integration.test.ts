import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunWorkflow, approvalSignal } from "../src/temporal/workflows";
import type { AgentRunActivities } from "../src/temporal/contracts";

const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS;
const runIntegration = Boolean(temporalAddress && process.env.RUN_TEMPORAL_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("Temporal approval recovery (integration)", () => {
  const workers: Worker[] = [];
  const runs: Promise<void>[] = [];
  const connections: NativeConnection[] = [];

  afterEach(async () => {
    for (const worker of workers.splice(0)) worker.shutdown();
    await Promise.all(runs.splice(0));
    for (const connection of connections.splice(0)) await connection.close();
  });

  it("keeps an approval wait durable across worker replacement and resumes exactly once", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-recovery-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: string[] = [];
    let resumed = false;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { calls.push(`transition:${nextStatus}`); },
      executeLoop: async ({ resumeApprovedToolCall }) => {
        calls.push(resumeApprovedToolCall ? "execute:resumed" : "execute:initial");
        if (!resumeApprovedToolCall) {
          return {
            status: "awaiting_approval",
            messages: [],
            pendingToolCalls: [{ id: "call-1", name: "test.effect", arguments: { target: "one" }, argumentsHash: "a".repeat(64) }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
            iterations: 0,
            toolCalls: 1,
          };
        }
        resumed = true;
        return {
          status: "completed",
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          iterations: 0,
          toolCalls: 1,
        };
      },
      pauseRun: async () => { calls.push("pause"); },
      cancelPendingApproval: async () => { calls.push("cancel"); },
      completeRun: async () => { calls.push("complete"); },
      generateConversationTitle: async () => { calls.push("title"); },
      deliverRunReply: async () => { calls.push("deliver"); },
      failRun: async () => { calls.push("failed"); },
    };
    const startWorker = async () => {
      const worker = await Worker.create({
        connection,
        namespace: "default",
        taskQueue,
        workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
        activities,
      });
      workers.push(worker);
      runs.push(worker.run());
      return worker;
    };
    const firstWorker = await startWorker();
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("workflow did not pause for approval")), 10_000);
      const timer = setInterval(() => {
        if (calls.includes("pause")) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    await firstWorker.shutdown();
    const workerIndex = workers.indexOf(firstWorker);
    if (workerIndex >= 0) workers.splice(workerIndex, 1);
    await startWorker();
    await handle.signal(approvalSignal, {
      decision: "approved",
      approvedBy: "approver",
      argumentsHash: "a".repeat(64),
      providerToolCallId: "call-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await handle.result();
    expect(resumed).toBe(true);
    expect(calls.filter((entry) => entry === "execute:resumed")).toHaveLength(1);
    expect(calls).toContain("complete");
  }, 30_000);
});
