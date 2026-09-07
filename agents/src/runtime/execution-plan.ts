import type { ModelCredentials, ModelRequest } from "../model/types";
import type { ModelGateway } from "../model/gateway";
import type { ToolInvocationContext, ToolDefinition } from "../tools/types";
import type { AgentBudgetLedger } from "./budget";
import type { AgentLoopInput } from "./loop";

/**
 * The resolved, run-pinned dependencies for one harness turn.
 *
 * Entry points may resolve this plan from their own durable records, but they
 * do not pass individual model or capability-policy fields into the harness.
 * This keeps ordinary turns and graph turns on the same execution contract.
 */
export interface AgentExecutionPlan {
  readonly model: Pick<ModelRequest, "provider" | "model" | "temperature" | "maxTokens">;
  readonly credentials: ModelCredentials;
  readonly fallbackModels?: AgentLoopInput["fallbackModels"];
  readonly gateway: ModelGateway;
  readonly grantedTools: ReadonlySet<string>;
  readonly modelTools?: Array<Omit<ToolDefinition, "handler">>;
  readonly modelContextTokens?: number;
  readonly toolContext: ToolInvocationContext;
  readonly budgetLedger?: AgentBudgetLedger;
}

/** Turn-specific hooks and continuation input layered on a resolved plan. */
export type AgentHarnessTurnInput = Omit<AgentLoopInput, "tools" | keyof AgentExecutionPlan> & {
  plan: AgentExecutionPlan;
};
