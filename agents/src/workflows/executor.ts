import type { WorkflowGraph } from "./graph";
import { hashToolArguments } from "../tools/registry";

export interface GraphToolRequest {
  name: string;
  arguments: Record<string, unknown>;
  nodeId: string;
  approved?: unknown;
}

export interface GraphExecutorDependencies {
  model?: (input: { nodeId: string; config: Record<string, unknown>; state: Record<string, unknown> }) => Promise<unknown>;
  agentLoop?: (input: { nodeId: string; config: Record<string, unknown>; state: Record<string, unknown> }) => Promise<unknown>;
  tool?: (input: GraphToolRequest) => Promise<unknown>;
  resumeApprovedToolCall?: { id: string; name: string; arguments: Record<string, unknown>; approval: unknown };
  resumeExternalEvent?: { key: string; payload: Record<string, unknown> };
}

export interface GraphExecutionResult {
  status: "completed" | "awaiting_approval" | "awaiting_external_event" | "failed";
  state: Record<string, unknown>;
  trace: Array<{ nodeId: string; type: string; status: string }>;
  pausedAt?: string;
  pendingToolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown>; argumentsHash: string }>;
  waitingFor?: string;
  error?: string;
}

function getPath(state: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, state);
}

function setPath(state: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  const leaf = parts.pop()!;
  let cursor = state;
  for (const part of parts) {
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[leaf] = value;
}

function edgeMatches(edge: WorkflowGraph["edges"][number], state: Record<string, unknown>): boolean {
  if (!edge.condition) return true;
  try {
    const condition = JSON.parse(edge.condition) as { path?: string; equals?: unknown; exists?: boolean };
    if (!condition.path) return false;
    const value = getPath(state, condition.path);
    if (condition.exists !== undefined) return (value !== undefined) === condition.exists;
    return JSON.stringify(value) === JSON.stringify(condition.equals);
  } catch {
    return false;
  }
}

function applyConfiguredWrites(state: Record<string, unknown>, node: WorkflowGraph["nodes"][number], result: unknown): void {
  if (node.writes.length === 1) setPath(state, node.writes[0]!, result);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    for (const key of node.writes) {
      if (Object.prototype.hasOwnProperty.call(result, key)) setPath(state, key, (result as Record<string, unknown>)[key]);
    }
  }
}

export async function executeWorkflowGraph(
  graph: WorkflowGraph,
  initialState: Record<string, unknown>,
  dependencies: GraphExecutorDependencies = {},
): Promise<GraphExecutionResult> {
  const state = structuredClone(initialState);
  const trace: GraphExecutionResult["trace"] = [];
  const iterations = new Map<string, number>();
  let current = graph.entryNodeId;
  for (let steps = 0; steps < 2_000; steps += 1) {
    const node = graph.nodes.find((candidate) => candidate.id === current);
    if (!node) return { status: "failed", state, trace, error: `Unknown node: ${current}` };
    const count = (iterations.get(node.id) ?? 0) + 1;
    iterations.set(node.id, count);
    if (node.maxIterations !== undefined && count > node.maxIterations) return { status: "failed", state, trace, error: `Node iteration limit exceeded: ${node.id}` };
    try {
      let result: unknown;
      if (node.type === "deterministic") {
        const operation = node.config.operation;
        if (operation === "set") {
          const path = node.config.path;
          if (typeof path !== "string") throw new Error(`Deterministic set node requires path: ${node.id}`);
          result = node.config.value;
          setPath(state, path, result);
        } else if (operation === "copy") {
          const from = node.config.from;
          const to = node.config.to;
          if (typeof from !== "string" || typeof to !== "string") throw new Error(`Deterministic copy node requires from/to: ${node.id}`);
          result = getPath(state, from);
          setPath(state, to, result);
        } else if (operation === "merge") {
          const values = node.config.value;
          if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`Deterministic merge node requires an object value: ${node.id}`);
          Object.assign(state, values);
          result = values;
        } else {
          result = node.config.value;
          applyConfiguredWrites(state, node, result);
        }
      } else if (node.type === "tool") {
        if (!dependencies.tool || typeof node.config.toolName !== "string") throw new Error(`Tool node is not configured: ${node.id}`);
        result = await dependencies.tool({ name: node.config.toolName, arguments: (node.config.arguments ?? {}) as Record<string, unknown>, nodeId: node.id });
        applyConfiguredWrites(state, node, result);
      } else if (node.type === "model") {
        if (!dependencies.model) throw new Error(`Model node is not configured: ${node.id}`);
        result = await dependencies.model({ nodeId: node.id, config: node.config, state });
        applyConfiguredWrites(state, node, result);
      } else if (node.type === "agent_loop") {
        if (!dependencies.agentLoop) throw new Error(`Agent-loop node is not configured: ${node.id}`);
        result = await dependencies.agentLoop({ nodeId: node.id, config: node.config, state });
        applyConfiguredWrites(state, node, result);
      } else if (node.type === "approval") {
        const approvalConfig = node.config ?? {};
        const toolName = typeof approvalConfig.toolName === "string" ? approvalConfig.toolName : undefined;
        const toolArguments = approvalConfig.arguments && typeof approvalConfig.arguments === "object" && !Array.isArray(approvalConfig.arguments)
          ? approvalConfig.arguments as Record<string, unknown>
          : {};
        if (toolName && dependencies.tool) {
          const toolCallId = typeof approvalConfig.toolCallId === "string" ? approvalConfig.toolCallId : `workflow:${node.id}`;
          const resumed = dependencies.resumeApprovedToolCall;
          if (resumed && resumed.id === toolCallId && resumed.name === toolName) {
            result = await dependencies.tool({ name: toolName, arguments: toolArguments, nodeId: node.id, approved: resumed.approval });
            applyConfiguredWrites(state, node, result);
          } else {
            const argumentsHash = createWorkflowArgumentsHash(toolArguments);
            trace.push({ nodeId: node.id, type: node.type, status: "awaiting_approval" });
            return { status: "awaiting_approval", state, trace, pausedAt: node.id, pendingToolCalls: [{ id: toolCallId, name: toolName, arguments: toolArguments, argumentsHash }] };
          }
        } else if (toolName) {
          throw new Error(`Approval node tool is not configured: ${node.id}`);
        }
        if (!toolName) {
          trace.push({ nodeId: node.id, type: node.type, status: "awaiting_approval" });
          return { status: "awaiting_approval", state, trace, pausedAt: node.id };
        }
      } else if (node.type === "wait") {
        const eventKey = typeof node.config.eventKey === "string" && node.config.eventKey.trim() ? node.config.eventKey : node.id;
        if (!dependencies.resumeExternalEvent || dependencies.resumeExternalEvent.key !== eventKey) {
          trace.push({ nodeId: node.id, type: node.type, status: "awaiting_external_event" });
          return { status: "awaiting_external_event", state, trace, pausedAt: node.id, waitingFor: eventKey };
        }
        result = dependencies.resumeExternalEvent.payload;
        applyConfiguredWrites(state, node, result);
      } else if (node.type === "fan_out" || node.type === "fan_in" || node.type === "route") {
        // Control-only nodes select edges below; fan-out branches are executed in later steps.
      }
      trace.push({ nodeId: node.id, type: node.type, status: "completed" });
      const outgoing = graph.edges.filter((edge) => edge.from === node.id && edgeMatches(edge, state));
      if (!outgoing.length) return { status: "completed", state, trace };
      if (node.type === "fan_out") {
        const branches = await Promise.all(outgoing.map((edge) => executeWorkflowGraph({ ...graph, entryNodeId: edge.to }, state, dependencies)));
        for (const branch of branches) {
          if (branch.status !== "completed") return { ...branch, trace: [...trace, ...branch.trace] };
          Object.assign(state, branch.state);
          trace.push(...branch.trace);
        }
        return { status: "completed", state, trace };
      }
      current = outgoing[0]!.to;
    } catch (error) {
      trace.push({ nodeId: node.id, type: node.type, status: "failed" });
      return { status: "failed", state, trace, error: error instanceof Error ? error.message : "Workflow node failed" };
    }
  }
  return { status: "failed", state, trace, error: "Workflow step limit exceeded" };
}

function createWorkflowArgumentsHash(argumentsValue: Record<string, unknown>): string {
  return hashToolArguments(argumentsValue);
}
