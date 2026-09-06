import type { HostCapabilityRouter } from "../hosts/capabilities";
import type { ToolInvocationRequest, ToolInvocationResult } from "../tools/types";
import { ToolRegistry } from "../tools/registry";
import { createCapabilityRuntime, type CapabilityRuntime } from "../capabilities/runtime";
import type { ExecutionScope } from "./execution-scope";
import { toolInvocationContextFromScope } from "../tools/types";
import {
  DefaultContextPolicy,
  type BuiltAgentContext,
  type ContextBuildInput,
  type ContextPolicy,
} from "./context";
import { runBoundedAgentLoop, type AgentLoopInput, type AgentLoopResult } from "./loop";
import { continuationFromLoopResult, type AgentHarnessContinuation } from "./continuation";

export type AgentHarnessRunStatus = "completed" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "limited" | "failed";

export type AgentHarnessOutcome =
  | { status: "completed"; output?: unknown }
  | { status: "awaiting_approval" | "awaiting_human" | "awaiting_external_event"; waitingFor?: string }
  | { status: "limited" | "failed"; code: string; message: string };

/** The narrow tool surface consumed by the model loop. */
export interface AgentToolSurface {
  get(name: string): ReturnType<ToolRegistry["get"]>;
  list(grantedTools?: ReadonlySet<string>): ReturnType<ToolRegistry["list"]>;
  invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult>;
}

export interface AgentHarness extends AgentToolSurface {
  readonly tools: ToolRegistry;
  readonly capabilities: CapabilityRuntime;
  readonly host: HostCapabilityRouter;
  readonly contextPolicy: ContextPolicy;
  context(scope: ExecutionScope, extras?: Parameters<typeof toolInvocationContextFromScope>[1]): ReturnType<typeof toolInvocationContextFromScope>;
  /** Build the one bounded model-facing projection for a turn. */
  buildContext(input: ContextBuildInput): BuiltAgentContext;
  /** Execute one bounded reasoning/tool turn through the shared runtime loop. */
  runTurn(input: Omit<AgentLoopInput, "tools">): Promise<AgentLoopResult>;
  /** Resume a persisted turn using the same loop contract and pinned dependencies. */
  resumeTurn(input: Omit<AgentLoopInput, "tools">): Promise<AgentLoopResult>;
  /** Translate a loop result into an explicit durable continuation decision. */
  continuation(result: AgentLoopResult): AgentHarnessContinuation;
}

export function createAgentHarness(input: {
  tools: ToolRegistry;
  host: HostCapabilityRouter;
  contextPolicy?: ContextPolicy;
  capabilities?: CapabilityRuntime;
}): AgentHarness {
  const contextPolicy = input.contextPolicy ?? new DefaultContextPolicy();
  const capabilities = input.capabilities ?? createCapabilityRuntime({ registry: input.tools });
  return {
    tools: input.tools,
    capabilities,
    host: input.host,
    contextPolicy,
    get: (name) => capabilities.get(name),
    list: (grantedTools) => capabilities.list(grantedTools),
    invoke: (request) => capabilities.invoke(request),
    context: (scope, extras) => toolInvocationContextFromScope(scope, extras),
    buildContext: (contextInput) => contextPolicy.build(contextInput),
    runTurn: (turnInput) => runBoundedAgentLoop({ ...turnInput, tools: input.tools }),
    resumeTurn: (turnInput) => runBoundedAgentLoop({ ...turnInput, tools: input.tools }),
    continuation: continuationFromLoopResult,
  };
}
