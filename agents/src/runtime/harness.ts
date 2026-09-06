import type { HostCapabilityRouter } from "../hosts/capabilities";
import type { ToolInvocationRequest, ToolInvocationResult } from "../tools/types";
import { ToolRegistry } from "../tools/registry";
import type { ExecutionScope } from "./execution-scope";
import { toolInvocationContextFromScope } from "../tools/types";

export type AgentHarnessRunStatus = "completed" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "limited" | "failed";

export type AgentHarnessOutcome =
  | { status: "completed"; output?: unknown }
  | { status: "awaiting_approval" | "awaiting_human" | "awaiting_external_event"; waitingFor?: string }
  | { status: "limited" | "failed"; code: string; message: string };

/** The narrow tool surface consumed by the model loop. */
export interface AgentToolSurface {
  get(name: string): ReturnType<ToolRegistry["get"]>;
  invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult>;
}

export interface AgentHarness extends AgentToolSurface {
  readonly tools: ToolRegistry;
  readonly host: HostCapabilityRouter;
  context(scope: ExecutionScope, extras?: Parameters<typeof toolInvocationContextFromScope>[1]): ReturnType<typeof toolInvocationContextFromScope>;
}

export function createAgentHarness(input: {
  tools: ToolRegistry;
  host: HostCapabilityRouter;
}): AgentHarness {
  return {
    tools: input.tools,
    host: input.host,
    get: (name) => input.tools.get(name),
    invoke: (request) => input.tools.invoke(request),
    context: (scope, extras) => toolInvocationContextFromScope(scope, extras),
  };
}
