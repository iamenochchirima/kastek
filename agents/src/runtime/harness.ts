import type { HostCapabilityRouter } from "../hosts/capabilities";
import type { ToolInvocationRequest, ToolInvocationResult } from "../tools/types";
import { ToolRegistry } from "../tools/registry";
import type { ExecutionScope } from "./execution-scope";
import { toolInvocationContextFromScope } from "../tools/types";
import {
  DefaultContextPolicy,
  type BuiltAgentContext,
  type ContextBuildInput,
  type ContextPolicy,
} from "./context";
import { runBoundedAgentLoop, type AgentLoopInput, type AgentLoopResult } from "./loop";

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
  readonly host: HostCapabilityRouter;
  readonly contextPolicy: ContextPolicy;
  context(scope: ExecutionScope, extras?: Parameters<typeof toolInvocationContextFromScope>[1]): ReturnType<typeof toolInvocationContextFromScope>;
  /** Build the one bounded model-facing projection for a turn. */
  buildContext(input: ContextBuildInput): BuiltAgentContext;
  /** Execute one bounded reasoning/tool turn through the shared runtime loop. */
  runTurn(input: Omit<AgentLoopInput, "tools">): Promise<AgentLoopResult>;
  /** Resume a persisted turn using the same loop contract and pinned dependencies. */
  resumeTurn(input: Omit<AgentLoopInput, "tools">): Promise<AgentLoopResult>;
}

export function createAgentHarness(input: {
  tools: ToolRegistry;
  host: HostCapabilityRouter;
  contextPolicy?: ContextPolicy;
}): AgentHarness {
  const contextPolicy = input.contextPolicy ?? new DefaultContextPolicy();
  return {
    tools: input.tools,
    host: input.host,
    contextPolicy,
    get: (name) => input.tools.get(name),
    list: (grantedTools) => input.tools.list(grantedTools),
    invoke: (request) => input.tools.invoke(request),
    context: (scope, extras) => toolInvocationContextFromScope(scope, extras),
    buildContext: (contextInput) => contextPolicy.build(contextInput),
    runTurn: (turnInput) => runBoundedAgentLoop({ ...turnInput, tools: input.tools }),
    resumeTurn: (turnInput) => runBoundedAgentLoop({ ...turnInput, tools: input.tools }),
  };
}
