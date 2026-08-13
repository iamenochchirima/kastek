import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { RunStatus } from "../domain/types";
import type {
  AgentRunActivities,
  ApprovalSignal,
  CancellationSignal,
  DurableRunInput,
  ResumeApprovedToolCall,
} from "./contracts";

const activities = proxyActivities<AgentRunActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

export const approvalSignal = defineSignal<[ApprovalSignal]>("agent.approval");
export const cancellationSignal = defineSignal<[CancellationSignal]>("agent.cancel");
export const runStatusQuery = defineQuery<RunStatus>("agent.status");

/**
 * One workflow owns one run. Approval and cancellation are signals so the worker can
 * disappear while a run waits and another worker can resume the exact durable state.
 */
export async function agentRunWorkflow(input: DurableRunInput): Promise<void> {
  let status: RunStatus = "received";
  let approval: ApprovalSignal | undefined;
  let cancellation: CancellationSignal | undefined;
  setHandler(runStatusQuery, () => status);
  setHandler(approvalSignal, (value) => {
    approval = value;
  });
  setHandler(cancellationSignal, (value) => {
    cancellation = value;
  });

  const transition = async (from: RunStatus, to: RunStatus): Promise<void> => {
    await activities.transitionRun({ runId: input.runId, expectedStatus: from, nextStatus: to });
    status = to;
  };

  try {
    await transition("received", "queued");
    await transition("queued", "running");
    let resumeApprovedToolCall: ResumeApprovedToolCall | undefined = input.resumeApprovedToolCall;

    while (true) {
      if (cancellation) {
        await transition("running", "cancelled");
        return;
      }
      const result = await activities.executeLoop({ runId: input.runId, resumeApprovedToolCall });
      resumeApprovedToolCall = undefined;
      // Temporal delivers signals between activity completions. This check makes a
      // cancellation received while a model/tool activity was in flight durable
      // before the workflow can accept another step or publish a completion.
      if (cancellation) {
        await transition("running", "cancelled");
        return;
      }
      if (result.status === "awaiting_approval") {
        await activities.pauseRun({
          runId: input.runId,
          status: "awaiting_approval",
          output: {
            status: result.status,
            pendingToolCalls: result.pendingToolCalls ?? [],
            usage: result.usage,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
          },
        });
        status = "awaiting_approval";
        await condition(() => approval !== undefined || cancellation !== undefined);
        if (cancellation) {
          await transition("awaiting_approval", "cancelled");
          return;
        }
        const pending = result.pendingToolCalls?.[0];
        const decision = approval;
        approval = undefined;
        if (!pending || !decision || decision.decision !== "approved" || decision.providerToolCallId !== pending.id || decision.argumentsHash !== pending.argumentsHash) {
          await activities.failRun({
            runId: input.runId,
            error: { code: "APPROVAL_REJECTED", message: "Approval was rejected or did not match the pending arguments" },
          });
          status = "failed";
          return;
        }
        await transition("awaiting_approval", "running");
        resumeApprovedToolCall = {
          id: pending.id,
          name: pending.name,
          arguments: pending.arguments,
          approval: {
            approvedBy: decision.approvedBy,
            argumentsHash: decision.argumentsHash,
            expiresAt: decision.expiresAt,
          },
        };
        continue;
      }
      if (result.status === "failed") {
        await activities.failRun({ runId: input.runId, error: result.error ?? { code: "AGENT_LOOP_FAILED", message: "Agent loop failed" } });
        status = "failed";
        return;
      }
      await activities.completeRun({
        runId: input.runId,
        output: {
          status: result.status,
          message: result.response?.message.content ?? "",
          usage: result.usage,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
        },
      });
      status = "completed";
      await activities.generateConversationTitle({ runId: input.runId });
      await activities.deliverRunReply({ runId: input.runId });
      return;
    }
  } catch (error) {
    await activities.failRun({
      runId: input.runId,
      error: {
        code: "WORKFLOW_ACTIVITY_FAILED",
        message: error instanceof Error ? error.message : "Unknown workflow failure",
      },
    });
    status = "failed";
    throw error;
  }
}
