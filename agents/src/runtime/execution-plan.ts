import type { ModelCredentials, ModelRequest } from "../model/types";
import type { ModelGateway } from "../model/gateway";
import type { ToolInvocationContext, ToolDefinition } from "../tools/types";
import type { AgentBudgetLedger } from "./budget";
import type { AgentLoopInput } from "./loop";
import type { ContextPlanningPolicy, ProviderContextProfile } from "./context-planning";
import type { MemoryRuntimeScope } from "./context-memory-boundary";
import type { EffectiveCapabilitySnapshot } from "./effective-capabilities";

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
  /** Effective snapshot shared by prompt, model schema admission, and evidence. */
  readonly capabilitySnapshot?: EffectiveCapabilitySnapshot;
  readonly contextProfile?: ProviderContextProfile;
  readonly contextCapabilityResolver?: AgentLoopInput["contextCapabilityResolver"];
  readonly recordContextCapabilityCorrection?: AgentLoopInput["recordContextCapabilityCorrection"];
  readonly requireContextCapability?: AgentLoopInput["requireContextCapability"];
  readonly streamModel?: AgentLoopInput["streamModel"];
  /** Durable run admission time used to separate queue delay from execution time. */
  readonly admittedAt?: AgentLoopInput["admittedAt"];
  readonly turnId?: AgentLoopInput["turnId"];
  readonly memoryRetrievalPort?: AgentLoopInput["memoryRetrievalPort"];
  readonly memoryScope?: MemoryRuntimeScope;
  readonly memoryRetrievalQuery?: string;
  readonly memoryRetrievalReason?: string;
  readonly memoryMaxEvidenceTokens?: number;
  readonly memorySourceEventIds?: readonly string[];
  readonly memoryRetrievalPack?: AgentLoopInput["memoryRetrievalPack"];
  readonly memoryRetrievalPackBoundaryDigest?: AgentLoopInput["memoryRetrievalPackBoundaryDigest"];
  /** Durable compaction generation used to invalidate stale usage anchors. */
  readonly contextCompactionGeneration?: number;
  /** Canonical transcript head sequence used by this turn's model requests. */
  readonly contextSourceCursor?: number;
  /** Canonical transcript generation used by this turn's model requests. */
  readonly contextSourceGeneration?: number;
  /** Digest of the canonical active projection used by this turn's model requests. */
  readonly contextSourceProjectionDigest?: string;
  /** Digest of the canonical transcript head used by this turn's model requests. */
  readonly contextSourceHeadDigest?: string;
  readonly contextPlanningPolicy?: Partial<ContextPlanningPolicy>;
  readonly toolContext: ToolInvocationContext;
  readonly budgetLedger?: AgentBudgetLedger;
}

/** Turn-specific hooks and continuation input layered on a resolved plan. */
export type AgentHarnessTurnInput = Omit<AgentLoopInput, "tools" | keyof AgentExecutionPlan> & {
  plan: AgentExecutionPlan;
};
