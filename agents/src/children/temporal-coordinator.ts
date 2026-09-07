import {
  Client,
  WorkflowExecutionAlreadyStartedError,
  type Workflow,
  type WorkflowHandle,
  type WorkflowHandleWithStartDetails,
  type WorkflowStartOptions,
} from "@temporalio/client";
import type { ExecutionScope } from "../runtime/execution-scope";
import type { AgentBudgetLedger } from "../runtime/budget";
import {
  childErrorFrom,
  childOperationId,
  childWorkflowId,
  normalizeChildBudget,
  normalizeChildRetryPolicy,
  type ChildRetryPolicy,
  type TemporalChildWorkflowInput,
  type TemporalChildWorkflowOutcome,
} from "./temporal-activation";
import {
  createChildInvocationScope,
  type ChildInvocationRequest,
  type ChildInvocationResult,
  type ChildInvocationScope,
} from "./contracts";
import type { ChildExecutionBudget } from "./execution-kernel";

export { childWorkflowId } from "./temporal-activation";
export type { TemporalChildWorkflowInput } from "./temporal-activation";

/** Durable evidence linking the parent admission to the child Temporal execution. */
export interface ChildInvocationEvidence {
  invocationId: string;
  idempotencyKey: string;
  workflowId: string;
  firstExecutionRunId?: string;
  startDisposition: "started" | "recovered";
  parent: {
    organizationId: string;
    installationId: string;
    runId: string;
    correlationId: string;
  };
  child: {
    agentDefinitionId: string;
    agentVersionId: string;
    capabilityGrants: string[];
    resourceGrants: string[];
  };
}

export type TemporalChildInvocationResult<TOutput = unknown> = ChildInvocationResult<TOutput> & {
  evidence: ChildInvocationEvidence;
};

/** Narrow handle surface needed by the coordinator and easy to fake in unit tests. */
export type TemporalChildWorkflowHandle<TOutput = unknown> = Pick<WorkflowHandle, "workflowId"> & {
  readonly firstExecutionRunId?: string;
  result(): Promise<TOutput>;
};

export type TemporalChildWorkflowStartOptions<TInput> = Omit<WorkflowStartOptions<Workflow>, "args"> & {
  args: [TInput];
};

/**
 * Client seam for durable child starts. Keeping this smaller than Client makes the
 * idempotency and lineage rules testable without a Temporal server.
 */
export interface TemporalChildWorkflowAdapter {
  start<TInput, TOutput>(
    workflowType: string,
    options: TemporalChildWorkflowStartOptions<TInput>,
  ): Promise<TemporalChildWorkflowHandle<TOutput>>;
  getHandle<TOutput>(workflowId: string): TemporalChildWorkflowHandle<TOutput>;
}

/** Adapt the real Temporal client to the coordinator's narrow, testable seam. */
export function createTemporalChildWorkflowAdapter(client: Client): TemporalChildWorkflowAdapter {
  return {
    async start<TInput, TOutput>(
      workflowType: string,
      options: TemporalChildWorkflowStartOptions<TInput>,
    ): Promise<TemporalChildWorkflowHandle<TOutput>> {
      const handle = await client.workflow.start(workflowType, options as WorkflowStartOptions<Workflow>);
      return handle as unknown as TemporalChildWorkflowHandle<TOutput>;
    },
    getHandle<TOutput>(workflowId: string): TemporalChildWorkflowHandle<TOutput> {
      return client.workflow.getHandle(workflowId) as unknown as TemporalChildWorkflowHandle<TOutput>;
    },
  };
}

export interface TemporalChildInvocationCoordinatorOptions {
  workflowType: string;
  taskQueue: string;
  budgetLedger?: AgentBudgetLedger;
  budget?: Partial<ChildExecutionBudget>;
  timeoutMs?: number;
  retryPolicy?: Partial<ChildRetryPolicy>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Child workflow failed";
}

function errorCode(error: unknown): string {
  return childErrorFrom(error).code;
}

function evidenceFor(
  scope: ChildInvocationScope,
  request: ChildInvocationRequest,
  workflowId: string,
  handle: TemporalChildWorkflowHandle<unknown> | undefined,
  startDisposition: ChildInvocationEvidence["startDisposition"],
): ChildInvocationEvidence {
  return {
    invocationId: scope.invocationId,
    idempotencyKey: request.idempotencyKey,
    workflowId,
    ...(handle?.firstExecutionRunId ? { firstExecutionRunId: handle.firstExecutionRunId } : {}),
    startDisposition,
    parent: {
      organizationId: scope.organizationId,
      installationId: scope.installationId,
      runId: scope.parentRunId,
      correlationId: scope.correlationId,
    },
    child: {
      agentDefinitionId: scope.childAgentDefinitionId,
      agentVersionId: scope.childAgentVersionId,
      capabilityGrants: [...scope.capabilityGrants],
      resourceGrants: [...scope.resourceGrants],
    },
  };
}

/**
 * Durable parent-to-child coordinator.
 *
 * The child workflow ID is derived from the existing invocation identity. Temporal
 * therefore provides the durable deduplication boundary: a retried parent activity
 * either gets the existing running/completed workflow or starts it once.
 */
export class TemporalChildInvocationCoordinator<TOutput = unknown> {
  constructor(
    private readonly adapter: TemporalChildWorkflowAdapter,
    private readonly options: TemporalChildInvocationCoordinatorOptions,
  ) {}

  async invoke(parent: ExecutionScope, input: unknown): Promise<TemporalChildInvocationResult<TOutput>> {
    const { scope, request } = createChildInvocationScope(parent, input);
    this.options.budgetLedger?.consume("child");
    const workflowId = childWorkflowId(scope.invocationId);
    const workflowInput: TemporalChildWorkflowInput = {
      scope,
      input: request.input,
      operationId: childOperationId(scope),
      budget: normalizeChildBudget(this.options.budget),
      timeoutMs: Math.min(Math.max(Math.trunc(this.options.timeoutMs ?? 60_000), 1_000), 3_600_000),
      retryPolicy: normalizeChildRetryPolicy(this.options.retryPolicy),
    };
    let handle: TemporalChildWorkflowHandle<TOutput> | undefined;
    let startDisposition: ChildInvocationEvidence["startDisposition"] = "started";

    try {
      try {
        handle = await this.adapter.start<TemporalChildWorkflowInput, TOutput>(this.options.workflowType, {
          workflowId,
          taskQueue: this.options.taskQueue,
          workflowIdConflictPolicy: "USE_EXISTING",
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          memo: {
            "kasitek.invocation_id": scope.invocationId,
            "kasitek.parent_run_id": scope.parentRunId,
            "kasitek.child_agent_version_id": scope.childAgentVersionId,
          },
          args: [workflowInput],
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        handle = this.adapter.getHandle<TOutput>(workflowId);
        startDisposition = "recovered";
      }

      const output = await handle.result();
      if (isTemporalChildWorkflowOutcome<TOutput>(output)) {
        return {
          ...output,
          invocationId: scope.invocationId,
          evidence: evidenceFor(scope, request, workflowId, handle, startDisposition),
        };
      }
      return {
        invocationId: scope.invocationId,
        status: "succeeded",
        output,
        evidence: evidenceFor(scope, request, workflowId, handle, startDisposition),
      };
    } catch (error) {
      const typed = childErrorFrom(error);
      return {
        invocationId: scope.invocationId,
        status: childStatusFromError(typed.code),
        ...(childStatusFromError(typed.code) === "timed_out" ? { termination: "timed_out" as const } : {}),
        ...(childStatusFromError(typed.code) === "cancelled" ? { termination: "cancelled" as const } : {}),
        error: { code: errorCode(error), message: errorMessage(error) },
        evidence: evidenceFor(scope, request, workflowId, handle, startDisposition),
      };
    }
  }
}

function isTemporalChildWorkflowOutcome<TOutput>(value: unknown): value is TemporalChildWorkflowOutcome<TOutput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TemporalChildWorkflowOutcome<TOutput>>;
  return ["succeeded", "failed", "cancelled", "timed_out", "partial"].includes(String(candidate.status))
    && Boolean(candidate.lineage && typeof candidate.lineage === "object");
}

function childStatusFromError(code: string): ChildInvocationResult["status"] {
  const normalized = code.toUpperCase();
  if (normalized.includes("CANCEL")) return "cancelled";
  if (normalized.includes("TIMEOUT") || normalized.includes("TIMED_OUT")) return "timed_out";
  return "failed";
}
