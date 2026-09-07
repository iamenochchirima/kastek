import { z } from "zod";
import { modelPolicySchema } from "../model/policy";
import { validateWorkflowGraph, workflowGraphSchema } from "../workflows/graph";

const memoryNamespaceSchema = z.enum(["conversation", "user_private", "organization_shared", "agent_private"]);
const memoryTypeSchema = z.enum(["working", "semantic", "episodic", "procedural"]);
const skillIdList = z.array(z.string().uuid()).max(100).default([]);

const boundedStringList = (max: number) => z.array(z.string().trim().min(1).max(240)).max(max).default([]);

const extensionPackageKindSchema = z.enum(["skill", "plugin", "mcp_adapter"]);
const extensionPackageIdSchema = z.string().trim().regex(
  /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/,
  "must be a lowercase package id",
);
const extensionPackageVersionSchema = z.string().trim().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  "must be a semantic version",
);
const extensionPackageChecksumSchema = z.string().trim().regex(
  /^[a-f0-9]{64}$/i,
  "must be a SHA-256 checksum",
).transform((value) => value.toLowerCase());
const extensionPermissionSchema = z.string().trim().regex(
  /^[a-z0-9][a-z0-9._:/-]*$/,
  "must be a lowercase permission id",
);
const extensionConfigurationKeySchema = z.string().trim().min(1).max(160);

export const agentExtensionPackageReferenceSchema = z.object({
  kind: extensionPackageKindSchema,
  id: extensionPackageIdSchema,
  version: extensionPackageVersionSchema,
  checksum: extensionPackageChecksumSchema,
  configuration: z.record(extensionConfigurationKeySchema, z.unknown()).default({}),
}).strict();

export const agentExtensionPackageGrantSchema = z.object({
  kind: extensionPackageKindSchema,
  id: extensionPackageIdSchema,
  permissions: z.array(extensionPermissionSchema).max(200).default([]),
}).strict();

/**
 * Immutable package selection for the agent runtime. Package contents are
 * resolved elsewhere; an AgentSpec only records the exact package artifact,
 * its runtime configuration, and the permissions explicitly granted to it.
 */
export const agentExtensionSelectionSchema = z.object({
  packages: z.array(agentExtensionPackageReferenceSchema).max(200).default([]),
  grants: z.array(agentExtensionPackageGrantSchema).max(400).default([]),
}).strict().superRefine((selection, context) => {
  const packageKeys = new Set<string>();
  for (const [index, packageReference] of selection.packages.entries()) {
    const key = `${packageReference.kind}:${packageReference.id}`;
    if (packageKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packages", index],
        message: `duplicate package reference: ${key}`,
      });
    }
    packageKeys.add(key);
  }

  const grantKeys = new Set<string>();
  for (const [index, grant] of selection.grants.entries()) {
    const key = `${grant.kind}:${grant.id}`;
    if (!packageKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grants", index],
        message: `grant references an unselected package: ${key}`,
      });
    }
    if (grantKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grants", index],
        message: `duplicate package grant: ${key}`,
      });
    }
    grantKeys.add(key);
  }
});

export type AgentExtensionSelection = z.infer<typeof agentExtensionSelectionSchema>;
export type AgentExtensionPackageReference = z.infer<typeof agentExtensionPackageReferenceSchema>;
export type AgentExtensionPackageGrant = z.infer<typeof agentExtensionPackageGrantSchema>;

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
  }).strict().superRefine((runtime, context) => {
    if (runtime.maxTotalTokens !== undefined
      && runtime.maxContextTokens !== undefined
      && runtime.maxTotalTokens <= runtime.maxContextTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTotalTokens"],
        message: "must be greater than maxContextTokens",
      });
    }
  }).default({}),
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
  extensions: agentExtensionSelectionSchema.default({ packages: [], grants: [] }),
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

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function freezeExtensionSelection(selection: AgentExtensionSelection): AgentExtensionSelection {
  const packages = selection.packages.map((packageReference) => Object.freeze({
    kind: packageReference.kind,
    id: packageReference.id,
    version: packageReference.version,
    checksum: packageReference.checksum,
    configuration: freezeDeep({ ...packageReference.configuration }),
  }));
  const grants = selection.grants.map((grant) => Object.freeze({
    kind: grant.kind,
    id: grant.id,
    permissions: Object.freeze([...grant.permissions]),
  }));
  return Object.freeze({
    packages: Object.freeze(packages),
    grants: Object.freeze(grants),
  }) as AgentExtensionSelection;
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
  const extensions = freezeExtensionSelection(spec.extensions);
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
  if (extensions.packages.length > 0 || extensions.grants.length > 0) {
    configuration.extensions = Object.freeze({
      packages: extensions.packages,
    });
    policy.extensions = Object.freeze({
      grants: extensions.grants,
    });
  }
  return { instructions: spec.behavior.instructions, configuration, policy };
}
