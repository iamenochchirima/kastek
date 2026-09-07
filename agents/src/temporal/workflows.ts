import {
  CancellationScope,
  ChildWorkflowCancellationType,
  condition,
  defineQuery,
  defineSignal,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { RunStatus } from "../domain/types";
import { sanitizeAssistantResponse } from "../runtime/sanitize";
import { parseAgentResponse } from "../media/contracts";
import { buildApprovedToolCompletionMessage } from "../runtime/approved-tool-completion";
import {
  childErrorFrom,
  childFailureIsRetryable,
  childRetryDelayMs,
  childWorkflowId,
  normalizeChildRetryPolicy,
  type ChildActivationRequest,
  type ChildAdmissionActivities,
  type ChildActivityOutcome,
  type ChildProgressEvidence,
  type ChildWorkflowActivities,
  type TemporalChildWorkflowInput,
  type TemporalChildWorkflowOutcome,
} from "../children/temporal-activation";
import type {
  AgentRunActivities,
  ApprovalSignal,
  CancellationSignal,
  ContentPublishBatchStatusActivityResult,
  DurableRunInput,
  ExpirationSignal,
  ExternalEventSignal,
  ResumeApprovedToolCall,
  SessionLeaseAdmission,
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

const childActivities = proxyActivities<ChildWorkflowActivities>({
  scheduleToCloseTimeout: "15 minutes",
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "20 seconds",
  retry: { maximumAttempts: 1 },
});

const childAdmissionActivities = proxyActivities<ChildAdmissionActivities>({
  scheduleToCloseTimeout: "2 minutes",
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "10 seconds",
    maximumAttempts: 3,
  },
});

const terminalBatchStatuses = new Set(["SUCCEEDED", "PARTIAL", "FAILED", "BLOCKED", "UNKNOWN"]);
const batchStatusPollInterval = "2 seconds";
const batchStatusPollLimit = 40;

async function observeBatchUntilTerminal(
  scope: { organizationId?: string; actorId?: string; runId: string },
  batchId: string,
): Promise<ContentPublishBatchStatusActivityResult> {
  const getStatus = activities.getContentPublishBatchStatus;
  if (!getStatus) return { status: "UNAVAILABLE" };
  let last: ContentPublishBatchStatusActivityResult = { status: "UNAVAILABLE" };
  for (let attempt = 0; attempt < batchStatusPollLimit; attempt += 1) {
    const observed = await getStatus({ ...scope, batchId });
    last = observed;
    if (observed.batch && terminalBatchStatuses.has(observed.status.toUpperCase())) return observed;
    if (attempt + 1 < batchStatusPollLimit) await sleep(batchStatusPollInterval);
  }
  return last;
}

function unconfirmedBatchMessage(title?: string): string {
  const target = title ? `“${title}”` : "the post";
  return `The batch publish for ${target} is still processing or could not be refreshed. I couldn't confirm the final destination results; ask me to check the batch status before retrying.`;
}

export const approvalSignal = defineSignal<[ApprovalSignal]>("agent.approval");
export const cancellationSignal = defineSignal<[CancellationSignal]>("agent.cancel");
export const expirationSignal = defineSignal<[ExpirationSignal]>("agent.expire");
export const externalEventSignal = defineSignal<[ExternalEventSignal]>("agent.external-event");
export const childInvocationSignal = defineSignal<[ChildActivationRequest]>("agent.child.invoke");
export const runStatusQuery = defineQuery<RunStatus>("agent.status");

const childProgressLimit = 256;
const childActivationBatchSize = 4;
const childActivationQueueLimit = 32;

function childEvidence(
  input: TemporalChildWorkflowInput,
  sequence: number,
  phase: ChildProgressEvidence["phase"],
  message?: string,
): ChildProgressEvidence {
  return {
    sequence,
    phase,
    invocationId: input.scope.invocationId,
    parentRunId: input.scope.parentRunId,
    childAgentDefinitionId: input.scope.childAgentDefinitionId,
    childAgentVersionId: input.scope.childAgentVersionId,
    depth: 1,
    occurredAt: new Date().toISOString(),
    ...(message ? { message: message.slice(0, 500) } : {}),
    hasPartialResult: false,
  };
}

function childLineage(input: TemporalChildWorkflowInput, attempts: number): TemporalChildWorkflowOutcome["lineage"] {
  const info = workflowInfo();
  return {
    operationId: input.operationId,
    invocationId: input.scope.invocationId,
    parentRunId: input.scope.parentRunId,
    parentCorrelationId: input.scope.correlationId,
    childAgentDefinitionId: input.scope.childAgentDefinitionId,
    childAgentVersionId: input.scope.childAgentVersionId,
    childWorkflowId: info.workflowId,
    childWorkflowRunId: info.runId,
    attempts,
  };
}

async function recordChildProgressBestEffort(input: TemporalChildWorkflowInput, evidence: ChildProgressEvidence): Promise<void> {
  try {
    await childActivities.recordChildProgress({ scope: input.scope, operationId: input.operationId, evidence });
  } catch {
    // Progress subscribers and journal availability must not alter execution outcome.
  }
}

async function executeChildActivityWithTimeout(input: TemporalChildWorkflowInput, attempt: number): Promise<{
  outcome?: Awaited<ReturnType<ChildWorkflowActivities["executeChild"]>>;
  error?: { code: string; message: string };
  timedOut: boolean;
  cancelled: boolean;
}> {
  const activityScope = new CancellationScope();
  const timeoutScope = new CancellationScope();
  let timedOut = false;
  const timer = timeoutScope.run(async () => {
    await sleep(input.timeoutMs);
    timedOut = true;
    activityScope.cancel();
  }).catch(() => undefined);
  try {
    const outcome = await activityScope.run(() => childActivities.executeChild({
      scope: input.scope,
      input: input.input,
      operationId: input.operationId,
      budget: input.budget,
      attempt,
      timeoutMs: input.timeoutMs,
    }));
    return { outcome, timedOut: false, cancelled: false };
  } catch (error) {
    return {
      error: childErrorFrom(error, timedOut ? "CHILD_TIMEOUT" : "CHILD_ACTIVITY_FAILED"),
      timedOut,
      cancelled: !timedOut && isCancellation(error),
    };
  } finally {
    timeoutScope.cancel();
    await timer;
  }
}

/**
 * A platform child is a normal durable agent run, nested under the parent's
 * workflow. The old activity adapter remains available for direct extension
 * tests and non-platform hosts, but the worker path never executes a child
 * agent through an unconfigured placeholder.
 */
async function executeNestedAgentRunWithTimeout(input: TemporalChildWorkflowInput): Promise<{
  outcome?: ChildActivityOutcome;
  error?: { code: string; message: string };
  timedOut: boolean;
  cancelled: boolean;
}> {
  if (!input.childRunId) {
    return {
      outcome: { status: "failed", error: { code: "CHILD_RUN_NOT_CONFIGURED", message: "The child activation did not create a durable child run" }, retryable: false },
      timedOut: false,
      cancelled: false,
    };
  }
  const getChildRunOutcome = (childActivities as unknown as {
    getChildRunOutcome: (input: { scope: TemporalChildWorkflowInput["scope"]; childRunId: string }) => Promise<ChildActivityOutcome>;
  }).getChildRunOutcome;
  const childScope = new CancellationScope();
  const timeoutScope = new CancellationScope();
  let timedOut = false;
  const timer = timeoutScope.run(async () => {
    await sleep(input.timeoutMs);
    timedOut = true;
    childScope.cancel();
  }).catch(() => undefined);
  try {
    await childScope.run(() => executeChild(agentRunWorkflow, {
      workflowId: `agent-run-${input.childRunId}`,
      args: [{
        runId: input.childRunId!,
        organizationId: input.scope.organizationId,
        actorId: `child:${input.scope.parentRunId}`,
      }],
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    }));
    const outcome = await getChildRunOutcome({ scope: input.scope, childRunId: input.childRunId });
    return { outcome, timedOut: false, cancelled: false };
  } catch (error) {
    return {
      error: childErrorFrom(error, timedOut ? "CHILD_TIMEOUT" : "CHILD_RUN_FAILED"),
      timedOut,
      cancelled: !timedOut && isCancellation(error),
    };
  } finally {
    timeoutScope.cancel();
    await timer;
  }
}

/** Durable child execution. It never calls a provider directly from workflow code. */
export async function agentChildWorkflow(input: TemporalChildWorkflowInput): Promise<TemporalChildWorkflowOutcome> {
  const retryPolicy = normalizeChildRetryPolicy(input.retryPolicy);
  const progress: ChildProgressEvidence[] = [];
  const appendProgress = async (evidence: ChildProgressEvidence): Promise<void> => {
    if (progress.length >= childProgressLimit) return;
    const normalized = { ...evidence, sequence: progress.length + 1 };
    progress.push(normalized);
    await recordChildProgressBestEffort(input, normalized);
  };
  let attempts = 0;
  let finalOutcome: TemporalChildWorkflowOutcome | undefined;

  await appendProgress(childEvidence(input, 0, "admitted"));
  while (attempts < retryPolicy.maximumAttempts) {
    attempts += 1;
    await appendProgress(childEvidence(input, 0, "started", `Child attempt ${attempts} started`));
    const execution = input.childRunId
      ? await executeNestedAgentRunWithTimeout(input)
      : await executeChildActivityWithTimeout(input, attempts);
    const activityOutcome = execution.outcome;
    if (activityOutcome?.progress) {
      for (const evidence of activityOutcome.progress.slice(0, childProgressLimit - progress.length)) {
        await appendProgress(evidence);
      }
    }

    const outcome: TemporalChildWorkflowOutcome = {
      ...(activityOutcome ?? {
        status: execution.timedOut ? "timed_out" : execution.cancelled ? "cancelled" : "failed",
        error: execution.error,
      }),
      ...(execution.error && !activityOutcome?.error ? { error: execution.error } : {}),
      progress,
      lineage: childLineage(input, attempts),
    };
    if (outcome.status === "succeeded" || outcome.status === "partial" || outcome.status === "cancelled" || outcome.status === "timed_out") {
      finalOutcome = outcome;
      break;
    }
    if (!childFailureIsRetryable(outcome, retryPolicy) || attempts >= retryPolicy.maximumAttempts) {
      finalOutcome = outcome;
      break;
    }
    await appendProgress(childEvidence(input, 0, "progress", `Retrying child after attempt ${attempts}`));
    await sleep(childRetryDelayMs(retryPolicy, attempts));
  }

  finalOutcome ??= {
    status: "failed",
    error: { code: "CHILD_RETRY_EXHAUSTED", message: "Child execution retry budget was exhausted" },
    progress,
    lineage: childLineage(input, attempts),
  };
  const terminalPhase: ChildProgressEvidence["phase"] = finalOutcome.status === "succeeded"
    ? "completed"
    : finalOutcome.status === "cancelled"
      ? "cancelled"
      : finalOutcome.status === "timed_out"
        ? "timed_out"
        : "failed";
  await appendProgress({
    ...childEvidence(input, 0, terminalPhase, finalOutcome.error?.message),
    hasPartialResult: finalOutcome.partialOutput !== undefined,
  });
  const completed: TemporalChildWorkflowOutcome = {
    ...finalOutcome,
    progress,
    lineage: childLineage(input, attempts),
  };
  try {
    await childActivities.recordChildOutcome({ scope: input.scope, operationId: input.operationId, outcome: completed });
  } catch {
    // The workflow result remains authoritative if journaling is unavailable.
  }
  return completed;
}

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
  let sessionLease: SessionLeaseAdmission | undefined;
  const pendingChildActivations: ChildActivationRequest[] = [];
  let cancelActiveChildren: (() => void) | undefined;
  setHandler(runStatusQuery, () => status);
  setHandler(approvalSignal, (value) => {
    approval = value;
  });
  setHandler(cancellationSignal, (value) => {
    cancellation = value;
    cancelActiveChildren?.();
  });
  setHandler(expirationSignal, (value) => {
    expiration = value;
    cancelActiveChildren?.();
  });
  setHandler(externalEventSignal, (value) => {
    externalEvent = value;
  });
  setHandler(childInvocationSignal, (value) => {
    if (pendingChildActivations.length < childActivationQueueLimit) pendingChildActivations.push(value);
  });
  const activityScope = () => ({
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(sessionLease ? { sessionLease } : {}),
  });

  const drainChildActivations = async (): Promise<void> => {
    while (pendingChildActivations.length > 0 && !cancellation && !expiration) {
      const batch = pendingChildActivations.splice(0, childActivationBatchSize);
      const admitted = await Promise.all(batch.map((activation) => childAdmissionActivities.admitChildInvocation({
        parentRunId: input.runId,
        activation,
      })));
      const runnable = admitted.filter((entry): entry is Extract<typeof entry, { status: "admitted" }> => entry.status === "admitted");
      if (runnable.length === 0) continue;

      const cancellationScope = new CancellationScope();
      cancelActiveChildren = () => cancellationScope.cancel();
      try {
        await cancellationScope.run(async () => {
          await Promise.all(runnable.map(async ({ workflowInput }) => {
            try {
              await executeChild(agentChildWorkflow, {
                workflowId: childWorkflowId(workflowInput.scope.invocationId),
                args: [workflowInput],
                cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
                parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
              });
            } catch (error) {
              const cancelled = isCancellation(error) || cancellation !== undefined;
              const outcome: TemporalChildWorkflowOutcome = {
                status: cancelled ? "cancelled" : "failed",
                ...(cancelled ? { termination: "cancelled" as const } : {}),
                error: childErrorFrom(error, cancelled ? "CHILD_PARENT_CANCELLED" : "CHILD_WORKFLOW_FAILED"),
                progress: [],
                lineage: {
                  operationId: workflowInput.operationId,
                  invocationId: workflowInput.scope.invocationId,
                  parentRunId: workflowInput.scope.parentRunId,
                  parentCorrelationId: workflowInput.scope.correlationId,
                  childAgentDefinitionId: workflowInput.scope.childAgentDefinitionId,
                  childAgentVersionId: workflowInput.scope.childAgentVersionId,
                  childWorkflowId: childWorkflowId(workflowInput.scope.invocationId),
                  attempts: 0,
                },
              };
              try {
                await childAdmissionActivities.recordChildOutcome({
                  scope: workflowInput.scope,
                  operationId: workflowInput.operationId,
                  outcome,
                });
              } catch {
                // Parent cancellation/failure must not be replaced by an evidence-write failure.
              }
            }
          }));
        });
      } finally {
        cancelActiveChildren = undefined;
      }
    }
  };

  const transition = async (from: RunStatus, to: RunStatus): Promise<void> => {
    await activities.transitionRun({ ...activityScope(), runId: input.runId, expectedStatus: from, nextStatus: to });
    status = to;
  };

  const failAndDeliver = async (error: Record<string, unknown>): Promise<void> => {
    await activities.failRun({
      ...activityScope(),
      runId: input.runId,
      error: {
        ...error,
        ...(typeof error.userMessage === "string" && error.userMessage.length > 0
          ? {}
          : { userMessage: "I couldn't complete that request. Please try again." }),
      },
    });
    status = "failed";
    await activities.deliverRunReply({ ...activityScope(), runId: input.runId });
  };

  try {
    await transition("received", "queued");
    const waitForConversationTurn = (activities as unknown as {
      waitForConversationTurn?: (input: { runId: string; organizationId?: string; actorId?: string }) => Promise<boolean | SessionLeaseAdmission>;
    }).waitForConversationTurn;
    if (waitForConversationTurn) {
      while (true) {
        const admission = await waitForConversationTurn({ ...activityScope(), runId: input.runId });
        const acquired = typeof admission === "boolean" ? admission : admission.acquired;
        if (acquired) {
          sessionLease = typeof admission === "boolean" ? undefined : admission;
          break;
        }
        // The workflow remains durable and does not hold an activity worker
        // while an earlier message in this session is still active.
        await sleep("1 second");
      }
    }
    await transition("queued", "running");
    let resumeApprovedToolCall: ResumeApprovedToolCall | undefined = input.resumeApprovedToolCall;
    let resumeExternalEvent: ExternalEventSignal | undefined = input.resumeExternalEvent;
    let loopStep = input.loopStep ?? 0;

    while (true) {
      await drainChildActivations();
      if (cancellation) {
        await transition("running", "cancelled");
        return;
      }
      if (expiration) {
        await transition("running", "expired");
        return;
      }
      const result = await activities.executeLoop({ ...activityScope(), runId: input.runId, loopStep, resumeApprovedToolCall, resumeExternalEvent, sessionLease });
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
      await drainChildActivations();
      if (cancellation) {
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
          await failAndDeliver({
            code: "APPROVAL_REJECTED",
            message: "Approval was rejected or did not match the pending arguments",
            userMessage: "I couldn't apply that approval because it no longer matches the pending action. Please try again.",
          });
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
        if (!event) { await failAndDeliver({ code: "EXTERNAL_EVENT_MISSING", message: "External event signal was not available" }); return; }
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
        if (!event) { await failAndDeliver({ code: "HANDOFF_EVENT_MISSING", message: "Handoff resolution was not available" }); return; }
        await transition("awaiting_human", "running");
        resumeExternalEvent = event;
        continue;
      }
      if (result.status === "failed") {
        const error = result.error ?? { code: "AGENT_LOOP_FAILED", message: "Agent loop failed" };
        await failAndDeliver(error);
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
        await failAndDeliver(error);
        return;
      }
      let completionOverride: string | undefined;
      if (result.pendingBatch) {
        const observed = await observeBatchUntilTerminal(
          { ...activityScope(), runId: input.runId },
          result.pendingBatch.batchId,
        );
        completionOverride = observed.batch
          ? buildApprovedToolCompletionMessage(
            result.pendingBatch.toolName,
            { batchId: result.pendingBatch.batchId },
            { post: result.pendingBatch.title ? { title: result.pendingBatch.title } : undefined, batch: observed.batch },
          )
          : unconfirmedBatchMessage(result.pendingBatch.title);
      }
      const response = completionOverride !== undefined
        ? parseAgentResponse({
          version: "1",
          text: sanitizeAssistantResponse(completionOverride),
          media: result.completionResponse?.media ?? [],
          ...(result.completionResponse?.ui ? { ui: result.completionResponse.ui } : {}),
        })
        : result.completionResponse
          ? parseAgentResponse({ ...result.completionResponse, text: sanitizeAssistantResponse(result.completionResponse.text) })
          : parseAgentResponse({ text: sanitizeAssistantResponse(result.completionMessage ?? result.response?.message.content ?? "") });
      if (!response.text && !response.media.length) {
        await failAndDeliver({
          code: "EMPTY_ASSISTANT_RESPONSE",
          message: "The agent completed without producing assistant text",
        });
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
    try {
      await failAndDeliver({
        code: "WORKFLOW_ACTIVITY_FAILED",
        message: error instanceof Error ? error.message : "Unknown workflow failure",
      });
    } catch {
      // Preserve the original workflow error so Temporal can retry the failed activity.
    }
    throw error;
  }
}
