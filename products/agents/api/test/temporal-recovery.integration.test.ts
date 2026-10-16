import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunWorkflow, approvalGroupSignal, cancellationSignal } from "../src/temporal/workflows";
import type { AgentRunActivities, DurableToolCall } from "../src/temporal/contracts";

const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS;
const runIntegration = Boolean(temporalAddress && process.env.RUN_TEMPORAL_INTEGRATION_TESTS === "true");

function activitiesForWorker(activities: AgentRunActivities): AgentRunActivities {
  return { ...activities, executeModelStep: activities.executeLoop };
}

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
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async ({ resumeApprovedToolCall }) => {
        calls.push(resumeApprovedToolCall ? "execute:resumed" : "execute:initial");
        if (!resumeApprovedToolCall) {
          return {
            status: "awaiting_approval",
            messages: [],
            pendingToolCalls: [{ id: "call-1", name: "test.effect", arguments: { target: "one" }, argumentsHash: "a".repeat(64), approvalGroupId: "group-1", approvalPlanDigest: "digest-1" }],
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
      maxConcurrentActivityTaskExecutions: 8,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities: activitiesForWorker(activities),
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
    await handle.signal(approvalGroupSignal, {
      groupId: "group-1",
      planDigest: "digest-1",
      decision: "approved",
      approvedBy: "approver",
      selectedOperationIds: ["call-1"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await handle.result();
    expect(resumed).toBe(true);
    expect(calls.filter((entry) => entry === "execute:resumed")).toHaveLength(1);
    expect(calls).toContain("complete");
  }, 30_000);

  it("waits for a terminal batch result before delivering an approved publish", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-batch-feedback-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: string[] = [];
    let completedOutput: Record<string, unknown> | undefined;
    let executionCount = 0;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { calls.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async ({ batchId }) => {
        calls.push(`batch-status:${batchId}`);
        return {
          status: "PARTIAL",
          batch: {
            batchId,
            status: "PARTIAL",
            targets: [
              { platform: "THREADS", accountName: "KasiTek", state: "PUBLISHED" },
              { platform: "X", accountName: "KasiTek Labs", state: "RECONNECT_REQUIRED", remediationMode: "RECONNECT", message: "Unauthorized" },
            ],
          },
        };
      },
      executeLoop: async ({ resumeApprovedToolCall }) => {
        executionCount += 1;
        if (!resumeApprovedToolCall) {
          return {
            status: "awaiting_approval",
            messages: [],
            pendingToolCalls: [{ id: "call-1", name: "kasitek.core.content_post_publish_batch", arguments: { postId: "post-1" }, argumentsHash: "a".repeat(64), approvalGroupId: "group-1", approvalPlanDigest: "digest-1" }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
            iterations: 0,
            toolCalls: 1,
          };
        }
        return {
          status: "completed",
          messages: [],
          completionMessage: "Publishing “Launch” to the selected destinations.",
          pendingBatch: { toolName: "kasitek.core.content_post_publish_batch" as const, batchId: "batch-1", title: "Launch" },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          iterations: 0,
          toolCalls: 1,
        };
      },
      pauseRun: async () => { calls.push("pause"); },
     deliverApprovalPrompt: async () => { calls.push("approval-prompt"); },
      cancelHandoff: async () => { calls.push("cancel-handoff"); },
      completeRun: async ({ output }) => { completedOutput = output; calls.push("complete"); },
      generateConversationTitle: async () => { calls.push("title"); },
      deliverRunReply: async () => { calls.push("deliver"); },
      failRun: async () => { calls.push("failed"); },
    };
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentActivityTaskPolls: 8,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities: activitiesForWorker(activities),
    });
    workers.push(worker);
    runs.push(worker.run());
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("workflow did not pause for batch approval")), 10_000);
      const timer = setInterval(() => {
        if (calls.includes("pause")) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    await handle.signal(approvalGroupSignal, {
      groupId: "group-1",
      planDigest: "digest-1",
      decision: "approved",
      approvedBy: "approver",
      selectedOperationIds: ["call-1"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await handle.result();
    expect(executionCount).toBe(2);
    expect(calls).toContain("batch-status:batch-1");
    expect(completedOutput).toMatchObject({ message: "Published to Threads (KasiTek). X (KasiTek Labs) — Unauthorized (reconnect) still need attention." });
    expect(calls).toContain("deliver");
    expect(calls).not.toContain("failed");
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
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
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
        activities: activitiesForWorker(activities),
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

  it("honors cancellation while queued behind a conversation turn", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-queued-cancel-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: string[] = [];
    let admissionChecks = 0;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { calls.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => {
        admissionChecks += 1;
        return false;
      },
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => ({
        status: "completed",
        messages: [],
        completionMessage: "Should not execute while queued.",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        iterations: 0,
        toolCalls: 0,
      }),
      pauseRun: async () => undefined,
     deliverApprovalPrompt: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => { calls.push("complete"); },
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async () => { calls.push("failed"); },
    };
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentActivityTaskPolls: 8,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities: activitiesForWorker(activities),
    });
    workers.push(worker);
    runs.push(worker.run());
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("workflow did not enter the conversation queue")), 10_000);
      const timer = setInterval(() => {
        if (admissionChecks > 0) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    await handle.signal(cancellationSignal, { reason: "queued cancellation" });
    await handle.result();
    expect(calls).toContain("transition:cancelled");
    expect(calls).not.toContain("complete");
    expect(calls).not.toContain("failed");
    expect(admissionChecks).toBeLessThanOrEqual(2);
  }, 30_000);

  it("cancels the handoff created by an in-flight run before marking the run cancelled", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-handoff-cancel-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: string[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { calls.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
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
      maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentActivityTaskPolls: 8,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities: activitiesForWorker(activities),
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

  it("fans out a model tool batch through Temporal Activities and commits the ordered join", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-tool-batch-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: DurableToolCall[] = [
      { id: "runtime-1", providerToolCallId: "provider-1", name: "records.first", arguments: {}, argumentsHash: "hash-1", sequenceNumber: 1 },
      { id: "runtime-2", providerToolCallId: "provider-2", name: "records.second", arguments: {}, argumentsHash: "hash-2", sequenceNumber: 2 },
      { id: "runtime-3", providerToolCallId: "provider-3", name: "records.write", arguments: { value: 3 }, argumentsHash: "hash-3", sequenceNumber: 3 },
    ];
    const events: string[] = [];
    const committedOrders: string[][] = [];
    let active = 0;
    let maxActive = 0;
    let loopCalls = 0;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { events.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => {
        loopCalls += 1;
        if (loopCalls === 1) {
          return {
            status: "limited",
            checkpointed: true,
            toolBatchPending: true,
            pendingToolCalls: calls,
            messages: [{ role: "assistant", content: "", toolCalls: calls.map((call) => ({ id: call.providerToolCallId!, runtimeOperationId: call.id, name: call.name, arguments: call.arguments })) }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
            iterations: 1,
            toolCalls: 0,
          };
        }
        return {
          status: "completed",
          messages: [],
          completionMessage: "The batch completed.",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          iterations: 2,
          toolCalls: calls.length,
        };
      },
      prepareToolBatch: async ({ calls: prepared }) => {
        events.push("prepare");
        return [
          { kind: "parallel" as const, segmentId: "batch:segment:1", calls: prepared.slice(0, 2) },
          { kind: "sequential" as const, segmentId: "batch:segment:2", calls: prepared.slice(2, 3) },
        ];
      },
      executeToolCall: async ({ call }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${call.id}`);
        // Keep the Activity body longer than local Temporal scheduling jitter so
        // this assertion verifies actual overlap rather than winning a race.
        await new Promise((resolve) => setTimeout(resolve, call.id === "runtime-1" ? 250 : 150));
        active -= 1;
        events.push(`complete:${call.id}`);
        return { id: call.id, providerToolCallId: call.providerToolCallId!, name: call.name, argumentsHash: call.argumentsHash, status: "completed" as const, output: { id: call.id } };
      },
      commitToolBatch: async ({ results }) => {
        committedOrders.push(results.map((result) => result.id));
        events.push("commit");
        return { status: "committed" as const, toolCalls: results.length };
      },
      pauseRun: async () => undefined,
     deliverApprovalPrompt: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => { events.push("complete"); },
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "failed")); },
    };
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentActivityTaskPolls: 8,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities: activitiesForWorker(activities),
    });
    workers.push(worker);
    runs.push(worker.run());
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await handle.result();
    expect(maxActive).toBe(2);
    expect(committedOrders).toEqual([["runtime-1", "runtime-2"], ["runtime-3"]]);
    expect(events).toContain("prepare");
    expect(events).toContain("complete");
    expect(loopCalls).toBe(2);
  }, 30_000);

  it("replays a durable completed sibling after worker loss during a parallel segment", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-tool-worker-loss-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: DurableToolCall[] = Array.from({ length: 18 }, (_, index) => ({
      id: `runtime-${index + 1}`,
      providerToolCallId: `provider-${index + 1}`,
      name: "records.read",
      arguments: { index: index + 1 },
      argumentsHash: `hash-${index + 1}`,
      sequenceNumber: index + 1,
    }));
    const activityAttempts = new Map<string, number>();
    const durableResults = new Map<string, DurableToolCallResult>();
    const providerInvocations = new Map<string, number>();
    const events: string[] = [];
    let loopCalls = 0;
    let firstWorker: Worker | undefined;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { events.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => {
        loopCalls += 1;
        if (loopCalls === 1) {
          return {
            status: "limited",
            checkpointed: true,
            toolBatchPending: true,
            pendingToolCalls: calls,
            messages: [{ role: "assistant", content: "", toolCalls: calls.map((call) => ({ id: call.providerToolCallId!, runtimeOperationId: call.id, name: call.name, arguments: call.arguments })) }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
            iterations: 1,
            toolCalls: 0,
          };
        }
        return {
          status: "completed",
          messages: [],
          completionMessage: "The recovered batch completed.",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          iterations: 2,
          toolCalls: calls.length,
        };
      },
      prepareToolBatch: async ({ calls: prepared }) => [{ kind: "parallel" as const, segmentId: "batch:segment:1", calls: prepared }],
      executeToolCall: async ({ call }) => {
        const attempt = (activityAttempts.get(call.id) ?? 0) + 1;
        activityAttempts.set(call.id, attempt);
        const completed = durableResults.get(call.id);
        if (completed) {
          events.push(`replay:${call.id}`);
          return completed;
        }
        providerInvocations.set(call.id, (providerInvocations.get(call.id) ?? 0) + 1);
        const result: DurableToolCallResult = { id: call.id, providerToolCallId: call.providerToolCallId!, name: call.name, argumentsHash: call.argumentsHash, status: "completed", output: { id: call.id } };
        durableResults.set(call.id, result);
        if (call.id === "runtime-1" && attempt === 1) {
          events.push("worker-loss");
          firstWorker?.shutdown();
          throw new Error("synthetic worker loss after durable tool result");
        }
        return result;
      },
      commitToolBatch: async ({ results }) => ({ status: "committed" as const, toolCalls: results.length }),
      pauseRun: async () => undefined,
     deliverApprovalPrompt: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => { events.push("complete"); },
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "failed")); },
    };
    const startWorker = async (): Promise<Worker> => {
      const worker = await Worker.create({
        connection,
        namespace: "default",
        taskQueue,
        maxConcurrentActivityTaskExecutions: 8,
        workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
        activities: activitiesForWorker(activities),
      });
      workers.push(worker);
      runs.push(worker.run());
      return worker;
    };
    firstWorker = await startWorker();
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      // The recovery test may run beside several Temporal worker-bundle builds in the combined
      // local matrix. Give the injected worker-loss event enough time to be scheduled without
      // weakening the workflow's recovery assertions.
      const deadline = setTimeout(() => reject(new Error("parallel batch did not lose its worker")), 30_000);
      const timer = setInterval(() => {
        if (events.includes("worker-loss")) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });
    const workerIndex = workers.indexOf(firstWorker);
    if (workerIndex >= 0) workers.splice(workerIndex, 1);
    await startWorker();
    await handle.result();
    expect(providerInvocations.size).toBe(calls.length);
    expect([...providerInvocations.values()].every((count) => count === 1)).toBe(true);
    expect(activityAttempts.get("runtime-1")).toBe(2);
    expect([...activityAttempts.keys()].sort()).toEqual(calls.map((call) => call.id).sort());
    expect(events).toContain("replay:runtime-1");
    expect(events).toContain("complete");
  }, 30_000);

  it("replays an ordered join after worker loss during result persistence", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-tool-commit-loss-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: DurableToolCall[] = [
      { id: "commit-runtime-1", providerToolCallId: "commit-provider-1", name: "records.read", arguments: { index: 1 }, argumentsHash: "commit-hash-1", sequenceNumber: 1 },
      { id: "commit-runtime-2", providerToolCallId: "commit-provider-2", name: "records.read", arguments: { index: 2 }, argumentsHash: "commit-hash-2", sequenceNumber: 2 },
    ];
    const events: string[] = [];
    const providerInvocations = new Map<string, number>();
    let modelSteps = 0;
    let commitAttempts = 0;
    let durableCommitPersisted = false;
    let firstWorker: Worker | undefined;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { events.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1
          ? {
              status: "limited",
              checkpointed: true,
              toolBatchPending: true,
              pendingToolCalls: calls,
              messages: [{ role: "assistant", content: "", toolCalls: calls.map((current) => ({ id: current.providerToolCallId!, runtimeOperationId: current.id, name: current.name, arguments: current.arguments })) }],
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
              iterations: 1,
              toolCalls: 0,
            }
          : {
              status: "completed",
              messages: [],
              completionMessage: "The recovered commit completed.",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
              iterations: 2,
              toolCalls: calls.length,
            };
      },
      prepareToolBatch: async ({ calls: prepared }) => [{ kind: "parallel" as const, segmentId: "batch:segment:1", calls: prepared }],
      executeToolCall: async ({ call }) => {
        providerInvocations.set(call.id, (providerInvocations.get(call.id) ?? 0) + 1);
        return { id: call.id, providerToolCallId: call.providerToolCallId!, name: call.name, argumentsHash: call.argumentsHash, status: "completed" as const, output: { id: call.id } };
      },
      commitToolBatch: async ({ results }) => {
        commitAttempts += 1;
        if (!durableCommitPersisted) {
          durableCommitPersisted = true;
          events.push("commit-loss");
          firstWorker?.shutdown();
          throw new Error("synthetic worker loss after durable result commit");
        }
        return { status: "replayed" as const, toolCalls: results.length };
      },
      pauseRun: async () => undefined,
     deliverApprovalPrompt: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => { events.push("complete"); },
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "failed")); },
    };
    const startWorker = async (): Promise<Worker> => {
      const worker = await Worker.create({
        connection,
        namespace: "default",
        taskQueue,
        maxConcurrentActivityTaskExecutions: 8,
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
      // The recovery test may run beside several Temporal worker-bundle builds in the combined
      // local matrix. Give the injected worker-loss event enough time to be scheduled without
      // weakening the workflow's recovery assertions.
      const deadline = setTimeout(() => reject(new Error("ordered join did not lose its worker")), 30_000);
      const timer = setInterval(() => {
        if (events.includes("commit-loss")) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });
    const workerIndex = workers.indexOf(firstWorker);
    if (workerIndex >= 0) workers.splice(workerIndex, 1);
    await startWorker();
    await handle.result();

    expect(providerInvocations).toEqual(new Map([[calls[0]!.id, 1], [calls[1]!.id, 1]]));
    expect(commitAttempts).toBe(2);
    expect(modelSteps).toBe(2);
    expect(events).toContain("complete");
  }, 30_000);

  it("pauses one approved operation without repeating completed siblings", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-tool-approval-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: DurableToolCall[] = [
      { id: "read-1", providerToolCallId: "provider-read-1", name: "records.read", arguments: {}, argumentsHash: "read-hash", sequenceNumber: 1 },
      { id: "write-1", providerToolCallId: "provider-write-1", name: "records.write", arguments: { value: 1 }, argumentsHash: "write-hash", sequenceNumber: 2 },
    ];
    const approvalGroupId = randomUUID();
    const approvalPlanDigest = "recovery-approval-plan";
    const events: string[] = [];
    const executionAttempts = new Map<string, number>();
    let loopCalls = 0;
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { events.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => {
        loopCalls += 1;
        if (loopCalls === 1) {
          return {
            status: "limited",
            checkpointed: true,
            toolBatchPending: true,
            pendingToolCalls: calls,
            messages: [{ role: "assistant", content: "", toolCalls: calls.map((call) => ({ id: call.providerToolCallId!, runtimeOperationId: call.id, name: call.name, arguments: call.arguments })) }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
            iterations: 1,
            toolCalls: 0,
          };
        }
        return {
          status: "completed",
          messages: [],
          completionMessage: "The approved batch completed.",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          iterations: 2,
          toolCalls: calls.length,
        };
      },
      prepareToolBatch: async ({ calls: prepared }) => [
        { kind: "parallel" as const, segmentId: "batch:segment:1", calls: prepared.slice(0, 1) },
        {
          kind: "sequential" as const,
          segmentId: "batch:segment:2",
          calls: prepared.slice(1).map((call) => ({ ...call, approvalGroupId, approvalPlanDigest })),
        },
      ],
      executeToolCall: async ({ call, approval }) => {
        const attempt = (executionAttempts.get(call.id) ?? 0) + 1;
        executionAttempts.set(call.id, attempt);
        events.push(`execute:${call.id}:${approval ? "approved" : "unapproved"}`);
        if (call.id === "write-1" && !approval) {
          return { id: call.id, providerToolCallId: call.providerToolCallId!, name: call.name, argumentsHash: call.argumentsHash, status: "waiting" as const, error: { code: "APPROVAL_REQUIRED", message: "Approval required" } };
        }
        return { id: call.id, providerToolCallId: call.providerToolCallId!, name: call.name, argumentsHash: call.argumentsHash, status: "completed" as const, output: { id: call.id } };
      },
      commitToolBatch: async ({ results }) => {
        events.push(`commit:${results.map((result) => result.id).join(",")}`);
        return { status: "committed" as const, toolCalls: results.length };
      },
      pauseRun: async () => { events.push("pause"); },
     deliverApprovalPrompt: async () => { events.push("approval-prompt"); },
      cancelHandoff: async () => undefined,
      completeRun: async () => { events.push("complete"); },
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "failed")); },
    };
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      maxConcurrentActivityTaskExecutions: 8,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities: activitiesForWorker(activities),
    });
    workers.push(worker);
    runs.push(worker.run());
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("workflow did not pause for batch approval")), 10_000);
      const timer = setInterval(() => {
        if (events.includes("pause")) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    await handle.signal(approvalGroupSignal, {
      groupId: approvalGroupId,
      planDigest: approvalPlanDigest,
      decision: "approved",
      approvedBy: "approver",
      selectedOperationIds: ["write-1"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await handle.result();
    expect(executionAttempts.get("read-1")).toBe(1);
    expect(executionAttempts.get("write-1")).toBe(1);
    expect(events).toEqual(expect.arrayContaining(["commit:read-1", "commit:write-1", "complete"]));
    expect(loopCalls).toBe(2);
  }, 30_000);

  it("keeps the Temporal fan-out bounded across 18, 32, 64, 128, and 256-call batches", async () => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-tool-scale-${randomUUID()}`;
    const sizes = [18, 32, 64, 128, 256];
    const sizeByRun = new Map<string, number>();
    const phaseByRun = new Map<string, number>();
    const activeByRun = new Map<string, number>();
    const maxActiveByRun = new Map<string, number>();
    const committedByRun = new Map<string, number>();
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async ({ runId }) => {
        const size = sizeByRun.get(runId)!;
        const phase = (phaseByRun.get(runId) ?? 0) + 1;
        phaseByRun.set(runId, phase);
        if (phase > 1) {
          return {
            status: "completed",
            messages: [],
            completionMessage: `${size} calls completed.`,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
            iterations: 2,
            toolCalls: size,
          };
        }
        const calls = Array.from({ length: size }, (_, index) => ({
          id: `runtime-${index + 1}`,
          providerToolCallId: `provider-${index + 1}`,
          name: "records.read",
          arguments: { index },
          argumentsHash: `hash-${index + 1}`,
        }));
        return {
          status: "limited",
          checkpointed: true,
          toolBatchPending: true,
          pendingToolCalls: calls,
          messages: [{ role: "assistant", content: "", toolCalls: calls.map((call) => ({ id: call.providerToolCallId, runtimeOperationId: call.id, name: call.name, arguments: call.arguments })) }],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          iterations: 1,
          toolCalls: 0,
        };
      },
      prepareToolBatch: async ({ calls }) => [{ kind: "parallel" as const, segmentId: "batch:segment:1", calls }],
      executeToolCall: async ({ runId, call }) => {
        const active = (activeByRun.get(runId) ?? 0) + 1;
        activeByRun.set(runId, active);
        maxActiveByRun.set(runId, Math.max(maxActiveByRun.get(runId) ?? 0, active));
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeByRun.set(runId, active - 1);
        return { id: call.id, providerToolCallId: call.providerToolCallId!, name: call.name, argumentsHash: call.argumentsHash, status: "completed" as const, output: { index: call.arguments.index } };
      },
      commitToolBatch: async ({ runId, results }) => {
        committedByRun.set(runId, (committedByRun.get(runId) ?? 0) + results.length);
        return { status: "committed" as const, toolCalls: results.length };
      },
      pauseRun: async () => undefined,
     deliverApprovalPrompt: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "failed")); },
    };
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      maxConcurrentActivityTaskExecutions: 8,
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities: activitiesForWorker(activities),
    });
    workers.push(worker);
    runs.push(worker.run());
    const client = new Client({ connection, namespace: "default" });
    const handles = sizes.map((size) => {
      const workflowId = `agent-run-${size}-${randomUUID()}`;
      sizeByRun.set(workflowId, size);
      return client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    });
    await Promise.all((await Promise.all(handles)).map((handle) => handle.result()));
    for (const [runId, size] of sizeByRun) {
      expect(committedByRun.get(runId)).toBe(size);
      expect(maxActiveByRun.get(runId)).toBeLessThanOrEqual(8);
    }
  }, 60_000);
});
