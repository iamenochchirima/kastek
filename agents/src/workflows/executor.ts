import { validateWorkflowState, type WorkflowGraph } from "./graph";
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
  limits?: GraphExecutionLimits;
  checkpoint?: (input: {
    nodeId: string;
    nextNodeId?: string;
    status: "completed" | "paused" | "failed";
    state: Record<string, unknown>;
    output?: unknown;
    trace: GraphExecutionResult["trace"];
    usage: GraphExecutionUsage;
    idempotencyKey: string;
  }) => Promise<void>;
}

export interface GraphExecutionLimits {
  maxSteps?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxEstimatedCostUsd?: number;
  maxWallTimeMs?: number;
}

export interface GraphExecutionUsage {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface GraphExecutionResult {
  status: "completed" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "failed";
  state: Record<string, unknown>;
  trace: Array<{ nodeId: string; type: string; status: string }>;
  pausedAt?: string;
  pendingToolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown>; argumentsHash: string }>;
  waitingFor?: string;
  error?: string;
  usage: GraphExecutionUsage;
}

interface GraphExecutionContext {
  usage: GraphExecutionUsage;
  startedAt: number;
  edgeIterations: Map<number, number>;
  nodeIterations: Map<string, number>;
  steps: number;
  maxSteps: number;
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
  context?: GraphExecutionContext,
): Promise<GraphExecutionResult> {
  const state = structuredClone(initialState);
  const trace: GraphExecutionResult["trace"] = [];
  const execution = context ?? {
    usage: emptyGraphUsage(),
    startedAt: Date.now(),
    edgeIterations: new Map<number, number>(),
    nodeIterations: new Map<string, number>(),
    steps: 0,
    maxSteps: boundedLimit(dependencies.limits?.maxSteps, 2_000),
  } satisfies GraphExecutionContext;
  const { usage } = execution;
  let current = graph.entryNodeId;
  try {
    validateWorkflowState(graph, state);
  } catch (error) {
    return { status: "failed", state, trace, usage, error: error instanceof Error ? error.message : "Workflow initial state is invalid" };
  }
  while (execution.steps < execution.maxSteps) {
    execution.steps += 1;
    const limitError = executionLimitError(usage, dependencies.limits, execution.startedAt);
    if (limitError) return { status: "failed", state, trace, usage, error: limitError };
    const node = graph.nodes.find((candidate) => candidate.id === current);
    if (!node) return { status: "failed", state, trace, usage, error: `Unknown node: ${current}` };
    const count = (execution.nodeIterations.get(node.id) ?? 0) + 1;
    execution.nodeIterations.set(node.id, count);
    if (node.maxIterations !== undefined && count > node.maxIterations) return { status: "failed", state, trace, usage, error: `Node iteration limit exceeded: ${node.id}` };
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
        consumeToolCall(usage, dependencies.limits);
        result = await dependencies.tool({ name: node.config.toolName, arguments: (node.config.arguments ?? {}) as Record<string, unknown>, nodeId: node.id });
        addReportedUsage(usage, result);
        applyConfiguredWrites(state, node, result);
      } else if (node.type === "model") {
        if (!dependencies.model) throw new Error(`Model node is not configured: ${node.id}`);
        consumeModelCall(usage, dependencies.limits);
        result = await dependencies.model({ nodeId: node.id, config: node.config, state });
        addReportedUsage(usage, result);
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
            consumeToolCall(usage, dependencies.limits);
            result = await dependencies.tool({ name: toolName, arguments: toolArguments, nodeId: node.id, approved: resumed.approval });
            addReportedUsage(usage, result);
            applyConfiguredWrites(state, node, result);
          } else {
            const argumentsHash = createWorkflowArgumentsHash(toolArguments);
            trace.push({ nodeId: node.id, type: node.type, status: "awaiting_approval" });
            await checkpointNode(dependencies, node.id, node.id, "paused", state, undefined, trace, usage, count);
            return { status: "awaiting_approval", state, trace, usage, pausedAt: node.id, pendingToolCalls: [{ id: toolCallId, name: toolName, arguments: toolArguments, argumentsHash }] };
          }
        } else if (toolName) {
          throw new Error(`Approval node tool is not configured: ${node.id}`);
        }
        if (!toolName) {
          trace.push({ nodeId: node.id, type: node.type, status: "awaiting_approval" });
          await checkpointNode(dependencies, node.id, node.id, "paused", state, undefined, trace, usage, count);
          return { status: "awaiting_approval", state, trace, usage, pausedAt: node.id };
        }
      } else if (node.type === "wait") {
        const eventKey = typeof node.config.eventKey === "string" && node.config.eventKey.trim() ? node.config.eventKey : node.id;
        if (!dependencies.resumeExternalEvent || dependencies.resumeExternalEvent.key !== eventKey) {
          trace.push({ nodeId: node.id, type: node.type, status: "awaiting_external_event" });
          await checkpointNode(dependencies, node.id, node.id, "paused", state, undefined, trace, usage, count);
          return { status: "awaiting_external_event", state, trace, usage, pausedAt: node.id, waitingFor: eventKey };
        }
        result = dependencies.resumeExternalEvent.payload;
        applyConfiguredWrites(state, node, result);
      } else if (node.type === "handoff") {
        const handoffConfig = node.config ?? {};
        const handoffKey = typeof handoffConfig.handoffKey === "string" && handoffConfig.handoffKey.trim()
          ? handoffConfig.handoffKey.trim()
          : node.id;
        if (!dependencies.resumeExternalEvent || dependencies.resumeExternalEvent.key !== handoffKey) {
          trace.push({ nodeId: node.id, type: node.type, status: "awaiting_human" });
          await checkpointNode(dependencies, node.id, node.id, "paused", state, undefined, trace, usage, count);
          return { status: "awaiting_human", state, trace, usage, pausedAt: node.id, waitingFor: handoffKey };
        }
        result = dependencies.resumeExternalEvent.payload;
        applyConfiguredWrites(state, node, result);
      } else if (node.type === "fan_out" || node.type === "fan_in" || node.type === "route") {
        // Control-only nodes select edges below; fan-out branches are executed in later steps.
      }
      validateWorkflowState(graph, state);
      const postNodeLimitError = executionLimitError(usage, dependencies.limits, execution.startedAt);
      if (postNodeLimitError) return { status: "failed", state, trace, usage, error: postNodeLimitError };
      trace.push({ nodeId: node.id, type: node.type, status: "completed" });
      const outgoing = graph.edges
        .map((edge, index) => ({ edge, index }))
        .filter(({ edge }) => edge.from === node.id && edgeMatches(edge, state));
      const nextNodeId = node.type === "fan_out" ? undefined : outgoing[0]?.edge.to;
      await checkpointNode(dependencies, node.id, nextNodeId, "completed", state, result, trace, usage, count);
      if (!outgoing.length) return { status: "completed", state, trace, usage };
      if (node.type === "fan_out") {
        const branches = await Promise.all(outgoing.map(({ edge, index }) => {
          consumeEdgeIteration(edge, index, execution.edgeIterations);
          return executeWorkflowGraph({ ...graph, entryNodeId: edge.to }, state, dependencies, execution);
        }));
        const mergedState = structuredClone(state);
        const mergedPaths: Array<{ path: string; value: unknown }> = [];
        for (const branch of branches) {
          if (branch.status !== "completed") return { ...branch, trace: [...trace, ...branch.trace], usage };
          for (const path of changedStatePaths(state, branch.state)) {
            const value = getPath(branch.state, path);
            const conflict = mergedPaths.find((existing) => pathsOverlap(existing.path, path));
            if (conflict) {
              if (!deepEqual(conflict.value, value)) throw new Error(`Workflow fan-out has overlapping writes: ${conflict.path} and ${path}`);
              continue;
            }
            mergedPaths.push({ path, value });
            setPath(mergedState, path, value);
          }
          validateWorkflowState(graph, mergedState);
          trace.push(...branch.trace);
        }
        Object.assign(state, mergedState);
        return { status: "completed", state, trace, usage };
      }
      const next = outgoing[0]!;
      consumeEdgeIteration(next.edge, next.index, execution.edgeIterations);
      current = next.edge.to;
    } catch (error) {
      trace.push({ nodeId: node.id, type: node.type, status: "failed" });
      return { status: "failed", state, trace, usage, error: error instanceof Error ? error.message : "Workflow node failed" };
    }
  }
  return { status: "failed", state, trace, usage, error: "Workflow step limit exceeded" };
}

function createWorkflowArgumentsHash(argumentsValue: Record<string, unknown>): string {
  return hashToolArguments(argumentsValue);
}

function consumeEdgeIteration(edge: WorkflowGraph["edges"][number], index: number, iterations: Map<number, number>): void {
  const count = (iterations.get(index) ?? 0) + 1;
  iterations.set(index, count);
  if (edge.maxIterations !== undefined && count > edge.maxIterations) {
    throw new Error(`Edge iteration limit exceeded: ${edge.from} -> ${edge.to}`);
  }
}

async function checkpointNode(
  dependencies: GraphExecutorDependencies,
  nodeId: string,
  nextNodeId: string | undefined,
  status: "completed" | "paused" | "failed",
  state: Record<string, unknown>,
  output: unknown,
  trace: GraphExecutionResult["trace"],
  usage: GraphExecutionUsage,
  iteration: number,
): Promise<void> {
  await dependencies.checkpoint?.({
    nodeId,
    ...(nextNodeId ? { nextNodeId } : {}),
    status,
    state: structuredClone(state),
    ...(output === undefined ? {} : { output: structuredClone(output) }),
    trace: structuredClone(trace),
    usage: { ...usage },
    idempotencyKey: `workflow:${nodeId}:${iteration}:${status}`,
  });
}

function emptyGraphUsage(): GraphExecutionUsage {
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function executionLimitError(usage: GraphExecutionUsage, limits: GraphExecutionLimits | undefined, startedAt: number): string | undefined {
  if (!limits) return undefined;
  if (limits.maxModelCalls !== undefined && usage.modelCalls >= limits.maxModelCalls) return "Workflow execution limit exceeded: maxModelCalls";
  if (limits.maxToolCalls !== undefined && usage.toolCalls >= limits.maxToolCalls) return "Workflow execution limit exceeded: maxToolCalls";
  if (limits.maxTotalTokens !== undefined && usage.totalTokens >= limits.maxTotalTokens) return "Workflow execution limit exceeded: maxTotalTokens";
  if (limits.maxEstimatedCostUsd !== undefined && usage.estimatedCostUsd >= limits.maxEstimatedCostUsd) return "Workflow execution limit exceeded: maxEstimatedCostUsd";
  if (limits.maxWallTimeMs !== undefined && Date.now() - startedAt >= limits.maxWallTimeMs) return "Workflow execution limit exceeded: maxWallTimeMs";
  return undefined;
}

function consumeModelCall(usage: GraphExecutionUsage, limits: GraphExecutionLimits | undefined): void {
  if (limits?.maxModelCalls !== undefined && usage.modelCalls >= limits.maxModelCalls) {
    throw new Error("Workflow execution limit exceeded: maxModelCalls");
  }
  usage.modelCalls += 1;
}

function consumeToolCall(usage: GraphExecutionUsage, limits: GraphExecutionLimits | undefined): void {
  if (limits?.maxToolCalls !== undefined && usage.toolCalls >= limits.maxToolCalls) {
    throw new Error("Workflow execution limit exceeded: maxToolCalls");
  }
  usage.toolCalls += 1;
}

function addReportedUsage(usage: GraphExecutionUsage, result: unknown): void {
  if (!isRecord(result) || !isRecord(result.usage)) return;
  const reported = result.usage;
  const inputTokens = finiteNonNegative(reported.inputTokens);
  const outputTokens = finiteNonNegative(reported.outputTokens);
  const totalTokens = finiteNonNegative(reported.totalTokens) || inputTokens + outputTokens;
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.totalTokens += totalTokens;
  usage.estimatedCostUsd += finiteNonNegative(reported.estimatedCostUsd);
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function changedStatePaths(before: Record<string, unknown>, after: Record<string, unknown>, prefix = ""): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const previous = before[key];
    const next = after[key];
    if (isRecord(previous) && isRecord(next)) {
      changed.push(...changedStatePaths(previous, next, path));
    } else if (!deepEqual(previous, next)) {
      changed.push(path);
    }
  }
  return changed;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
