import { z } from "zod";

const nodeTypeSchema = z.enum(["deterministic", "model", "agent_loop", "tool", "route", "fan_out", "fan_in", "approval", "wait", "handoff"]);

const graphNodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(120),
  type: nodeTypeSchema,
  config: z.record(z.string(), z.unknown()).default({}),
  reads: z.array(z.string().min(1).max(120)).default([]),
  writes: z.array(z.string().min(1).max(120)).default([]),
  maxIterations: z.number().int().positive().max(100).optional(),
  parallelGroup: z.string().min(1).max(120).optional(),
});

const graphEdgeSchema = z.object({
  from: z.string().min(1).max(120),
  to: z.string().min(1).max(120),
  condition: z.string().max(2_000).optional(),
  maxIterations: z.number().int().positive().max(100).optional(),
});

export const workflowGraphSchema = z.object({
  version: z.literal(1),
  entryNodeId: z.string().min(1).max(120),
  nodes: z.array(graphNodeSchema).min(1).max(500),
  edges: z.array(graphEdgeSchema).max(2_000),
  stateSchema: z.record(z.string(), z.unknown()).default({}),
});

export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export interface GraphValidationResult {
  graph: WorkflowGraph;
  topologicalOrder: string[];
}

type StateSchemaDefinition = Record<string, unknown>;

export function validateWorkflowGraph(input: unknown): GraphValidationResult {
  const graph = workflowGraphSchema.parse(input);
  const nodeIds = new Set<string>();
  const nodes = new Map<string, WorkflowGraph["nodes"][number]>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Duplicate workflow node: ${node.id}`);
    nodeIds.add(node.id);
    nodes.set(node.id, node);
  }
  if (!nodes.has(graph.entryNodeId)) throw new Error(`Workflow entry node does not exist: ${graph.entryNodeId}`);
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error(`Workflow edge references an unknown node: ${edge.from} -> ${edge.to}`);
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }

  for (const node of graph.nodes) {
    if (node.parallelGroup) {
      const duplicateWrites = node.writes.filter((key, index) => node.writes.indexOf(key) !== index);
      if (duplicateWrites.length) throw new Error(`Workflow node repeats a parallel state key: ${node.id}`);
    }
    if (node.type === "fan_out" && !node.parallelGroup) throw new Error(`Fan-out node requires parallelGroup: ${node.id}`);
    if (node.type === "fan_out" || node.type === "fan_in" || node.type === "agent_loop") {
      throw new Error(`Workflow node type is not supported until durable execution semantics are implemented: ${node.type}`);
    }
  }
  const stack = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (stack.has(id)) {
      throw new Error(`Workflow cycles are not supported until durable execution semantics are implemented: ${id}`);
    }
    if (visited.has(id)) return;
    stack.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    stack.delete(id);
    visited.add(id);
    order.unshift(id);
  };
  visit(graph.entryNodeId);
  return { graph, topologicalOrder: order };
}

/** Validate the small JSON-Schema subset accepted for durable workflow state. */
export function validateWorkflowState(graph: WorkflowGraph, state: Record<string, unknown>): void {
  const raw = graph.stateSchema as StateSchemaDefinition;
  const standardSchema = isRecord(raw.properties) ? raw : undefined;
  const properties = standardSchema ? standardSchema.properties as StateSchemaDefinition : raw;
  const required = standardSchema && Array.isArray(standardSchema.required)
    ? standardSchema.required.filter((key): key is string => typeof key === "string")
    : [];
  const additionalProperties = standardSchema?.additionalProperties === false;
  if (additionalProperties) {
    for (const key of Object.keys(state)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw new Error(`Workflow state contains undeclared field: ${key}`);
      }
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) {
      throw new Error(`Workflow state is missing required field: ${key}`);
    }
  }
  for (const [key, descriptor] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
    validateWorkflowStateValue(state[key], descriptor, key);
  }
}

function validateWorkflowStateValue(value: unknown, descriptor: unknown, path: string): void {
  if (!isRecord(descriptor)) return;
  if (Array.isArray(descriptor.enum) && !descriptor.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    throw new Error(`Workflow state field ${path} is not one of the declared values`);
  }
  if (typeof descriptor.type === "string" && !matchesStateType(value, descriptor.type)) {
    throw new Error(`Workflow state field ${path} must be ${descriptor.type}`);
  }
  if (isRecord(descriptor.properties) && isRecord(value)) {
    const nestedGraph = { stateSchema: descriptor } as unknown as WorkflowGraph;
    validateWorkflowState(nestedGraph, value);
  }
  if (descriptor.items !== undefined && Array.isArray(value)) {
    value.forEach((item, index) => validateWorkflowStateValue(item, descriptor.items, `${path}[${index}]`));
  }
}

function matchesStateType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateVersionWorkflow(configuration: Record<string, unknown>): void {
  const workflow = configuration.workflow;
  if (workflow === undefined) return;
  validateWorkflowGraph(workflow);
}
