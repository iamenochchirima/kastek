import type { AgentVersionRecord, InstallationRecord } from "../db/repositories/agent-repository";
import type { RemoteMcpProviderVersionRecord } from "../db/repositories/remote-mcp-provider-repository";
import type { SkillVersionRecord } from "../skills/contracts";
import type { ResolvedModelTarget } from "../model/policy";

const MAX_DIFF_PATHS = 200;

export interface EffectiveAgentConfigInput {
  version: AgentVersionRecord;
  source: "typed" | "legacy";
  model: ResolvedModelTarget | null;
  modelError?: string;
  tools: readonly string[];
  connectors: readonly string[];
  knowledge: {
    sourceIds: readonly string[];
    requiredConnections: readonly string[];
  };
  memory: Record<string, unknown>;
  limits: Record<string, unknown>;
  workflow: {
    configured: boolean;
    valid: boolean;
    nodeCount?: number;
    error?: string;
  };
  channels: readonly string[];
  skills: readonly SkillVersionRecord[];
  remoteMcpProviders: readonly RemoteMcpProviderVersionRecord[];
  installation?: InstallationRecord;
}

export interface EffectiveAgentConfigProjection {
  version: {
    id: string;
    agentDefinitionId: string;
    versionNumber: number;
    status: string;
    checksum: string;
    extensionSnapshotId: string | null;
    createdAt: string;
    publishedAt: string | null;
  };
  source: "typed" | "legacy";
  behavior: {
    instructionCharacters: number;
  };
  model: {
    provider?: string;
    model?: string;
    policyVersion?: string;
    fallback: Array<{ provider: string; model: string }>;
    maxTokensPerRun?: number;
    maxEstimatedCostUsd?: number;
    allowUserFundedFallbackToKasiTek: boolean;
    error?: string;
  };
  tools: string[];
  connectors: string[];
  knowledge: {
    sourceIds: string[];
    requiredConnections: string[];
  };
  memory: Record<string, unknown>;
  limits: Record<string, unknown>;
  workflow: {
    configured: boolean;
    valid: boolean;
    nodeCount?: number;
    error?: string;
  };
  channels: string[];
  skills: Array<{
    id: string;
    skillDefinitionId: string;
    name: string;
    slug: string;
    versionNumber: number;
    status: string;
    checksum: string;
    requiredCapabilities: string[];
    requiredConnectors: string[];
    knowledgeSourceIds: string[];
  }>;
  remoteMcpProviders: Array<{
    id: string;
    providerName: string;
    revision: number;
    status: string;
    protocolVersion: string;
    checksum: string;
    toolCount: number;
    healthStatus: "healthy";
  }>;
  installation?: {
    id: string;
    scopeType: string;
    scopeId: string;
    executionMode: string;
    releaseMode: string;
  };
}

/**
 * Build the safe, user-facing view of a version's effective configuration.
 * Secrets, raw instructions, provider URLs, workflow node configuration, and
 * credential references deliberately never cross this boundary.
 */
export function projectEffectiveAgentConfig(input: EffectiveAgentConfigInput): EffectiveAgentConfigProjection {
  const model = input.model;
  return {
    version: {
      id: input.version.id,
      agentDefinitionId: input.version.agent_definition_id,
      versionNumber: input.version.version_number,
      status: input.version.status,
      checksum: input.version.checksum,
      extensionSnapshotId: input.version.extension_snapshot_id ?? null,
      createdAt: input.version.created_at,
      publishedAt: input.version.published_at,
    },
    source: input.source,
    behavior: {
      instructionCharacters: input.version.instructions.length,
    },
    model: {
      ...(model ? {
        provider: model.provider,
        model: model.model,
        ...(model.policyVersion ? { policyVersion: model.policyVersion } : {}),
        fallback: model.fallback,
        ...(model.maxTokensPerRun !== undefined ? { maxTokensPerRun: model.maxTokensPerRun } : {}),
        ...(model.maxEstimatedCostUsd !== undefined ? { maxEstimatedCostUsd: model.maxEstimatedCostUsd } : {}),
        allowUserFundedFallbackToKasiTek: model.allowUserFundedFallbackToKasiTek,
      } : {
        fallback: [],
        allowUserFundedFallbackToKasiTek: false,
      }),
      ...(input.modelError ? { error: input.modelError } : {}),
    },
    tools: uniqueSorted(input.tools),
    connectors: uniqueSorted(input.connectors),
    knowledge: {
      sourceIds: uniqueSorted(input.knowledge.sourceIds),
      requiredConnections: uniqueSorted(input.knowledge.requiredConnections),
    },
    memory: cloneRecord(input.memory),
    limits: cloneRecord(input.limits),
    workflow: {
      configured: input.workflow.configured,
      valid: input.workflow.valid,
      ...(input.workflow.nodeCount !== undefined ? { nodeCount: input.workflow.nodeCount } : {}),
      ...(input.workflow.error ? { error: input.workflow.error } : {}),
    },
    channels: uniqueSorted(input.channels),
    skills: input.skills.map((skill) => ({
      id: skill.id,
      skillDefinitionId: skill.skill_definition_id,
      name: skill.skill_name ?? skill.skill_slug ?? skill.skill_definition_id,
      slug: skill.skill_slug ?? skill.skill_definition_id,
      versionNumber: skill.version_number,
      status: skill.status,
      checksum: skill.checksum,
      requiredCapabilities: uniqueSorted(skill.required_capabilities),
      requiredConnectors: uniqueSorted(skill.required_connectors),
      knowledgeSourceIds: uniqueSorted(skill.knowledge_source_ids),
    })),
    remoteMcpProviders: input.remoteMcpProviders.map((provider) => ({
      id: provider.id,
      providerName: provider.provider_name ?? provider.provider_id,
      revision: provider.revision,
      status: provider.status,
      protocolVersion: provider.protocol_version,
      checksum: provider.checksum,
      toolCount: provider.tools.length,
      healthStatus: "healthy" as const,
    })),
    ...(input.installation ? {
      installation: {
        id: input.installation.id,
        scopeType: input.installation.scope_type,
        scopeId: input.installation.scope_id,
        executionMode: input.installation.execution_mode,
        releaseMode: input.installation.release_mode,
      },
    } : {}),
  };
}

export interface EffectiveAgentConfigDiff {
  changed: boolean;
  paths: string[];
  truncated: boolean;
}

/** Compare only effective behavior; immutable version identity is metadata, not a change. */
export function diffEffectiveAgentConfig(
  candidate: EffectiveAgentConfigProjection,
  deployed: EffectiveAgentConfigProjection,
  maxPaths = MAX_DIFF_PATHS,
): EffectiveAgentConfigDiff {
  const paths: string[] = [];
  const limit = Math.max(1, Math.min(MAX_DIFF_PATHS, Math.trunc(maxPaths)));
  compareValues(comparable(candidate), comparable(deployed), "", paths, limit);
  return { changed: paths.length > 0, paths, truncated: paths.length >= limit && hasAdditionalDifference(comparable(candidate), comparable(deployed), paths, limit) };
}

function comparable(projection: EffectiveAgentConfigProjection): Omit<EffectiveAgentConfigProjection, "version"> {
  const { version: _version, ...effective } = projection;
  return effective;
}

function compareValues(left: unknown, right: unknown, path: string, paths: string[], limit: number): void {
  if (paths.length >= limit) return;
  if (Object.is(left, right)) return;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) paths.push(path || "/");
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length && paths.length < limit; index += 1) {
      compareValues(left[index], right[index], `${path}/${index}`, paths, limit);
    }
    return;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)].sort());
    for (const key of keys) {
      if (paths.length >= limit) return;
      compareValues(left[key], right[key], `${path}/${escapePath(key)}`, paths, limit);
    }
    return;
  }
  paths.push(path || "/");
}

function hasAdditionalDifference(left: unknown, right: unknown, paths: readonly string[], limit: number): boolean {
  if (paths.length < limit) return false;
  const allPaths: string[] = [];
  compareValues(left, right, "", allPaths, limit + 1);
  return allPaths.length > limit;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePath(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
