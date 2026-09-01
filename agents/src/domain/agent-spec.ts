import { z } from "zod";
import { modelPolicySchema } from "../model/policy";
import { validateWorkflowGraph, workflowGraphSchema } from "../workflows/graph";

const memoryNamespaceSchema = z.enum(["conversation", "user_private", "organization_shared", "agent_private"]);
const memoryTypeSchema = z.enum(["working", "semantic", "episodic", "procedural"]);
const skillIdList = z.array(z.string().uuid()).max(100).default([]);

const boundedStringList = (max: number) => z.array(z.string().trim().min(1).max(240)).max(max).default([]);

/**
 * The versioned, user-authored composition contract for hosted agents.
 *
 * This schema is intentionally strict at every owned boundary. Free-form
 * values remain available inside workflow node configuration because that is
 * an explicitly versioned workflow extension point, not an excuse to make the
 * agent contract untyped.
 */
export const agentSpecSchema = z.object({
  specVersion: z.literal(1),
  identity: z.object({
    displayName: z.string().trim().min(1).max(160).optional(),
    purpose: z.string().trim().max(2_000).optional(),
    audience: z.enum(["personal", "customer_service"]).optional(),
  }).strict().default({}),
  behavior: z.object({
    instructions: z.string().trim().min(1).max(200_000),
  }).strict(),
  model: modelPolicySchema.strict(),
  runtime: z.object({
    maxContextMessages: z.number().int().positive().max(500).optional(),
    maxContextTokens: z.number().int().positive().max(100_000).optional(),
    maxIterations: z.number().int().nonnegative().max(100).optional(),
    maxModelCalls: z.number().int().positive().max(100).optional(),
    maxToolCalls: z.number().int().nonnegative().max(200).optional(),
    maxTotalTokens: z.number().int().positive().max(1_000_000).optional(),
    maxWallTimeMs: z.number().int().positive().max(3_600_000).optional(),
    maxEstimatedCostUsd: z.number().nonnegative().max(10_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
  }).strict().default({}),
  capabilities: z.object({
    allowedTools: boundedStringList(200),
    requiredCapabilities: boundedStringList(200),
  }).strict().default({ allowedTools: [], requiredCapabilities: [] }),
  knowledge: z.object({
    sourceIds: boundedStringList(200),
    requiredConnections: boundedStringList(100),
  }).strict().default({ sourceIds: [], requiredConnections: [] }),
  memory: z.object({
    mode: z.enum(["disabled", "explicit", "reviewed", "automatic"]).default("explicit"),
    readableNamespaces: z.array(memoryNamespaceSchema).max(4).default(["conversation", "user_private", "organization_shared", "agent_private"]),
    writableNamespaces: z.array(memoryNamespaceSchema).max(4).default(["conversation", "user_private", "agent_private"]),
    writableTypes: z.array(memoryTypeSchema).max(4).default(["working", "semantic", "episodic"]),
    maxRetrieved: z.number().int().nonnegative().max(50).default(8),
    maxRetrievedTokens: z.number().int().min(256).max(8_000).default(1_600),
    maxWritesPerRun: z.number().int().nonnegative().max(20).default(3),
    retentionDays: z.number().int().positive().max(3_650).optional(),
    allowSensitive: z.boolean().default(false),
  }).strict().default({
    mode: "explicit",
    readableNamespaces: ["conversation", "user_private", "organization_shared", "agent_private"],
    writableNamespaces: ["conversation", "user_private", "agent_private"],
    writableTypes: ["working", "semantic", "episodic"],
    maxRetrieved: 8,
    maxRetrievedTokens: 1_600,
    maxWritesPerRun: 3,
    allowSensitive: false,
  }),
  skills: z.object({
    allowedSkillIds: skillIdList,
  }).strict().default({ allowedSkillIds: [] }),
  workflow: z.object({
    graph: workflowGraphSchema.optional(),
  }).strict().default({}),
  channels: z.object({
    allowed: boundedStringList(50),
  }).strict().default({ allowed: [] }),
  release: z.object({
    mode: z.enum(["pinned", "follow_published", "staged"]).default("follow_published"),
  }).strict().default({ mode: "follow_published" }),
}).strict();

export type AgentSpec = z.infer<typeof agentSpecSchema>;

export interface CompiledAgentSpec {
  instructions: string;
  configuration: Record<string, unknown>;
  policy: Record<string, unknown>;
}

/**
 * Compile the typed contract into the existing immutable version columns.
 * Keeping this adapter at the boundary lets the runtime remain compatible
 * with historical rows while new rows retain a canonical spec snapshot.
 */
export function compileAgentSpec(input: unknown): CompiledAgentSpec {
  const spec = agentSpecSchema.parse(input);
  if (spec.workflow.graph) validateWorkflowGraph(spec.workflow.graph);
  const runtime = { ...spec.runtime };
  const configuration: Record<string, unknown> = {
    specVersion: spec.specVersion,
    agentSpec: spec,
    ...runtime,
    ...(spec.workflow.graph ? { workflow: spec.workflow.graph } : {}),
  };
  const policy: Record<string, unknown> = {
    modelPolicy: spec.model,
    allowedTools: spec.capabilities.allowedTools,
    requiredCapabilities: spec.capabilities.requiredCapabilities,
    memory: spec.memory,
    allowedChannels: spec.channels.allowed,
    allowedSkillIds: spec.skills.allowedSkillIds,
  };
  return { instructions: spec.behavior.instructions, configuration, policy };
}
