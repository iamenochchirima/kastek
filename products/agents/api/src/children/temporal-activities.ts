import type { Pool } from "pg";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { RunRepository } from "../db/repositories/run-repository";
import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
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
  toolGrants: ToolGrantRepository,
  installationGrants: InstallationGrantRepository,
  input: { parentRunId: string; activation: ChildActivationRequest },
): Promise<ChildAdmissionResult> {
  const parent = await runs.getRuntimeRunById(input.parentRunId);
  if (!parent) return { status: "rejected", error: { code: "CHILD_PARENT_NOT_FOUND", message: "Parent run was not found" } };
  try {
    const parentInstallationResources = await installationGrants.effective(parent.organization_id, parent.installation_id);
    const configuredParentTools = new Set(
      Array.isArray(parent.policy.allowedTools)
        ? parent.policy.allowedTools.filter((value): value is string => typeof value === "string")
        : [],
    );
    const parentGrantedTools = await toolGrants.effectiveTools(parent.organization_id, parent.agent_version_id, parent.installation_id);
    const parentScope = {
      ...executionScopeFromRun(parent),
      capabilityGrants: [...parentGrantedTools].filter((toolName) => configuredParentTools.has(toolName)),
      resourceGrants: parentInstallationResources.resources.map((resource) => `${resource.resourceType}:${resource.resourceId}`),
    };
    const { scope, request } = createChildInvocationScope(parentScope, input.activation.request);
    const childInstallation = await runs.findActiveChildInstallation({
      organizationId: parent.organization_id,
      parentInstallationId: parent.installation_id,
      agentDefinitionId: scope.childAgentDefinitionId,
      agentVersionId: scope.childAgentVersionId,
    });
    if (!childInstallation) {
      return { status: "rejected", error: { code: "CHILD_INSTALLATION_NOT_FOUND", message: "No active hosted installation exists for the requested child agent version" } };
    }
    const childCapabilities = await toolGrants.effectiveTools(parent.organization_id, scope.childAgentVersionId, childInstallation.id);
    const unavailableCapability = scope.capabilityGrants.find((capability) => !childCapabilities.has(capability));
    if (unavailableCapability) {
      return { status: "rejected", error: { code: "CHILD_CAPABILITY_NOT_AVAILABLE", message: `Child installation does not grant ${unavailableCapability}` } };
    }
    const childResources = await installationGrants.effective(parent.organization_id, childInstallation.id);
    const childResourceKeys = new Set(childResources.resources.map((resource) => `${resource.resourceType}:${resource.resourceId}`));
    const unavailableResource = scope.resourceGrants.find((resource) => !childResourceKeys.has(resource));
    if (unavailableResource) {
      return { status: "rejected", error: { code: "CHILD_RESOURCE_NOT_AVAILABLE", message: `Child installation does not grant ${unavailableResource}` } };
    }
    const childRun = await runs.createRun(parent.organization_id, parent.created_by, {
      installationId: childInstallation.id,
      triggerType: "manual",
      idempotencyKey: `child:${scope.invocationId}`,
      input: {
        message: typeof request.input === "string" ? request.input : JSON.stringify(request.input ?? null),
        childInvocation: {
          parentRunId: scope.parentRunId,
          invocationId: scope.invocationId,
          childAgentDefinitionId: scope.childAgentDefinitionId,
          childAgentVersionId: scope.childAgentVersionId,
          capabilityGrants: scope.capabilityGrants,
          resourceGrants: scope.resourceGrants,
        },
      },
    });
    return {
      status: "admitted",
      workflowInput: {
        scope,
        input: request.input,
        operationId: childOperationId(scope),
        childRunId: childRun.id,
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
  const toolGrants = new ToolGrantRepository(pool);
  const installationGrants = new InstallationGrantRepository(pool);
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
      return admitChildInvocation(runs, toolGrants, installationGrants, input);
    },

    async getChildRunOutcome(input): Promise<ChildActivityOutcome> {
      const child = await runs.getRuntimeRunById(input.childRunId);
      if (!child) return { status: "failed", error: { code: "CHILD_RUN_NOT_FOUND", message: "Child run was not found" } };
      if (
        child.organization_id !== input.scope.organizationId
        || child.agent_definition_id !== input.scope.childAgentDefinitionId
        || child.agent_version_id !== input.scope.childAgentVersionId
      ) {
        return { status: "failed", error: { code: "CHILD_RUN_SCOPE_MISMATCH", message: "Child run does not match the admitted child scope" } };
      }
      if (child.status === "completed") return { status: "succeeded", output: child.output ?? undefined, retryable: false };
      if (child.status === "cancelled") return { status: "cancelled", error: child.error ? childErrorFrom(child.error, "CHILD_CANCELLED") : undefined, retryable: false };
      if (child.status === "expired") return { status: "timed_out", error: child.error ? childErrorFrom(child.error, "CHILD_EXPIRED") : { code: "CHILD_EXPIRED", message: "Child run expired" }, retryable: false };
      if (child.status === "failed") return { status: "failed", error: child.error ? childErrorFrom(child.error, "CHILD_RUN_FAILED") : { code: "CHILD_RUN_FAILED", message: "Child run failed" }, retryable: false };
      return { status: "failed", error: { code: "CHILD_RUN_NOT_TERMINAL", message: `Child run ended in unexpected status ${child.status}` }, retryable: false };
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
