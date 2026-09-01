import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { RunStatus } from "../domain/types";
import { sanitizeAssistantResponse } from "../runtime/context";
import { parseAgentResponse } from "../media/contracts";
import type {
  AgentRunActivities,
  ApprovalSignal,
  CancellationSignal,
  DurableRunInput,
  ExpirationSignal,
  ExternalEventSignal,
  ResumeApprovedToolCall,
} from "./contracts";

const activities = proxyActivities<AgentRunActivities>({
  scheduleToCloseTimeout: "15 minutes",
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "20 seconds",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

export const approvalSignal = defineSignal<[ApprovalSignal]>("agent.approval");
export const cancellationSignal = defineSignal<[CancellationSignal]>("agent.cancel");
export const expirationSignal = defineSignal<[ExpirationSignal]>("agent.expire");
export const externalEventSignal = defineSignal<[ExternalEventSignal]>("agent.external-event");
export const runStatusQuery = defineQuery<RunStatus>("agent.status");

/**
 * One workflow owns one run. Approval and cancellation are signals so the worker can
 * disappear while a run waits and another worker can resume the exact durable state.
 */
export async function agentRunWorkflow(input: DurableRunInput): Promise<void> {
  let status: RunStatus = "received";
  let approval: ApprovalSignal | undefined;
  let cancellation: CancellationSignal | undefined;
  let expiration: ExpirationSignal | undefined;
  let externalEvent: ExternalEventSignal | undefined;
  setHandler(runStatusQuery, () => status);
  setHandler(approvalSignal, (value) => {
    approval = value;
  });
  setHandler(cancellationSignal, (value) => {
    cancellation = value;
  });
  setHandler(expirationSignal, (value) => {
    expiration = value;
  });
  setHandler(externalEventSignal, (value) => {
    externalEvent = value;
  });
  const activityScope = () => ({
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
  });

  const transition = async (from: RunStatus, to: RunStatus): Promise<void> => {
    await activities.transitionRun({ ...activityScope(), runId: input.runId, expectedStatus: from, nextStatus: to });
    status = to;
  };

  try {
    await transition("received", "queued");
    await transition("queued", "running");
    let resumeApprovedToolCall: ResumeApprovedToolCall | undefined = input.resumeApprovedToolCall;
    let resumeExternalEvent: ExternalEventSignal | undefined = input.resumeExternalEvent;
    let loopStep = input.loopStep ?? 0;

    while (true) {
      if (cancellation) {
        await transition("running", "cancelled");
        return;
      }
      if (expiration) {
        await transition("running", "expired");
        return;
      }
      const result = await activities.executeLoop({ ...activityScope(), runId: input.runId, loopStep, resumeApprovedToolCall, resumeExternalEvent });
      resumeApprovedToolCall = undefined;
      resumeExternalEvent = undefined;
      // Temporal delivers signals between activity completions. This check makes a
      // cancellation received while a model/tool activity was in flight durable
      // before the workflow can accept another step or publish a completion.
      if (cancellation) {
        if (result.status === "awaiting_human") {
          await activities.cancelHandoff({ ...activityScope(), runId: input.runId, reason: (cancellation as CancellationSignal).reason });
        }
        await transition("running", "cancelled");
        return;
      }
      if (expiration) {
        await transition("running", "expired");
        return;
      }
      if (result.checkpointed) {
        // The activity completed one bounded model/tool slice and persisted its continuation.
        // Schedule the next slice without treating the internal checkpoint as a terminal limit.
        loopStep += 1;
        continue;
      }
      if (result.status === "awaiting_approval") {
        await activities.pauseRun({
          ...activityScope(),
          runId: input.runId,
          status: "awaiting_approval",
          output: {
            status: result.status,
            pendingToolCalls: result.pendingToolCalls ?? [],
            usage: result.usage,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            provenance: result.provenance ?? {},
          },
        });
        await activities.deliverApprovalPrompt({ ...activityScope(), runId: input.runId });
        status = "awaiting_approval";
        await condition(() => approval !== undefined || cancellation !== undefined || expiration !== undefined);
        const pending = result.pendingToolCalls?.[0];
        if (cancellation) {
          const cancellationReason = (cancellation as CancellationSignal).reason;
          if (pending) {
            await activities.cancelPendingApproval({
              ...activityScope(),
              runId: input.runId,
              providerToolCallId: pending.id,
              reason: cancellationReason,
            });
          }
          await transition("awaiting_approval", "cancelled");
          return;
        }
        if (expiration) {
          if (pending) {
            await activities.cancelPendingApproval({
              ...activityScope(),
              runId: input.runId,
              providerToolCallId: pending.id,
              reason: (expiration as ExpirationSignal).reason ?? "The approval expired before execution",
              outcome: "expired",
            });
          }
          await transition("awaiting_approval", "expired");
          return;
        }
        const decision = approval;
        approval = undefined;
        if (!pending || !decision || decision.decision !== "approved" || decision.providerToolCallId !== pending.id || decision.argumentsHash !== pending.argumentsHash) {
          await activities.failRun({
            ...activityScope(),
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
            resourceSnapshot: decision.resourceSnapshot,
          },
        };
        continue;
      }
      if (result.status === "awaiting_external_event") {
        await activities.pauseRun({ ...activityScope(), runId: input.runId, status: "awaiting_external_event", output: { status: result.status, waitingFor: result.waitingFor, usage: result.usage, iterations: result.iterations, toolCalls: result.toolCalls, provenance: result.provenance ?? {} } });
        status = "awaiting_external_event";
        await condition(() => externalEvent !== undefined || cancellation !== undefined || expiration !== undefined);
        if (cancellation) { await transition("awaiting_external_event", "cancelled"); return; }
        if (expiration) { await transition("awaiting_external_event", "expired"); return; }
        const event = externalEvent;
        externalEvent = undefined;
        if (!event) { await activities.failRun({ ...activityScope(), runId: input.runId, error: { code: "EXTERNAL_EVENT_MISSING", message: "External event signal was not available" } }); status = "failed"; return; }
        await transition("awaiting_external_event", "running");
        resumeExternalEvent = event;
        continue;
      }
      if (result.status === "awaiting_human") {
        await activities.pauseRun({ ...activityScope(), runId: input.runId, status: "awaiting_human", output: { status: result.status, waitingFor: result.waitingFor, usage: result.usage, iterations: result.iterations, toolCalls: result.toolCalls, provenance: result.provenance ?? {} } });
        status = "awaiting_human";
        await condition(() => externalEvent !== undefined || cancellation !== undefined || expiration !== undefined);
        if (cancellation) {
          await activities.cancelHandoff({ ...activityScope(), runId: input.runId, reason: (cancellation as CancellationSignal).reason });
          await transition("awaiting_human", "cancelled");
          return;
        }
        if (expiration) { await transition("awaiting_human", "expired"); return; }
        const event = externalEvent;
        externalEvent = undefined;
        if (!event) { await activities.failRun({ ...activityScope(), runId: input.runId, error: { code: "HANDOFF_EVENT_MISSING", message: "Handoff resolution was not available" } }); status = "failed"; return; }
        await transition("awaiting_human", "running");
        resumeExternalEvent = event;
        continue;
      }
      if (result.status === "failed") {
        const error = result.error ?? { code: "AGENT_LOOP_FAILED", message: "Agent loop failed" };
        await activities.failRun({
          ...activityScope(),
          runId: input.runId,
          error: error.userMessage
            ? error
            : {
              ...error,
              userMessage: "I couldn't complete that request. Please try again.",
            },
        });
        status = "failed";
        await activities.deliverRunReply({ ...activityScope(), runId: input.runId });
        return;
      }
      if (result.status === "limited") {
        const error = {
          code: "AGENT_LOOP_LIMITED",
          message: "The agent reached an execution limit before producing a final response",
          userMessage: "I couldn't finish that request within the current execution limit. Please try again.",
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          usage: result.usage,
        };
        await activities.failRun({
          ...activityScope(),
          runId: input.runId,
          error,
        });
        status = "failed";
        await activities.deliverRunReply({ ...activityScope(), runId: input.runId });
        return;
      }
      const response = result.completionResponse
        ? parseAgentResponse({ ...result.completionResponse, text: sanitizeAssistantResponse(result.completionResponse.text) })
        : parseAgentResponse({ text: sanitizeAssistantResponse(result.completionMessage ?? result.response?.message.content ?? "") });
      if (!response.text && !response.media.length) {
        await activities.failRun({
          ...activityScope(),
          runId: input.runId,
          error: {
            code: "EMPTY_ASSISTANT_RESPONSE",
            message: "The agent completed without producing assistant text",
          },
        });
        status = "failed";
        return;
      }
      await activities.completeRun({
        ...activityScope(),
        runId: input.runId,
        output: {
          status: result.status,
          message: response.text,
          response,
          usage: result.usage,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          provenance: result.provenance ?? {},
        },
      });
      status = "completed";
      await activities.generateConversationTitle({ ...activityScope(), runId: input.runId });
      await activities.deliverRunReply({ ...activityScope(), runId: input.runId });
      return;
    }
  } catch (error) {
    await activities.failRun({
      ...activityScope(),
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
