import { randomUUID } from "node:crypto";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunWorkflow, approvalSignal } from "../src/temporal/workflows";
import type { AgentRunActivities, DurableAgentLoopResult } from "../src/temporal/contracts";

const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS;
const runIntegration = Boolean(temporalAddress && process.env.RUN_TEMPORAL_INTEGRATION_TESTS === "true");

type Checkpoint = "model" | "tool" | "approval" | "effect" | "completion";
type Position = "before" | "after";

const scenarios: Array<{ checkpoint: Checkpoint; position: Position }> = [
  { checkpoint: "model", position: "before" },
  { checkpoint: "model", position: "after" },
  { checkpoint: "tool", position: "before" },
  { checkpoint: "tool", position: "after" },
  { checkpoint: "approval", position: "after" },
  { checkpoint: "effect", position: "before" },
  { checkpoint: "effect", position: "after" },
  { checkpoint: "completion", position: "before" },
  { checkpoint: "completion", position: "after" },
];

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 };

function completedResult(message: string): DurableAgentLoopResult {
  return {
    status: "completed",
    messages: [],
    completionMessage: message,
    usage,
    iterations: 1,
    toolCalls: 0,
  };
}

function checkpointResult(checkpoint: Checkpoint): DurableAgentLoopResult {
  return {
    status: checkpoint === "approval" ? "awaiting_approval" : "limited",
    checkpointed: checkpoint !== "approval",
    messages: [{ role: "tool", name: `test.${checkpoint}`, toolCallId: `call-${checkpoint}`, content: "checkpointed" }],
    ...(checkpoint === "approval"
      ? {
          pendingToolCalls: [{
            id: "call-approval",
            name: "test.effect",
            arguments: { target: "one" },
            argumentsHash: "a".repeat(64),
          }],
        }
      : {}),
    usage,
    iterations: 1,
    toolCalls: checkpoint === "model" ? 0 : 1,
  };
}

describe.skipIf(!runIntegration)("Temporal activity worker-loss matrix (integration)", () => {
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

  it.each(scenarios)("recovers once when a worker is lost $position the $checkpoint checkpoint", async ({ checkpoint, position }) => {
    const connection = await NativeConnection.connect({ address: temporalAddress! });
    connections.push(connection);
    const taskQueue = `agent-worker-loss-${checkpoint}-${position}-${randomUUID()}`;
    const workflowId = `agent-run-${randomUUID()}`;
    const calls: string[] = [];
    let executions = 0;
    let completionCalls = 0;
    let firstWorker: Worker | undefined;

    const activities: AgentRunActivities = {
      transitionRun: async ({ nextStatus }) => { calls.push(`transition:${nextStatus}`); },
      waitForConversationTurn: async () => true,
      getContentPublishBatchStatus: async () => ({ status: "UNAVAILABLE" }),
      executeLoop: async () => {
        executions += 1;
        calls.push(`execute:${executions}`);

        if (checkpoint === "approval" && executions === 1) {
          calls.push("checkpoint:approval");
          return checkpointResult(checkpoint);
        }
        if (checkpoint !== "completion" && executions === 1 && position === "before") {
          calls.push(`checkpoint:${checkpoint}:before`);
          firstWorker?.shutdown();
          throw new Error(`synthetic worker loss before ${checkpoint} checkpoint`);
        }
        if (checkpoint !== "completion" && executions === 1 && position === "after") {
          calls.push(`checkpoint:${checkpoint}:after`);
          firstWorker?.shutdown();
          return checkpointResult(checkpoint);
        }
        if (checkpoint === "completion" && executions === 1 && position === "before") {
          calls.push("checkpoint:completion:before");
          firstWorker?.shutdown();
        }
        return completedResult("The recovered activity completed.");
      },
      pauseRun: async ({ status }) => { calls.push(`pause:${status}`); },
      deliverApprovalPrompt: async () => { calls.push("approval-prompt"); },
      cancelPendingApproval: async () => { calls.push("cancel-approval"); },
      cancelHandoff: async () => { calls.push("cancel-handoff"); },
      completeRun: async () => {
        completionCalls += 1;
        calls.push(`complete:${completionCalls}`);
        if (checkpoint === "completion" && position === "after" && completionCalls === 1) firstWorker?.shutdown();
      },
      generateConversationTitle: async () => { calls.push("title"); },
      deliverRunReply: async () => { calls.push("deliver"); },
      failRun: async ({ error }) => { calls.push(`failed:${String(error.code ?? "unknown")}`); },
    };

    const startWorker = async (): Promise<Worker> => {
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

    const replaceWorker = async (worker: Worker): Promise<void> => {
      if (worker.getState() === "INITIALIZED" || worker.getState() === "RUNNING") worker.shutdown();
      const workerIndex = workers.indexOf(worker);
      if (workerIndex >= 0) workers.splice(workerIndex, 1);
      await startWorker();
    };

    firstWorker = await startWorker();
    const client = new Client({ connection, namespace: "default" });
    const handle = await client.workflow.start(agentRunWorkflow, { taskQueue, workflowId, args: [{ runId: workflowId }] });

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`workflow did not reach ${checkpoint}/${position} checkpoint`)), 10_000);
      const timer = setInterval(() => {
        if (calls.some((call) => call === `checkpoint:${checkpoint}:${position}` || call === "checkpoint:approval") || calls.includes(`complete:1`)) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });

    await replaceWorker(firstWorker);
    firstWorker = undefined;

    if (checkpoint === "approval") {
      await handle.signal(approvalSignal, {
        decision: "approved",
        approvedBy: "approver",
        argumentsHash: "a".repeat(64),
        providerToolCallId: "call-approval",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }

    await handle.result();
    if (checkpoint === "completion") expect(executions).toBe(1);
    else expect(executions).toBeGreaterThanOrEqual(2);
    expect(completionCalls).toBe(1);
    expect(calls).toContain("title");
    expect(calls).toContain("deliver");
    expect(calls.some((call) => call.startsWith("failed:"))).toBe(false);
  }, 45_000);
});
