import type * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import type { CapabilityId } from "../../contracts/capabilities";
import type { MemoryFence, TaskOutcome } from "../../contracts/execution";
import type { ReportWorkflowOptions, ReportWorkflowPorts } from "../../workflows/report-delivery/program";

/** One operation call resolved from the registry instead of a central name branch. */
export interface CapabilityOperationCall {
  ctx: restate.WorkflowContext;
  pool: Pool;
  taskId: string;
  operationId: string;
  operation: string;
  arguments: unknown;
  signal?: AbortSignal;
}

/** Turn completion input for capabilities that deliver after the model finishes. */
export interface CapabilityTurnCall {
  ctx: restate.WorkflowContext;
  pool: Pool;
  taskId: string;
  outcome: TaskOutcome;
  options: ReportWorkflowOptions;
  memoryFence: MemoryFence | undefined;
  ports: ReportWorkflowPorts;
}

/**
 * A workflow-owned capability operation. Handlers are registered by composition; the business
 * loop only resolves a name and validates the shared prerequisites.
 */
export interface CapabilityOperationHandler {
  capability: CapabilityId;
  operations: readonly string[];
  confirm?(call: CapabilityOperationCall): Promise<TaskOutcome | undefined>;
  invoke?(call: CapabilityOperationCall): Promise<unknown>;
  afterTurn?(call: CapabilityTurnCall): Promise<TaskOutcome>;
}

export function handlerFor(handlers: readonly CapabilityOperationHandler[], operation: string): CapabilityOperationHandler | undefined {
  return handlers.find(handler => handler.operations.includes(operation));
}
