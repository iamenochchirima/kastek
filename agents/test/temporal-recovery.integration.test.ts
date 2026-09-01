import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunWorkflow, approvalSignal, cancellationSignal } from "../src/temporal/workflows";
import type { AgentRunActivities } from "../src/temporal/contracts";

const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS;
const runIntegration = Boolean(temporalAddress && process.env.RUN_TEMPORAL_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("Temporal workflow recovery (integration)", () => {
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
          completionMessage: "The approved action completed.",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          iterations: 0,
          toolCalls: 1,
        };
      },
      pauseRun: async () => { calls.push("pause"); },
      deliverApprovalPrompt: async () => { calls.push("approval-prompt"); },
      cancelPendingApproval: async () => { calls.push("cancel"); },
      cancelHandoff: async () => { calls.push("cancel-handoff"); },
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
    if (firstWorker.getState() === "INITIALIZED" || firstWorker.getState() === "RUNNING") firstWorker.shutdown();
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

  it("resumes the next bounded loop slice after the first worker is replaced", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-loop-recovery-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: string[] = [];
    let executions = 0;
    let firstWorker: Worker | undefined;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { calls.push(`transition:${nextStatus}`); },
      executeLoop: async () => {
        executions += 1;
        calls.push(`execute:${executions}`);
        if (executions === 1) {
          firstWorker?.shutdown();
          return {
            status: "limited",
            checkpointed: true,
            messages: [{ role: "tool", name: "records.search", toolCallId: "call-1", content: "checkpointed" }],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
            iterations: 1,
            toolCalls: 1,
          };
        }
        return {
          status: "completed",
          messages: [],
          completionMessage: "The resumed slice completed.",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
          iterations: 1,
          toolCalls: 0,
        };
      },
      pauseRun: async () => { calls.push("pause"); },
      deliverApprovalPrompt: async () => { calls.push("approval-prompt"); },
      cancelPendingApproval: async () => { calls.push("cancel-approval"); },
      cancelHandoff: async () => { calls.push("cancel-handoff"); },
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
    firstWorker = await startWorker();
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("workflow did not complete its first loop slice")), 10_000);
      const timer = setInterval(() => {
        if (calls.includes("execute:1")) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    if (firstWorker.getState() === "INITIALIZED" || firstWorker.getState() === "RUNNING") firstWorker.shutdown();
    const workerIndex = workers.indexOf(firstWorker);
    if (workerIndex >= 0) workers.splice(workerIndex, 1);
    await startWorker();
    await handle.result();
    expect(executions).toBe(2);
    expect(calls).toContain("complete");
    expect(calls).not.toContain("failed");
  }, 30_000);

  it("cancels the handoff created by an in-flight run before marking the run cancelled", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-handoff-cancel-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: string[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { calls.push(`transition:${nextStatus}`); },
      executeLoop: async () => ({
        status: "awaiting_human",
        messages: [],
        waitingFor: "handoff-1",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        iterations: 1,
        toolCalls: 1,
      }),
      pauseRun: async () => { calls.push("pause"); },
      deliverApprovalPrompt: async () => { calls.push("approval-prompt"); },
      cancelPendingApproval: async () => { calls.push("cancel-approval"); },
      cancelHandoff: async () => { calls.push("cancel-handoff"); },
      completeRun: async () => { calls.push("complete"); },
      generateConversationTitle: async () => { calls.push("title"); },
      deliverRunReply: async () => { calls.push("deliver"); },
      failRun: async () => { calls.push("failed"); },
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
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("workflow did not pause for handoff")), 10_000);
      const timer = setInterval(() => {
        if (calls.includes("pause")) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    await handle.signal(cancellationSignal, { reason: "operator stopped the run" });
    await handle.result();
    expect(calls).toContain("cancel-handoff");
    expect(calls).toContain("transition:cancelled");
    expect(calls.indexOf("cancel-handoff")).toBeLessThan(calls.indexOf("transition:cancelled"));
  }, 30_000);
});
