import { z } from "zod";

const nodeTypeSchema = z.enum(["deterministic", "model", "agent_loop", "tool", "route", "fan_out", "fan_in", "approval", "wait"]);

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
  }
  const stack = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (stack.has(id)) {
      const node = nodes.get(id)!;
      const hasBound = node.maxIterations !== undefined || graph.edges.some((edge) => edge.from === id && edge.to === id && edge.maxIterations !== undefined);
      if (!hasBound) throw new Error(`Workflow contains an unbounded cycle at node: ${id}`);
      return;
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

export function validateVersionWorkflow(configuration: Record<string, unknown>): void {
  const workflow = configuration.workflow;
  if (workflow === undefined) return;
  validateWorkflowGraph(workflow);
}
