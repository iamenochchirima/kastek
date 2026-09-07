import {
  Client,
  WorkflowExecutionAlreadyStartedError,
  type Workflow,
  type WorkflowHandle,
  type WorkflowHandleWithStartDetails,
  type WorkflowStartOptions,
} from "@temporalio/client";
import type { ExecutionScope } from "../runtime/execution-scope";
import {
  createChildInvocationScope,
  type ChildInvocationRequest,
  type ChildInvocationResult,
  type ChildInvocationScope,
} from "./contracts";

/** Input envelope sent to the child workflow. The parent scope is never forwarded wholesale. */
export interface TemporalChildWorkflowInput {
  scope: ChildInvocationScope;
  input: unknown;
}

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
}

export function childWorkflowId(invocationId: string): string {
  return `agent-child-${invocationId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Child workflow failed";
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "CHILD_WORKFLOW_FAILED";
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
    const workflowId = childWorkflowId(scope.invocationId);
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
          args: [{ scope, input: request.input }],
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        handle = this.adapter.getHandle<TOutput>(workflowId);
        startDisposition = "recovered";
      }

      const output = await handle.result();
      return {
        invocationId: scope.invocationId,
        status: "succeeded",
        output,
        evidence: evidenceFor(scope, request, workflowId, handle, startDisposition),
      };
    } catch (error) {
      return {
        invocationId: scope.invocationId,
        status: "failed",
        error: { code: errorCode(error), message: errorMessage(error) },
        evidence: evidenceFor(scope, request, workflowId, handle, startDisposition),
      };
    }
  }
}
