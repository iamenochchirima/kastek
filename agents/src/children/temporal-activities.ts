import type { Pool } from "pg";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { RunRepository } from "../db/repositories/run-repository";
import { executionScopeFromRun } from "../runtime/execution-scope";
import { createChildInvocationScope, type ChildInvocationScope } from "./contracts";
import {
  childErrorFrom,
  childOperationId,
  normalizeChildBudget,
  normalizeChildRetryPolicy,
  type ChildActivityExecutionInput,
  type ChildActivityOutcome,
  type ChildAdmissionActivities,
  type ChildAdmissionResult,
  type ChildActivationRequest,
  type ChildWorkflowActivities,
  type ChildWorkflowExecutor,
  type TemporalChildWorkflowOutcome,
} from "./temporal-activation";

export interface ChildWorkflowActivityOptions {
  executor?: ChildWorkflowExecutor;
}

async function admitChildInvocation(
  runs: RunRepository,
  input: { parentRunId: string; activation: ChildActivationRequest },
): Promise<ChildAdmissionResult> {
  const parent = await runs.getRuntimeRunById(input.parentRunId);
  if (!parent) return { status: "rejected", error: { code: "CHILD_PARENT_NOT_FOUND", message: "Parent run was not found" } };
  try {
    const parentScope = executionScopeFromRun(parent);
    const { scope, request } = createChildInvocationScope(parentScope, input.activation.request);
    return {
      status: "admitted",
      workflowInput: {
        scope,
        input: request.input,
        operationId: childOperationId(scope),
        budget: normalizeChildBudget(input.activation.budget),
        timeoutMs: boundedTimeout(input.activation.timeoutMs),
        retryPolicy: normalizeChildRetryPolicy(input.activation.retryPolicy),
      },
    };
  } catch (error) {
    return { status: "rejected", error: childErrorFrom(error, "CHILD_REQUEST_INVALID") };
  }
}

function boundedTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1_000), 3_600_000)
    : 60_000;
}

function activityHeartbeat(details: Record<string, unknown>): void {
  try {
    heartbeat(details);
  } catch {
    // Direct activity tests do not run inside a Temporal activity context.
  }
}

function currentActivitySignal(): AbortSignal {
  try {
    return cancellationSignal();
  } catch {
    return new AbortController().signal;
  }
}

function outcomePayload(outcome: TemporalChildWorkflowOutcome): Record<string, unknown> {
  return {
    status: outcome.status,
    operationId: outcome.lineage.operationId,
    invocationId: outcome.lineage.invocationId,
    childWorkflowId: outcome.lineage.childWorkflowId,
    childWorkflowRunId: outcome.lineage.childWorkflowRunId,
    attempts: outcome.lineage.attempts,
    errorCode: outcome.error?.code,
    hasPartialResult: outcome.partialOutput !== undefined,
    progressCount: outcome.progress?.length ?? 0,
  };
}

function progressPayload(input: {
  operationId: string;
  evidence: { sequence: number; phase: string; progress?: number; message?: string; hasPartialResult: boolean };
}): Record<string, unknown> {
  return {
    operationId: input.operationId,
    sequence: input.evidence.sequence,
    phase: input.evidence.phase,
    ...(input.evidence.progress === undefined ? {} : { progress: input.evidence.progress }),
    ...(input.evidence.message ? { message: input.evidence.message.slice(0, 500) } : {}),
    hasPartialResult: input.evidence.hasPartialResult,
  };
}

/**
 * Activities registered beside the normal agent activities. The executor is an
 * explicit host adapter: this module never calls a model/provider directly.
 */
export function createChildWorkflowActivities(
  pool: Pool,
  options: ChildWorkflowActivityOptions = {},
): ChildWorkflowActivities & ChildAdmissionActivities {
  const runs = new RunRepository(pool);
  return {
    async executeChild(input: ChildActivityExecutionInput): Promise<ChildActivityOutcome> {
      activityHeartbeat({
        event: "agent.child.activity.started",
        operationId: input.operationId,
        attempt: input.attempt,
      });
      if (!options.executor) {
        return {
          status: "failed",
          error: {
            code: "CHILD_EXECUTOR_NOT_CONFIGURED",
            message: "No child execution adapter is configured for this worker",
          },
          retryable: false,
        };
      }
      try {
        const result = await options.executor({ ...input, signal: currentActivitySignal() });
        activityHeartbeat({
          event: "agent.child.activity.completed",
          operationId: input.operationId,
          attempt: input.attempt,
          status: result.status,
        });
        return result;
      } catch (error) {
        const typed = childErrorFrom(error, "CHILD_ACTIVITY_FAILED");
        return {
          status: "failed",
          error: typed,
          retryable: typed.code === "WORKFLOW_ACTIVITY_FAILED" || typed.code === "CHILD_RETRYABLE",
        };
      }
    },

    async admitChildInvocation(input: { parentRunId: string; activation: ChildActivationRequest }): Promise<ChildAdmissionResult> {
      return admitChildInvocation(runs, input);
    },

    async recordChildProgress(input): Promise<void> {
      // Progress is diagnostic evidence. A disconnected observer or a stale
      // parent must never change the child outcome.
      try {
        await runs.appendEvent({
          organizationId: input.scope.organizationId,
          runId: input.scope.parentRunId,
          installationId: input.scope.installationId,
          eventType: `agent.child.${input.evidence.phase}`,
          operationId: input.operationId,
          payload: progressPayload(input),
        });
      } catch {
        // Best effort by design; Temporal remains the source of truth for outcome.
      }
    },

    async recordChildOutcome(input): Promise<void> {
      try {
        await runs.appendEvent({
          organizationId: input.scope.organizationId,
          runId: input.scope.parentRunId,
          installationId: input.scope.installationId,
          eventType: "agent.child.completed",
          operationId: input.operationId,
          payload: outcomePayload(input.outcome),
        });
      } catch {
        // Best effort by design; outcome remains available from the workflow result.
      }
    },
  };
}
