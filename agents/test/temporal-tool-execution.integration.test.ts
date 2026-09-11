import { randomUUID } from "node:crypto";
import { ApplicationFailure, cancellationSignal as activityCancellationSignal, heartbeat } from "@temporalio/activity";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunWorkflow, approvalGroupSignal, cancellationSignal } from "../src/temporal/workflows";
import type { AgentRunActivities, DurableAgentLoopResult, DurableToolCall, DurableToolCallResult } from "../src/temporal/contracts";

const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS;
const runIntegration = Boolean(temporalAddress && process.env.RUN_TEMPORAL_INTEGRATION_TESTS === "true");

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 };

function completedResult(message: string): DurableAgentLoopResult {
  return {
    status: "completed",
    messages: [],
    completionMessage: message,
    usage,
    iterations: 1,
    toolCalls: 1,
  };
}

function pendingResult(call: DurableToolCall): DurableAgentLoopResult {
  return {
    status: "limited",
    checkpointed: true,
    toolBatchPending: true,
    pendingToolCalls: [call],
    messages: [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: call.providerToolCallId ?? call.id,
        runtimeOperationId: call.id,
        name: call.name,
        arguments: call.arguments,
      }],
    }],
    usage,
    iterations: 1,
    toolCalls: 0,
  };
}

function pendingBatchResult(calls: DurableToolCall[]): DurableAgentLoopResult {
  return {
    status: "limited",
    checkpointed: true,
    toolBatchPending: true,
    pendingToolCalls: calls,
    messages: [{
      role: "assistant",
      content: "",
      toolCalls: calls.map((current) => ({
        id: current.providerToolCallId ?? current.id,
        runtimeOperationId: current.id,
        name: current.name,
        arguments: current.arguments,
      })),
    }],
    usage,
    iterations: 1,
    toolCalls: 0,
  };
}

function call(id = "runtime-1"): DurableToolCall {
  return {
    id,
    providerToolCallId: `provider-${id}`,
    name: "records.read",
    arguments: { id },
    argumentsHash: `hash-${id}`,
    sequenceNumber: 1,
  };
}

describe.skipIf(!runIntegration)("Temporal tool execution reliability (integration)", () => {
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

  async function startWorker(taskQueue: string, activities: AgentRunActivities): Promise<Client> {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      maxConcurrentActivityTaskExecutions: 64,
      maxHeartbeatThrottleInterval: "100ms",
      defaultHeartbeatThrottleInterval: "100ms",
      workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname,
      activities,
    });
    workers.push(worker);
    runs.push(worker.run());
    return new Client({ connection, namespace: "default" });
  }

  it("retries a retryable tool Activity before the ordered join and invokes the provider once successfully", async () => {
    const taskQueue = `agent-tool-retry-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const toolCall = call();
    let modelSteps = 0;
    let attempts = 0;
    const providerInvocations: string[] = [];
    const committed: string[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1 ? pendingResult(toolCall) : completedResult("The retryable tool completed.");
      },
      prepareToolBatch: async ({ calls }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls }],
      executeToolCall: async ({ call: current }) => {
        attempts += 1;
        if (attempts === 1) throw ApplicationFailure.retryable("provider temporarily unavailable", "PROVIDER_UNAVAILABLE");
        providerInvocations.push(current.id);
        return {
          id: current.id,
          providerToolCallId: current.providerToolCallId!,
          name: current.name,
          argumentsHash: current.argumentsHash,
          status: "completed",
          output: { ok: true },
        } satisfies DurableToolCallResult;
      },
      commitToolBatch: async ({ results }) => {
        committed.push(...results.map((result) => result.id));
        return { status: "committed", toolCalls: results.length };
      },
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await handle.result();

    expect(attempts).toBe(2);
    expect(providerInvocations).toEqual([toolCall.id]);
    expect(committed).toEqual([toolCall.id]);
    expect(modelSteps).toBe(2);
  }, 30_000);

  it("keeps one logical batch across model, preparation, and commit retries", async () => {
    const taskQueue = `agent-tool-boundary-retries-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const toolCall = call("runtime-boundary-retry");
    let modelAttempts = 0;
    let prepareAttempts = 0;
    let toolExecutions = 0;
    let commitAttempts = 0;
    let committedResults: DurableToolCallResult[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelAttempts += 1;
        if (modelAttempts === 1) throw ApplicationFailure.retryable("model temporarily unavailable", "MODEL_UNAVAILABLE");
        return modelAttempts === 2 ? pendingResult(toolCall) : completedResult("The retried batch completed.");
      },
      prepareToolBatch: async ({ calls }) => {
        prepareAttempts += 1;
        if (prepareAttempts === 1) throw ApplicationFailure.retryable("batch persistence temporarily unavailable", "BATCH_PERSISTENCE_UNAVAILABLE");
        return [{ kind: "parallel", segmentId: "batch:segment:1", calls }];
      },
      executeToolCall: async ({ call: current }) => {
        toolExecutions += 1;
        return {
          id: current.id,
          providerToolCallId: current.providerToolCallId!,
          name: current.name,
          argumentsHash: current.argumentsHash,
          status: "completed",
          output: { ok: true },
        } satisfies DurableToolCallResult;
      },
      commitToolBatch: async ({ results }) => {
        commitAttempts += 1;
        if (commitAttempts === 1) throw ApplicationFailure.retryable("result persistence temporarily unavailable", "RESULT_PERSISTENCE_UNAVAILABLE");
        committedResults = results;
        return { status: "committed", toolCalls: results.length };
      },
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await handle.result();

    expect(modelAttempts).toBe(3);
    expect(prepareAttempts).toBe(2);
    expect(toolExecutions).toBe(1);
    expect(commitAttempts).toBe(2);
    expect(committedResults.map((result) => result.id)).toEqual([toolCall.id]);
  }, 30_000);

  it("waits once for an approval group and executes every selected operation after resume", async () => {
    const taskQueue = `agent-approval-group-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const groupId = randomUUID();
    const planDigest = "d".repeat(64);
    const calls = Array.from({ length: 18 }, (_, index) => call(`approval-${index + 1}`)).map((current, index) => ({
      ...current,
      sequenceNumber: index + 1,
      name: "records.delete",
    }));
    let modelSteps = 0;
    let paused = false;
    const approvals: Array<{ id: string; groupId?: string; approvedBy?: string }> = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1 ? pendingBatchResult(calls) : completedResult("The approved group completed.");
      },
      prepareToolBatch: async ({ calls: prepared }) => [
        ...prepared.map((current) => ({
          kind: "sequential" as const,
          segmentId: `batch:segment:${current.id}`,
          calls: [{ ...current, approvalGroupId: groupId, approvalPlanDigest: planDigest }],
        })),
      ],
      executeToolCall: async ({ call: current, approval, approvalGroupId }) => {
        approvals.push({ id: current.id, groupId: approvalGroupId ?? approval?.approvalGroupId, approvedBy: approval?.approvedBy });
        return {
          id: current.id,
          providerToolCallId: current.providerToolCallId!,
          name: current.name,
          argumentsHash: current.argumentsHash,
          status: "completed",
          output: { ok: true, id: current.id },
        } satisfies DurableToolCallResult;
      },
      commitToolBatch: async ({ results }) => ({ status: "committed", toolCalls: results.length }),
      pauseRun: async () => { paused = true; },
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("workflow did not pause for approval group")), 10_000);
      const timer = setInterval(() => {
        if (paused) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    await handle.signal(approvalGroupSignal, {
      groupId,
      planDigest,
      decision: "approved",
      approvedBy: "approver",
      selectedOperationIds: calls.map((current) => current.id),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await handle.result();
    expect(approvals).toEqual(calls.map((current) => ({ id: current.id, groupId, approvedBy: "approver" })));
    expect(approvals).toHaveLength(18);
    expect(modelSteps).toBe(2);
  }, 30_000);

  it("commits an unknown post-effect outcome without retrying or replaying the provider call", async () => {
    const taskQueue = `agent-tool-unknown-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const toolCall = call();
    let modelSteps = 0;
    let attempts = 0;
    const committedResults: DurableToolCallResult[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1 ? pendingResult(toolCall) : completedResult("The uncertain tool outcome was recorded.");
      },
      prepareToolBatch: async ({ calls }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls }],
      executeToolCall: async ({ call: current }) => {
        attempts += 1;
        return {
          id: current.id,
          providerToolCallId: current.providerToolCallId!,
          name: current.name,
          argumentsHash: current.argumentsHash,
          status: "unknown",
          failureClass: "unknown",
          error: { code: "PROVIDER_OUTCOME_UNKNOWN", message: "The provider connection ended after the effect began" },
        } satisfies DurableToolCallResult;
      },
      commitToolBatch: async ({ results }) => {
        committedResults.push(...results);
        return { status: "committed", toolCalls: results.length };
      },
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await handle.result();

    expect(attempts).toBe(1);
    expect(committedResults).toHaveLength(1);
    expect(committedResults[0]).toMatchObject({ id: toolCall.id, status: "unknown", failureClass: "unknown" });
    expect(modelSteps).toBe(2);
  }, 30_000);

  it("commits a terminal tool error as a model-visible result without retrying the Activity", async () => {
    const taskQueue = `agent-tool-terminal-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const toolCall = call("runtime-terminal");
    let modelSteps = 0;
    let attempts = 0;
    const committedResults: DurableToolCallResult[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1 ? pendingResult(toolCall) : completedResult("The invalid tool request was reported to the model.");
      },
      prepareToolBatch: async ({ calls }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls }],
      executeToolCall: async ({ call: current }) => {
        attempts += 1;
        return {
          id: current.id,
          providerToolCallId: current.providerToolCallId!,
          name: current.name,
          argumentsHash: current.argumentsHash,
          status: "failed",
          failureClass: "terminal",
          error: { code: "INVALID_ARGUMENTS", message: "The tool arguments are invalid" },
        } satisfies DurableToolCallResult;
      },
      commitToolBatch: async ({ results }) => {
        committedResults.push(...results);
        return { status: "committed", toolCalls: results.length };
      },
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await handle.result();

    expect(attempts).toBe(1);
    expect(committedResults).toHaveLength(1);
    expect(committedResults[0]).toMatchObject({ id: toolCall.id, status: "failed", failureClass: "terminal" });
    expect(modelSteps).toBe(2);
  }, 30_000);

  it("keeps multiple autonomous tool rounds paired with their ordered transcript results", async () => {
    const taskQueue = `agent-tool-multi-round-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const firstRound = [call("round-1-a"), call("round-1-b"), call("round-1-c")];
    const secondRound = [call("round-2-a"), call("round-2-b")];
    let modelSteps = 0;
    const executed: string[] = [];
    const commits: string[][] = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        if (modelSteps === 1) return pendingBatchResult(firstRound);
        if (modelSteps === 2) return pendingBatchResult(secondRound);
        return completedResult("Both tool rounds completed.");
      },
      prepareToolBatch: async ({ calls: prepared }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls: prepared }],
      executeToolCall: async ({ call: current }) => {
        executed.push(current.id);
        return {
          id: current.id,
          providerToolCallId: current.providerToolCallId!,
          name: current.name,
          argumentsHash: current.argumentsHash,
          status: "completed",
          output: { id: current.id },
        } satisfies DurableToolCallResult;
      },
      commitToolBatch: async ({ results }) => {
        commits.push(results.map((result) => result.id));
        return { status: "committed", toolCalls: results.length };
      },
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await handle.result();

    expect(modelSteps).toBe(3);
    expect(commits).toEqual([
      firstRound.map((current) => current.id),
      secondRound.map((current) => current.id),
    ]);
    expect(new Set(executed.slice(0, firstRound.length))).toEqual(new Set(firstRound.map((current) => current.id)));
    expect(new Set(executed.slice(firstRound.length))).toEqual(new Set(secondRound.map((current) => current.id)));
  }, 30_000);

  it("keeps mixed typed call outcomes in one durable join and continues the model turn", async () => {
    const taskQueue = `agent-tool-failure-matrix-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls = [
      call("matrix-success"),
      call("matrix-timeout"),
      call("matrix-unauthorized"),
      call("matrix-rate-limit"),
      call("matrix-unknown"),
    ];
    let modelSteps = 0;
    let committed: DurableToolCallResult[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1 ? pendingBatchResult(calls) : completedResult("The mixed batch was reported.");
      },
      prepareToolBatch: async ({ calls: prepared }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls: prepared }],
      executeToolCall: async ({ call: current }) => {
        const base = {
          id: current.id,
          providerToolCallId: current.providerToolCallId!,
          name: current.name,
          argumentsHash: current.argumentsHash,
        };
        if (current.id === "matrix-timeout") return { ...base, status: "failed", failureClass: "terminal", error: { code: "TOOL_TIMEOUT", message: "The tool timed out" } } satisfies DurableToolCallResult;
        if (current.id === "matrix-unauthorized") return { ...base, status: "blocked", failureClass: "blocked", error: { code: "TOOL_NOT_GRANTED", message: "The capability is not granted" } } satisfies DurableToolCallResult;
        if (current.id === "matrix-rate-limit") return { ...base, status: "failed", failureClass: "retryable", error: { code: "PROVIDER_RATE_LIMIT", message: "The provider rate limit was reached" } } satisfies DurableToolCallResult;
        if (current.id === "matrix-unknown") return { ...base, status: "unknown", failureClass: "unknown", error: { code: "PROVIDER_OUTCOME_UNKNOWN", message: "The provider outcome is unknown" } } satisfies DurableToolCallResult;
        return { ...base, status: "completed", output: { ok: true } } satisfies DurableToolCallResult;
      },
      commitToolBatch: async ({ results }) => {
        committed = results;
        return { status: "committed", toolCalls: results.length };
      },
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await handle.result();

    expect(modelSteps).toBe(2);
    expect(committed.map((result) => result.id)).toEqual(calls.map((current) => current.id));
    expect(new Map(committed.map((result) => [result.id, result.status]))).toEqual(new Map([
      ["matrix-success", "completed"],
      ["matrix-timeout", "failed"],
      ["matrix-unauthorized", "blocked"],
      ["matrix-rate-limit", "failed"],
      ["matrix-unknown", "unknown"],
    ]));
  }, 30_000);

  it("replays the decomposed Workflow history without a command-sequence violation", async () => {
    const taskQueue = `agent-tool-replay-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const toolCall = call("runtime-replay");
    let modelSteps = 0;
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1 ? pendingResult(toolCall) : completedResult("Replayable execution completed.");
      },
      prepareToolBatch: async ({ calls }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls }],
      executeToolCall: async ({ call: current }) => ({
        id: current.id,
        providerToolCallId: current.providerToolCallId!,
        name: current.name,
        argumentsHash: current.argumentsHash,
        status: "completed",
        output: { ok: true },
      } satisfies DurableToolCallResult),
      commitToolBatch: async ({ results }) => ({ status: "committed", toolCalls: results.length }),
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });
    await handle.result();

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url).pathname }, history, workflowId);
    expect(modelSteps).toBe(2);
  }, 30_000);

  it("cancels an in-flight tool Activity when the run receives an application cancellation", async () => {
    const taskQueue = `agent-tool-cancel-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const toolCall = call("runtime-cancel");
    let modelSteps = 0;
    let toolStarted = false;
    let toolCancelled = false;
    let resolveToolStarted: (() => void) | undefined;
    let resolveToolCancelled: (() => void) | undefined;
    const toolStartedPromise = new Promise<void>((resolve) => { resolveToolStarted = resolve; });
    const toolCancelledPromise = new Promise<void>((resolve) => { resolveToolCancelled = resolve; });
    const transitions: string[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { transitions.push(nextStatus); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async () => {
        modelSteps += 1;
        return modelSteps === 1 ? pendingResult(toolCall) : completedResult("The tool run was cancelled.");
      },
      prepareToolBatch: async ({ calls }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls }],
      executeToolCall: async () => {
        toolStarted = true;
        resolveToolStarted?.();
        const signal = activityCancellationSignal();
        heartbeat({ phase: "test.tool.running" });
        const heartbeatTimer = setInterval(() => heartbeat({ phase: "test.tool.running" }), 100);
        try {
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              toolCancelled = true;
              resolveToolCancelled?.();
              reject(new Error("tool Activity cancelled"));
              return;
            }
            signal.addEventListener("abort", () => {
              toolCancelled = true;
              resolveToolCancelled?.();
              reject(new Error("tool Activity cancelled"));
            }, { once: true });
          });
        } finally {
          clearInterval(heartbeatTimer);
        }
      },
      commitToolBatch: async () => ({ status: "committed", toolCalls: 1 }),
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => { transitions.push("complete"); },
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async () => { transitions.push("failed"); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await Promise.race([
      toolStartedPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tool Activity did not start")), 10_000)),
    ]);
    await handle.signal(cancellationSignal, { reason: "operator stopped the run" });
    await Promise.race([
      toolCancelledPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tool Activity did not observe cancellation")), 10_000)),
    ]);
    await handle.result();

    expect(toolStarted).toBe(true);
    expect(toolCancelled).toBe(true);
    expect(transitions).toContain("cancelled");
    expect(transitions).not.toContain("failed");
    expect(transitions).not.toContain("complete");
  }, 30_000);

  it("continues as new at a settled batch boundary before a long autonomous run exhausts history", async () => {
    const taskQueue = `agent-tool-history-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    // A single run crosses the 2,000-event guard with a small number of
    // realistic multi-tool rounds. This proves rollover without turning into
    // a throughput benchmark.
    const totalRounds = 2;
    const callsPerRound = 64;
    let modelSteps = 0;
    let committedCalls = 0;
    const committedIds: string[] = [];
    const observedLoopSteps: number[] = [];
    const activities: AgentRunActivities = {
      transitionRun: async () => undefined,
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => { throw new Error("legacy executeLoop must not run for a new execution"); },
      executeModelStep: async ({ loopStep }) => {
        modelSteps += 1;
        observedLoopSteps.push(loopStep ?? -1);
        if (modelSteps > totalRounds) return completedResult("The long run completed after history rollover.");
        const calls = Array.from({ length: callsPerRound }, (_, index) => call(`runtime-${modelSteps}-${index + 1}`));
        return {
          status: "limited",
          checkpointed: true,
          toolBatchPending: true,
          pendingToolCalls: calls,
          messages: [{
            role: "assistant",
            content: "",
            toolCalls: calls.map((current) => ({
              id: current.providerToolCallId ?? current.id,
              runtimeOperationId: current.id,
              name: current.name,
              arguments: current.arguments,
            })),
          }],
          usage,
          iterations: 1,
          toolCalls: 0,
        };
      },
      prepareToolBatch: async ({ calls }) => [{ kind: "parallel", segmentId: "batch:segment:1", calls }],
      executeToolCall: async ({ call: current }) => ({
        id: current.id,
        providerToolCallId: current.providerToolCallId!,
        name: current.name,
        argumentsHash: current.argumentsHash,
        status: "completed",
        output: { ok: true },
      } satisfies DurableToolCallResult),
      commitToolBatch: async ({ results }) => {
        committedCalls += results.length;
        committedIds.push(...results.map((result) => result.id));
        return { status: "committed", toolCalls: results.length };
      },
      pauseRun: async () => undefined,
      deliverApprovalPrompt: async () => undefined,
      cancelPendingApproval: async () => undefined,
      cancelHandoff: async () => undefined,
      completeRun: async () => undefined,
      generateConversationTitle: async () => undefined,
      deliverRunReply: async () => undefined,
      failRun: async ({ error }) => { throw new Error(String(error.message ?? "workflow failed")); },
    };
    const client = await startWorker(taskQueue, activities);
    const handle = await client.workflow.start(agentRunWorkflow, {
      taskQueue,
      workflowId,
      args: [{ runId: workflowId, continueAsNewHistoryThreshold: 10 }],
    });

    await handle.result();

    const firstExecution = await client.workflow.getHandle(workflowId, handle.firstExecutionRunId).describe();
    expect(firstExecution.status.name, `historyLength=${firstExecution.historyLength}; loopSteps=${observedLoopSteps.join(",")}`).toBe("CONTINUED_AS_NEW");
    expect(committedCalls).toBe(totalRounds * callsPerRound);
    expect(committedIds).toEqual(Array.from({ length: totalRounds * callsPerRound }, (_, index) => `runtime-${Math.floor(index / callsPerRound) + 1}-${(index % callsPerRound) + 1}`));
    expect(new Set(committedIds).size).toBe(committedIds.length);
    expect(modelSteps).toBe(totalRounds + 1);
  }, 60_000);
});
