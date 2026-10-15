import { createHash } from "node:crypto";
import type { CapabilityDescriptor } from "../capabilities/catalog";
import type { SkillVersionRecord } from "../skills/contracts";
import type { ToolDefinition } from "../tools/types";

/**
 * The small, immutable capability contract shared by prompt assembly,
 * planning, invocation, and execution evidence.  This module deliberately
 * contains no database or provider code: hosts resolve grants and bindings,
 * then hand the resolved values to this pure projection.
 */

export const CAPABILITY_SNAPSHOT_VERSION = "v1" as const;

export type CapabilityReasonCode =
  | "not_registered"
  | "not_granted"
  | "not_configured"
  | "unhealthy"
  | "unsupported"
  | "not_published"
  | "not_pinned"
  | "dependency_not_ready"
  | "dependency_not_found";

export type CapabilitySnapshotScope = {
  organizationId: string;
  installationId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  runId?: string;
};

export type CapabilityConnectionStatus = "connected" | "not_granted" | "not_configured" | "unhealthy" | "unsupported";

export interface CapabilityConnectionBinding {
  id: string;
  providerId?: string;
  displayName?: string;
  status: CapabilityConnectionStatus;
  /** Declared connector capabilities; the effective snapshot derives usable IDs from readiness and grants. */
  capabilityIds?: readonly string[];
}

export interface CapabilitySkillBinding {
  id: string;
  version: string;
  name: string;
  description?: string;
  checksum?: string;
  published?: boolean;
  pinned?: boolean;
  requiredCapabilityIds?: readonly string[];
  requiredConnectorIds?: readonly string[];
  dependencyReady?: boolean;
  dependencyReason?: CapabilityReasonCode;
  /** Instruction bodies are never included in the compact skill index. */
  instructions?: string;
  matching?: {
    keywords?: readonly string[];
    phrases?: readonly string[];
  };
  compatibleChannels?: readonly string[];
  compatibleAudiences?: readonly ("personal" | "customer_service")[];
}

export interface EffectiveCapabilityTool {
  id: string;
  name: string;
  version: string;
  description: string;
  riskClass: ToolDefinition["riskClass"];
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  source: {
    kind: string;
    provider?: string;
    version?: string;
  };
  readiness: "callable" | "unavailable";
  reason?: CapabilityReasonCode;
}

export interface EffectiveCapabilitySkill {
  id: string;
  version: string;
  name: string;
  description?: string;
  checksum?: string;
  readiness: "ready" | "unavailable";
  reason?: CapabilityReasonCode;
  requiredCapabilityIds: readonly string[];
  requiredConnectorIds: readonly string[];
  /** Body loaded only by progressive skill projection. */
  instructions?: string;
}

export interface EffectiveCapabilityConnection {
  id: string;
  providerId?: string;
  displayName?: string;
  status: CapabilityConnectionStatus;
  usableCapabilityIds: readonly string[];
}

export interface CapabilityExecutionProjection {
  readonly callableTools: readonly EffectiveCapabilityTool[];
  readonly unavailableTools: readonly EffectiveCapabilityTool[];
  readonly callableToolNames: readonly string[];
  readonly skills: readonly EffectiveCapabilitySkill[];
  readonly connections: readonly EffectiveCapabilityConnection[];
}

export interface CapabilityModelProjection {
  /** Tool definitions retain the exact schemas registered by the runtime. */
  readonly callableTools: readonly Omit<ToolDefinition, "handler">[];
  /** Metadata-only index; instruction bodies are omitted until matched. */
  readonly skillIndex: readonly EffectiveCapabilitySkill[];
  /** Relevant ready skill bodies loaded for this turn. */
  readonly loadedSkills: readonly EffectiveCapabilitySkill[];
  readonly summary: string;
}

export interface CapabilityStudioProjection {
  readonly tools: readonly EffectiveCapabilityTool[];
  readonly skills: readonly EffectiveCapabilitySkill[];
  readonly connections: readonly EffectiveCapabilityConnection[];
  readonly unavailable: readonly {
    id: string;
    kind: "tool" | "skill" | "connection";
    reason: CapabilityReasonCode;
  }[];
}

export interface EffectiveCapabilitySnapshot {
  readonly snapshotVersion: typeof CAPABILITY_SNAPSHOT_VERSION;
  /** Scoped executable/catalog generation used to derive this projection. */
  readonly registryGeneration: string;
  readonly scope: Readonly<CapabilitySnapshotScope>;
  readonly digest: string;
  readonly execution: CapabilityExecutionProjection;
  readonly model: CapabilityModelProjection;
  readonly studio: CapabilityStudioProjection;
}

export interface EffectiveCapabilitySnapshotInput {
  readonly scope: CapabilitySnapshotScope;
  readonly registryGeneration?: string | number;
  /** Authored priorities affect schema budgeting only; grants still filter first. */
  readonly preferredToolNames?: readonly string[];
  /** All executable definitions in the registry, before grant filtering. */
  readonly tools: readonly Omit<ToolDefinition, "handler">[];
  /** Optional canonical catalog metadata for source/provider projection. */
  readonly descriptors?: readonly CapabilityDescriptor[];
  readonly grantedTools?: ReadonlySet<string> | readonly string[];
  readonly connections?: readonly CapabilityConnectionBinding[];
  readonly skills?: readonly (CapabilitySkillBinding | SkillVersionRecord)[];
  readonly message?: string;
  readonly channel?: string;
  readonly audience?: "personal" | "customer_service";
  readonly maxLoadedSkills?: number;
  readonly maxSkillCharacters?: number;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function asSet(value: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  return value instanceof Set ? value : new Set(value ?? []);
}

function asSkillBinding(skill: CapabilitySkillBinding | SkillVersionRecord): CapabilitySkillBinding {
  const candidate = skill as CapabilitySkillBinding & Partial<SkillVersionRecord>;
  return {
    id: candidate.id ?? candidate.skill_definition_id,
    version: candidate.version ?? String(candidate.version_number ?? ""),
    name: candidate.name ?? candidate.skill_name ?? candidate.skill_slug ?? candidate.id ?? candidate.skill_definition_id,
    ...(candidate.description || candidate.skill_description || candidate.skill_name ? { description: candidate.description ?? candidate.skill_description ?? candidate.skill_name } : {}),
    ...(candidate.checksum ? { checksum: candidate.checksum } : {}),
    published: candidate.published ?? candidate.status === "published",
    pinned: candidate.pinned ?? true,
    requiredCapabilityIds: candidate.requiredCapabilityIds ?? candidate.required_capabilities ?? [],
    requiredConnectorIds: candidate.requiredConnectorIds ?? candidate.required_connectors ?? [],
    dependencyReady: candidate.dependencyReady,
    dependencyReason: candidate.dependencyReason,
    ...(candidate.instructions ? { instructions: candidate.instructions } : {}),
    matching: candidate.matching,
    compatibleChannels: candidate.compatibleChannels ?? candidate.compatible_channels ?? [],
    compatibleAudiences: candidate.compatibleAudiences ?? candidate.compatible_audiences ?? [],
  };
}

function skillMatches(skill: EffectiveCapabilitySkill, source: CapabilitySkillBinding, input: { message: string; channel?: string; audience?: "personal" | "customer_service" }): boolean {
  const channel = input.channel?.trim().toLocaleLowerCase();
  if (source.compatibleChannels?.length && (!channel || !source.compatibleChannels.some((value) => value.trim().toLocaleLowerCase() === channel))) return false;
  if (source.compatibleAudiences?.length && (!input.audience || !source.compatibleAudiences.includes(input.audience))) return false;
  if (!input.message.trim()) return false;
  const text = normalized(input.message);
  const matching = source.matching;
  if (!matching) return false;
  const phrases = (matching.phrases ?? []).filter((phrase) => text.includes(normalized(phrase)));
  const keywords = (matching.keywords ?? []).filter((keyword) => text.includes(normalized(keyword)));
  return (matching.phrases?.length || matching.keywords?.length) ? phrases.length > 0 || keywords.length > 0 : false;
}

/** Select ready skill bodies only after metadata matching; this is progressive loading. */
export function loadRelevantCapabilitySkills(
  skills: readonly CapabilitySkillBinding[],
  options: { message?: string; channel?: string; audience?: "personal" | "customer_service"; maxSkills?: number; maxCharacters?: number } = {},
): EffectiveCapabilitySkill[] {
  const candidates = skills
    .map((source) => {
      const requiredCapabilityIds = sortedUnique(source.requiredCapabilityIds);
      const requiredConnectorIds = sortedUnique(source.requiredConnectorIds);
      const ready = source.published !== false && source.pinned !== false && source.dependencyReady !== false;
      const reason = !ready
        ? source.published === false ? "not_published" as const
          : source.pinned === false ? "not_pinned" as const
            : source.dependencyReason ?? "dependency_not_ready" as const
        : undefined;
      const projected: EffectiveCapabilitySkill = {
        id: source.id,
        version: source.version,
        name: source.name,
        ...(source.description ? { description: source.description } : {}),
        ...(source.checksum ? { checksum: source.checksum } : {}),
        readiness: ready ? "ready" : "unavailable",
        ...(reason ? { reason } : {}),
        requiredCapabilityIds,
        requiredConnectorIds,
        ...(ready && source.instructions ? { instructions: source.instructions } : {}),
      };
      return { source, projected };
    })
    .filter(({ source, projected }) => projected.readiness === "ready" && Boolean(projected.instructions) && skillMatches(projected, source, { message: options.message ?? "", channel: options.channel, audience: options.audience }))
    .sort((left, right) => left.projected.id.localeCompare(right.projected.id) || left.projected.version.localeCompare(right.projected.version));
  const selected: EffectiveCapabilitySkill[] = [];
  let remaining = Math.max(0, Math.trunc(options.maxCharacters ?? 24_000));
  for (const candidate of candidates.slice(0, Math.max(0, Math.trunc(options.maxSkills ?? 8)))) {
    const body = candidate.projected.instructions ?? "";
    if (!body || body.length > remaining) continue;
    selected.push(candidate.projected);
    remaining -= body.length;
  }
  return selected;
}

function sourceForTool(tool: Omit<ToolDefinition, "handler">, descriptor: CapabilityDescriptor | undefined): EffectiveCapabilityTool["source"] {
  return {
    kind: descriptor?.source.kind ?? tool.catalog?.source?.kind ?? tool.catalog?.kind ?? "builtin",
    ...(descriptor?.provider?.name ? { provider: descriptor.provider.name } : tool.catalog?.provider?.name ? { provider: tool.catalog.provider.name } : {}),
    ...(descriptor?.version ? { version: descriptor.version } : { version: tool.version }),
  };
}

function connectorIdsForTool(tool: Omit<ToolDefinition, "handler">): string[] {
  return sortedUnique((tool.catalog?.toolsetIds ?? [])
    .filter((toolsetId) => toolsetId.startsWith("connector."))
    .map((toolsetId) => toolsetId.slice("connector.".length)));
}

function toolReadiness(
  tool: Omit<ToolDefinition, "handler">,
  granted: ReadonlySet<string>,
  connections: readonly CapabilityConnectionBinding[],
): CapabilityReasonCode | undefined {
  if (!granted.has(tool.name)) return "not_granted";
  if (tool.manifest?.availability === "not_granted") return "not_granted";
  if (tool.manifest?.availability === "not_configured") return "not_configured";
  if (tool.manifest?.availability === "unhealthy") return "unhealthy";
  const connectorIds = connectorIdsForTool(tool);
  if (!connectorIds.length) return undefined;
  if (connections.some((connection) => connection.status === "connected"
    && connectorIds.includes(connection.id)
    && (connection.capabilityIds ?? []).includes(tool.name))) return undefined;
  if (connections.some((connection) => connection.status === "unhealthy" && connectorIds.includes(connection.id))) return "unhealthy";
  if (connections.some((connection) => connection.status === "not_granted" && connectorIds.includes(connection.id))) return "not_granted";
  return "not_configured";
}

/**
 * Build the effective per-agent capability snapshot. Every projection is
 * derived from this value, and the digest excludes timestamps and secret
 * bindings so Playground/Live comparisons remain portable.
 */
export function createEffectiveCapabilitySnapshot(input: EffectiveCapabilitySnapshotInput): EffectiveCapabilitySnapshot {
  const registryGeneration = String(input.registryGeneration ?? "static").trim() || "static";
  const granted = asSet(input.grantedTools);
  const descriptorById = new Map((input.descriptors ?? []).map((descriptor) => [descriptor.id, descriptor]));
  const executionTools = input.tools
    .map((tool) => {
      const reason = toolReadiness(tool, granted, input.connections ?? []);
      return {
        id: tool.name,
        name: tool.name,
        version: tool.version,
        description: tool.description,
        riskClass: tool.riskClass,
        requiresApproval: tool.requiresApproval,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        source: sourceForTool(tool, descriptorById.get(tool.name)),
        readiness: reason ? "unavailable" as const : "callable" as const,
        ...(reason ? { reason } : {}),
      } satisfies EffectiveCapabilityTool;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const registeredToolNames = new Set(input.tools.map((tool) => tool.name));
  for (const name of [...granted].sort((left, right) => left.localeCompare(right))) {
    if (registeredToolNames.has(name)) continue;
    executionTools.push({
      id: name,
      name,
      version: "unknown",
      description: "Registered capability is not available in this runtime.",
      riskClass: "privileged",
      requiresApproval: true,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      source: { kind: "unknown" },
      readiness: "unavailable",
      reason: "not_registered",
    });
  }
  executionTools.sort((left, right) => left.id.localeCompare(right.id));
  const bindingConnections = (input.connections ?? [])
    .map((connection) => ({
      id: connection.id,
      ...(connection.providerId ? { providerId: connection.providerId } : {}),
      ...(connection.displayName ? { displayName: connection.displayName } : {}),
      status: connection.status,
      usableCapabilityIds: sortedUnique(connection.status === "connected"
        ? connection.capabilityIds?.filter((capabilityId) => executionTools.some((tool) => tool.id === capabilityId && tool.readiness === "callable"))
        : []),
    } satisfies EffectiveCapabilityConnection))
    .sort((left, right) => left.id.localeCompare(right.id));
  const connectedIds = new Set(bindingConnections.filter((connection) => connection.status === "connected").flatMap((connection) => [connection.id, ...connection.usableCapabilityIds]));
  // A catalogue descriptor is metadata only. Skill dependencies require a
  // registered executable or a connected binding, not mere catalogue presence.
  const registeredCapabilityIds = new Set([
    ...input.tools.map((tool) => tool.name),
    ...bindingConnections.flatMap((connection) => connection.usableCapabilityIds),
  ]);
  const sourceSkills = (input.skills ?? []).map(asSkillBinding).map((skill) => {
    const missingCapability = (skill.requiredCapabilityIds ?? []).find((id) => !granted.has(id));
    const missingCapabilityRegistration = (skill.requiredCapabilityIds ?? []).find((id) => !registeredCapabilityIds.has(id));
    const missingConnector = (skill.requiredConnectorIds ?? []).find((id) => !connectedIds.has(id));
    const missingDependency = missingCapabilityRegistration || missingCapability || missingConnector;
    const dependencyReady = skill.dependencyReady !== false && !missingDependency;
    return {
      ...skill,
      dependencyReady,
      ...(!dependencyReady ? {
        dependencyReason: skill.dependencyReady === false
          ? skill.dependencyReason ?? "dependency_not_ready" as const
          : missingCapabilityRegistration ? "dependency_not_found" as const : "dependency_not_ready" as const,
      } : {}),
    };
  }).sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  const skillIndex = sourceSkills.map((skill) => {
    const ready = skill.published !== false && skill.pinned !== false && skill.dependencyReady !== false;
    const reason = ready ? undefined : skill.published === false ? "not_published" as const : skill.pinned === false ? "not_pinned" as const : skill.dependencyReason ?? "dependency_not_ready" as const;
    return {
      id: skill.id,
      version: skill.version,
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      ...(skill.checksum ? { checksum: skill.checksum } : {}),
      readiness: ready ? "ready" as const : "unavailable" as const,
      ...(reason ? { reason } : {}),
      requiredCapabilityIds: sortedUnique(skill.requiredCapabilityIds),
      requiredConnectorIds: sortedUnique(skill.requiredConnectorIds),
    } satisfies EffectiveCapabilitySkill;
  });
  const loadedSkills = loadRelevantCapabilitySkills(sourceSkills, {
    message: input.message,
    channel: input.channel,
    audience: input.audience,
    maxSkills: input.maxLoadedSkills,
    maxCharacters: input.maxSkillCharacters,
  });
  const callableTools = executionTools.filter((tool) => tool.readiness === "callable");
  const preferred = new Set(input.preferredToolNames ?? []);
  const modelTools = input.tools.filter((tool) => callableTools.some((candidate) => candidate.id === tool.name))
    .sort((left, right) => Number(preferred.has(right.name)) - Number(preferred.has(left.name)) || left.name.localeCompare(right.name));
  const unavailable = [
    ...executionTools.flatMap((tool) => tool.readiness === "unavailable" && tool.reason
      ? [{ id: tool.id, kind: "tool" as const, reason: tool.reason }]
      : []),
    ...skillIndex.flatMap((skill) => skill.readiness === "unavailable" && skill.reason
      ? [{ id: skill.id, kind: "skill" as const, reason: skill.reason }]
      : []),
    ...bindingConnections.filter((connection) => connection.status !== "connected").map((connection) => ({ id: connection.id, kind: "connection" as const, reason: connection.status === "not_granted" ? "not_granted" as const : connection.status === "not_configured" ? "not_configured" as const : connection.status === "unhealthy" ? "unhealthy" as const : "unsupported" as const })),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  const summary = renderCapabilitySummary({ callableTools, unavailableTools: executionTools.filter((tool) => tool.readiness === "unavailable"), skills: skillIndex, connections: bindingConnections });
  const digestScope = {
    organizationId: input.scope.organizationId,
    installationId: input.scope.installationId,
    agentDefinitionId: input.scope.agentDefinitionId,
    agentVersionId: input.scope.agentVersionId,
  };
  const portable = {
    snapshotVersion: CAPABILITY_SNAPSHOT_VERSION,
    registryGeneration,
    // A run id is execution evidence, not candidate capability state. Keeping
    // it out of the digest makes retries and Playground/Live comparisons stable.
    scope: digestScope,
    tools: executionTools.map(({ inputSchema: _inputSchema, outputSchema: _outputSchema, ...tool }) => tool),
    skills: skillIndex,
    connections: bindingConnections,
  };
  const snapshot: EffectiveCapabilitySnapshot = {
    snapshotVersion: CAPABILITY_SNAPSHOT_VERSION,
    registryGeneration,
    scope: Object.freeze({ ...input.scope }),
    digest: digest(portable),
    execution: {
      callableTools,
      unavailableTools: executionTools.filter((tool) => tool.readiness === "unavailable"),
      callableToolNames: callableTools.map((tool) => tool.name),
      skills: [...skillIndex],
      connections: bindingConnections,
    },
    model: {
      callableTools: modelTools,
      skillIndex,
      loadedSkills,
      summary,
    },
    studio: {
      tools: executionTools,
      skills: skillIndex,
      connections: bindingConnections,
      unavailable,
    },
  };
  return freezeDeep(snapshot);
}

export function renderCapabilitySummary(input: Pick<CapabilityExecutionProjection, "callableTools" | "unavailableTools" | "skills" | "connections">): string {
  const callable = input.callableTools.length ? input.callableTools.map((tool) => tool.name).join(", ") : "none";
  const unavailable = input.unavailableTools.length ? input.unavailableTools.map((tool) => `${tool.name} (${tool.reason ?? "unsupported"})`).join(", ") : "none";
  const readySkills = input.skills.filter((skill) => skill.readiness === "ready").map((skill) => `${skill.name} v${skill.version}`);
  const unavailableSkills = input.skills.filter((skill) => skill.readiness === "unavailable").map((skill) => `${skill.name} (${skill.reason ?? "unsupported"})`);
  const callableById = new Set(input.callableTools.map((tool) => tool.id));
  const connected = input.connections
    .filter((connection) => connection.status === "connected")
    .map((connection) => {
      const label = connection.displayName ?? connection.providerId ?? connection.id;
      const actions = connection.usableCapabilityIds.filter((id) => callableById.has(id));
      return actions.length ? `${label} -> ${actions.join(", ")}` : `${label} (no callable actions)`;
    });
  return [
    "Capability projection (authoritative for this turn):",
    `Callable tools: ${callable}.`,
    `Unavailable tools: ${unavailable}.`,
    `Connected services (provider -> actions): ${connected.length ? connected.join("; ") : "none"}.`,
    `Published ready skills: ${readySkills.length ? readySkills.join(", ") : "none"}.`,
    `Unavailable skills: ${unavailableSkills.length ? unavailableSkills.join(", ") : "none"}.`,
  ].join("\n");
}

/** Runtime-owned contract; it contains no current tool or integration names. */
export const CAPABILITY_AWARENESS_SYSTEM_CONTRACT = [
  "Capability awareness contract (runtime-owned):",
  "Use the current capability projection and registered tool schemas as the authority for what you can do in this turn.",
  "A catalogue entry or connected service is not callable unless its adapter is registered, healthy, and granted; skills provide instructions and never grant permissions.",
  "Use the filtered skill index or skills_list to discover enabled skills, then use skill_view to load one published, pinned, dependency-ready skill body when needed.",
  "Describe unavailable, ungranted, unhealthy, unsupported, or approval-gated capabilities accurately. Never claim an effect succeeded without a trusted tool result.",
  "For account-specific or current connected records such as calendar events, messages, files, or contacts, call the matching supplied tool and wait for its trusted result before answering; do not infer current state from names or stale context.",
  "Keep credentials, raw IDs, scopes, internal policy markers, and capability implementation details out of user-facing text.",
].join("\n");
