import {
  DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
  decomposedOperationKey,
  type DecomposedActivityKind,
  type DecomposedAgentRunActivities,
  type DecomposedApprovalWait,
  type DecomposedExternalEventWait,
} from "./decomposed-contracts";
import type { ActivityScope, ApprovalSignal, ExternalEventSignal } from "./contracts";

export interface DecomposedCoordinatorInput extends ActivityScope {
  runId: string;
  maxSteps?: number;
  activities: DecomposedAgentRunActivities;
  waitForApproval: (providerToolCallId: string) => Promise<DecomposedApprovalWait>;
  waitForExternalEvent: (waitingFor: string, status?: "awaiting_human" | "awaiting_external_event") => Promise<DecomposedExternalEventWait>;
  shouldStop?: () => "cancelled" | "expired" | undefined;
}

export interface DecomposedCoordinatorResult {
  status: "completed" | "failed" | "limited" | "unsupported" | "cancelled" | "expired";
  steps: number;
  errorCode?: string;
}

/**
 * Deterministic Temporal-side sequencing for the decomposed activity protocol.
 * It never reads the database, calls a provider, invokes a tool, or carries
 * prompt/output data. Those operations are represented by activity calls.
 */
export async function runDecomposedCoordinator(input: DecomposedCoordinatorInput): Promise<DecomposedCoordinatorResult> {
  const maxSteps = boundedSteps(input.maxSteps);
  const stoppedBeforeContext = input.shouldStop?.();
  if (stoppedBeforeContext) return { status: stoppedBeforeContext, steps: 0 };
  const context = await input.activities.buildLoopContext({
    ...scopeFor(input),
    protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
    runId: input.runId,
  });
  let stateRevision = context.stateRevision;
  if (context.nextPhase === "unsupported") return { status: "unsupported", steps: 0 };
  if (context.nextPhase === "completed") {
    await complete(input, stateRevision);
    return { status: "completed", steps: 0 };
  }
  if (context.nextPhase === "failed") return { status: "failed", steps: 0, errorCode: "CONTEXT_BUILD_FAILED" };

  let nextStep = context.nextStep ?? 0;
  let resumeExternalEvent: ExternalEventSignal | undefined;
  if (context.nextPhase === "awaiting_human" || context.nextPhase === "awaiting_external_event") {
    if (!context.waitingFor) return { status: "failed", steps: 0, errorCode: "DECOMPOSED_WAITING_KEY_MISSING" };
    resumeExternalEvent = (await input.waitForExternalEvent(context.waitingFor, context.nextPhase)).event;
  }
  if (context.pendingToolCallIds?.length) {
    const pendingToolStep = Math.max(0, nextStep - 1);
    const pending = await executeTools(input, pendingToolStep, stateRevision, context.pendingToolCallIds);
    stateRevision = pending.stateRevision;
    if (pending.status === "resumed") resumeExternalEvent = pending.event;
    else if (pending.terminal) {
      await complete(input, stateRevision);
      return { status: "completed", steps: 0 };
    }
    else if (pending.status !== "completed") return { status: pending.status, steps: 0, ...(pending.errorCode ? { errorCode: pending.errorCode } : {}) };
  }

  for (; nextStep < maxSteps; nextStep += 1) {
    const stopped = input.shouldStop?.();
    if (stopped) return { status: stopped, steps: nextStep };
    const modelIdentity = identity(input.runId, nextStep, "model");
    const model = await input.activities.executeModelStep({
      ...scopeFor(input),
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      ...modelIdentity,
      inputStateRevision: stateRevision,
      ...(resumeExternalEvent ? { resumeExternalEvent } : {}),
    });
    resumeExternalEvent = undefined;
    stateRevision = model.stateRevision;
    stateRevision = await checkpoint(input, nextStep, "model", stateRevision);
    const stoppedAfterModel = input.shouldStop?.();
    if (stoppedAfterModel) return { status: stoppedAfterModel, steps: nextStep + 1 };
    if (model.status === "failed") return { status: "failed", steps: nextStep + 1, ...(model.errorCode ? { errorCode: model.errorCode } : {}) };
    if (model.status === "completed") {
      stateRevision = await checkpoint(input, nextStep, "completed", stateRevision);
      await complete(input, stateRevision);
      return { status: "completed", steps: nextStep + 1 };
    }
    if (model.status === "awaiting_human" || model.status === "awaiting_external_event") {
      stateRevision = await checkpoint(input, nextStep, model.status, stateRevision);
      return { status: "failed", steps: nextStep + 1, errorCode: "DECOMPOSED_EXTERNAL_RESUME_NOT_WIRED" };
    }
    if (!model.toolCallIds?.length) return { status: "failed", steps: nextStep + 1, errorCode: "MODEL_TOOL_CALLS_MISSING" };
    const tools = await executeTools(input, nextStep, stateRevision, model.toolCallIds);
    stateRevision = tools.stateRevision;
    if (tools.status === "cancelled" || tools.status === "expired") return { status: tools.status, steps: nextStep + 1 };
    if (tools.status === "resumed") {
      resumeExternalEvent = tools.event;
      continue;
    }
    if (tools.terminal) {
      await complete(input, stateRevision);
      return { status: "completed", steps: nextStep + 1 };
    }
    if (tools.status !== "completed") return { status: tools.status, steps: nextStep + 1, ...(tools.errorCode ? { errorCode: tools.errorCode } : {}) };
  }
  return { status: "limited", steps: maxSteps, errorCode: "DECOMPOSED_STEP_LIMIT" };
}

async function executeTools(
  input: DecomposedCoordinatorInput,
  step: number,
  initialRevision: number,
  providerToolCallIds: string[],
): Promise<{ status: "completed" | "failed" | "cancelled" | "expired" | "resumed"; stateRevision: number; errorCode?: string; event?: ExternalEventSignal; terminal?: boolean }> {
  let stateRevision = initialRevision;
  for (const providerToolCallId of providerToolCallIds) {
    const stopped = input.shouldStop?.();
    if (stopped) return { status: stopped, stateRevision };
    const toolIdentity = identity(input.runId, step, "tool", providerToolCallId);
    let tool = await input.activities.executeToolStep({
      ...scopeFor(input),
      protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
      ...toolIdentity,
      providerToolCallId,
    });
    stateRevision = tool.stateRevision;
    stateRevision = await checkpoint(input, step, "tool", stateRevision, providerToolCallId);
    if (tool.status === "awaiting_approval") {
      const approval = await input.waitForApproval(providerToolCallId);
      tool = await input.activities.executeToolStep({
        ...scopeFor(input),
        protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
        ...toolIdentity,
        providerToolCallId,
        approval: {
          approvedBy: approval.decision.approvedBy,
          argumentsHash: approval.decision.argumentsHash,
          expiresAt: approval.decision.expiresAt,
          ...(approval.decision.resourceSnapshot ? { resourceSnapshot: approval.decision.resourceSnapshot } : {}),
        },
      });
      stateRevision = tool.stateRevision;
      stateRevision = await checkpoint(input, step, "tool", stateRevision, providerToolCallId);
    } else if (tool.status === "awaiting_human" || tool.status === "awaiting_external_event") {
      stateRevision = await checkpoint(input, step, tool.status, stateRevision, providerToolCallId);
      const resumed = await input.waitForExternalEvent(tool.waitingFor ?? providerToolCallId, tool.status);
      return { status: "resumed", stateRevision, event: resumed.event };
    }
    if (tool.status === "failed") return { status: "failed", stateRevision, ...(tool.errorCode ? { errorCode: tool.errorCode } : {}) };
    if (tool.status !== "completed") return { status: "failed", stateRevision, errorCode: "TOOL_RESUME_INCOMPLETE" };
    if (tool.terminal) return { status: "completed", stateRevision, terminal: true };
  }
  return { status: "completed", stateRevision };
}

function scopeFor(input: DecomposedCoordinatorInput): ActivityScope {
  return {
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
  };
}

async function checkpoint(
  input: DecomposedCoordinatorInput,
  step: number,
  phase: "model" | "tool" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "completed" | "failed",
  stateRevision: number,
  operationId?: string,
): Promise<number> {
  const result = await input.activities.checkpointLoop({
    ...scopeFor(input),
    protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
    runId: input.runId,
    step,
    operationKey: decomposedOperationKey({ runId: input.runId, step, kind: "checkpoint", operationId }),
    stateRevision,
    phase,
  });
  return result.stateRevision;
}

async function complete(input: DecomposedCoordinatorInput, stateRevision: number): Promise<void> {
  await input.activities.completeRunFromCheckpoint({
    ...scopeFor(input),
    protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
    runId: input.runId,
    stateRevision,
  });
}

function identity(runId: string, step: number, kind: DecomposedActivityKind, operationId?: string) {
  return { runId, step, operationKey: decomposedOperationKey({ runId, step, kind, operationId }) };
}

function boundedSteps(value: number | undefined): number {
  if (value === undefined) return 8;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("DECOMPOSED_MAX_STEPS_INVALID");
  return value;
}

export type DecomposedApprovalDecision = ApprovalSignal;
export type DecomposedExternalEvent = ExternalEventSignal;
