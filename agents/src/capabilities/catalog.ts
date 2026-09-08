import { createHash } from "node:crypto";
import type { ToolDefinition, ToolRiskClass } from "../tools/types";

export type CapabilityKind = "builtin_tool" | "connector_tool" | "skill" | "plugin_tool" | "mcp_tool" | "user_tool";
export type CapabilitySourceKind = "builtin" | "connector" | "skill" | "plugin" | "mcp" | "user";
export type CapabilityTrust = "platform" | "verified" | "organization" | "user";
export type CapabilityExecutionMode = "native" | "plugin" | "mcp" | "declarative";

export interface CapabilitySource {
  kind: CapabilitySourceKind;
  id: string;
  version: string;
  checksum?: string;
  trust: CapabilityTrust;
}

export interface CapabilityProvider {
  id: string;
  name: string;
  version?: string;
}

export interface CapabilityRuntimeMetadata {
  execution: CapabilityExecutionMode;
  riskClass?: ToolRiskClass;
  requiresApproval?: boolean;
  timeoutMs?: number;
  requiredScopes: readonly string[];
  credentialRequirements: readonly string[];
}

export interface CapabilityDescriptor {
  id: string;
  version: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  category: string;
  logo?: string;
  tags: readonly string[];
  source: CapabilitySource;
  provider?: CapabilityProvider;
  toolsetIds: readonly string[];
  runtime: CapabilityRuntimeMetadata;
}

export interface CapabilityToolsetDescriptor {
  id: string;
  version: string;
  name: string;
  description: string;
  source: CapabilitySource;
  capabilityIds: readonly string[];
  includes: readonly string[];
}

export interface CapabilityRegistrationMetadata {
  kind?: CapabilityKind;
  name?: string;
  category?: string;
  logo?: string;
  tags?: readonly string[];
  source?: Partial<CapabilitySource> & Pick<CapabilitySource, "kind" | "id">;
  provider?: CapabilityProvider;
  toolsetIds?: readonly string[];
  runtime?: Partial<CapabilityRuntimeMetadata>;
}

export interface CapabilityCatalogFilter {
  query?: string;
  kinds?: readonly CapabilityKind[];
  sourceKinds?: readonly CapabilitySourceKind[];
  categories?: readonly string[];
  providerId?: string;
}

export interface CapabilitySnapshot {
  id: string;
  agentVersionId: string;
  descriptorIds: readonly string[];
  toolsetIds: readonly string[];
  descriptors: readonly CapabilityDescriptor[];
  checksum: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function titleCase(value: string): string {
  return value.replace(/[._:/-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function sourceKindFor(kind: CapabilityKind): CapabilitySourceKind {
  switch (kind) {
    case "builtin_tool": return "builtin";
    case "connector_tool": return "connector";
    case "plugin_tool": return "plugin";
    case "mcp_tool": return "mcp";
    case "user_tool": return "user";
    case "skill": return "skill";
  }
}

function executionModeFor(kind: CapabilityKind): CapabilityExecutionMode {
  if (kind === "skill") return "declarative";
  if (kind === "plugin_tool") return "plugin";
  if (kind === "mcp_tool") return "mcp";
  return "native";
}

function descriptorKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function normalizeSource(source: CapabilitySource): CapabilitySource {
  if (!source.id.trim()) throw new Error("CAPABILITY_SOURCE_ID_REQUIRED");
  if (!source.version.trim()) throw new Error(`CAPABILITY_SOURCE_VERSION_REQUIRED:${source.id}`);
  return freezeDeep({
    ...source,
    id: source.id.trim(),
    version: source.version.trim(),
    ...(source.checksum?.trim() ? { checksum: source.checksum.trim().toLowerCase() } : {}),
  });
}

function normalizeDescriptor(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  if (!descriptor.id.trim()) throw new Error("CAPABILITY_ID_REQUIRED");
  if (!descriptor.version.trim()) throw new Error(`CAPABILITY_VERSION_REQUIRED:${descriptor.id}`);
  if (!descriptor.name.trim()) throw new Error(`CAPABILITY_NAME_REQUIRED:${descriptor.id}`);
  if (!descriptor.description.trim()) throw new Error(`CAPABILITY_DESCRIPTION_REQUIRED:${descriptor.id}`);
  if (!descriptor.category.trim()) throw new Error(`CAPABILITY_CATEGORY_REQUIRED:${descriptor.id}`);
  if (descriptor.runtime.timeoutMs !== undefined && (descriptor.runtime.timeoutMs < 1 || descriptor.runtime.timeoutMs > 120_000)) {
    throw new Error(`CAPABILITY_TIMEOUT_INVALID:${descriptor.id}`);
  }
  const normalized = {
    ...descriptor,
    id: descriptor.id.trim(),
    version: descriptor.version.trim(),
    name: descriptor.name.trim(),
    description: descriptor.description.trim(),
    category: descriptor.category.trim(),
    tags: sortedUnique(descriptor.tags),
    source: normalizeSource(descriptor.source),
    ...(descriptor.logo?.trim() ? { logo: descriptor.logo.trim() } : {}),
    ...(descriptor.provider ? { provider: { ...descriptor.provider, id: descriptor.provider.id.trim(), name: descriptor.provider.name.trim() } } : {}),
    toolsetIds: sortedUnique(descriptor.toolsetIds),
    runtime: {
      ...descriptor.runtime,
      requiredScopes: sortedUnique(descriptor.runtime.requiredScopes),
      credentialRequirements: sortedUnique(descriptor.runtime.credentialRequirements),
    },
  };
  return freezeDeep(normalized);
}

function normalizeToolset(toolset: CapabilityToolsetDescriptor): CapabilityToolsetDescriptor {
  if (!toolset.id.trim()) throw new Error("CAPABILITY_TOOLSET_ID_REQUIRED");
  if (!toolset.version.trim()) throw new Error(`CAPABILITY_TOOLSET_VERSION_REQUIRED:${toolset.id}`);
  if (!toolset.name.trim()) throw new Error(`CAPABILITY_TOOLSET_NAME_REQUIRED:${toolset.id}`);
  return freezeDeep({
    ...toolset,
    id: toolset.id.trim(),
    version: toolset.version.trim(),
    name: toolset.name.trim(),
    description: toolset.description.trim(),
    source: normalizeSource(toolset.source),
    capabilityIds: sortedUnique(toolset.capabilityIds),
    includes: sortedUnique(toolset.includes),
  });
}

/**
 * Canonical discovery and toolset module. It stores descriptors only; executable handlers remain
 * owned by ToolRegistry and are invoked through CapabilityRuntime.
 */
export class CapabilityCatalog {
  private readonly descriptors = new Map<string, CapabilityDescriptor>();
  private readonly toolsets = new Map<string, CapabilityToolsetDescriptor>();

  public register(descriptor: CapabilityDescriptor): void {
    const normalized = normalizeDescriptor(descriptor);
    const key = descriptorKey(normalized.id, normalized.version);
    if (this.descriptors.has(key)) throw new Error(`CAPABILITY_DUPLICATE:${key}`);
    this.descriptors.set(key, normalized);
  }

  public registerTool(tool: Omit<ToolDefinition, "handler">, metadata: CapabilityRegistrationMetadata = {}): CapabilityDescriptor {
    const kind = metadata.kind ?? "builtin_tool";
    const requiredScope = tool.manifest?.requiredScope;
    const sourceKind = metadata.source?.kind ?? sourceKindFor(kind);
    const sourceId = metadata.source?.id ?? tool.manifest?.ownerService ?? "agents";
    const sourceVersion = metadata.source?.version ?? tool.version;
    const runtime = {
      execution: metadata.runtime?.execution ?? executionModeFor(kind),
      riskClass: metadata.runtime?.riskClass ?? tool.riskClass,
      requiresApproval: metadata.runtime?.requiresApproval ?? tool.requiresApproval,
      timeoutMs: metadata.runtime?.timeoutMs ?? tool.timeoutMs,
      requiredScopes: sortedUnique([...(metadata.runtime?.requiredScopes ?? []), ...(requiredScope && requiredScope !== "legacy" ? [requiredScope] : [])]),
      credentialRequirements: sortedUnique(metadata.runtime?.credentialRequirements),
    } satisfies CapabilityRuntimeMetadata;
    const descriptor: CapabilityDescriptor = {
      id: tool.name,
      version: tool.version,
      kind,
      name: metadata.name ?? titleCase(tool.name),
      description: tool.description,
      category: metadata.category ?? requiredScope?.split(".")[0] ?? "platform",
      ...(metadata.logo ? { logo: metadata.logo } : {}),
      tags: metadata.tags ?? [],
      source: {
        kind: sourceKind,
        id: sourceId,
        version: sourceVersion,
        ...(metadata.source?.checksum ? { checksum: metadata.source.checksum } : {}),
        trust: metadata.source?.trust ?? (kind === "builtin_tool" ? "platform" : "organization"),
      },
      ...(metadata.provider ? { provider: metadata.provider } : {}),
      toolsetIds: metadata.toolsetIds ?? [],
      runtime,
    };
    this.register(descriptor);
    return descriptor;
  }

  public registerToolset(toolset: CapabilityToolsetDescriptor): void {
    const normalized = normalizeToolset(toolset);
    const key = descriptorKey(normalized.id, normalized.version);
    if (this.toolsets.has(key)) throw new Error(`CAPABILITY_TOOLSET_DUPLICATE:${key}`);
    this.toolsets.set(key, normalized);
  }

  public get(id: string, version?: string): CapabilityDescriptor | undefined {
    if (version) return this.descriptors.get(descriptorKey(id, version));
    return [...this.descriptors.values()]
      .filter((descriptor) => descriptor.id === id)
      .sort((left, right) => right.version.localeCompare(left.version))[0];
  }

  public list(filter: CapabilityCatalogFilter = {}): readonly CapabilityDescriptor[] {
    const query = filter.query?.trim().toLowerCase();
    const kinds = filter.kinds ? new Set(filter.kinds) : undefined;
    const sourceKinds = filter.sourceKinds ? new Set(filter.sourceKinds) : undefined;
    const categories = filter.categories ? new Set(filter.categories.map((category) => category.trim())) : undefined;
    return [...this.descriptors.values()]
      .filter((descriptor) => !query || `${descriptor.id} ${descriptor.name} ${descriptor.description} ${descriptor.tags.join(" ")}`.toLowerCase().includes(query))
      .filter((descriptor) => !kinds || kinds.has(descriptor.kind))
      .filter((descriptor) => !sourceKinds || sourceKinds.has(descriptor.source.kind))
      .filter((descriptor) => !categories || categories.has(descriptor.category))
      .filter((descriptor) => !filter.providerId || descriptor.provider?.id === filter.providerId)
      .sort((left, right) => `${left.name}:${left.id}:${left.version}`.localeCompare(`${right.name}:${right.id}:${right.version}`));
  }

  public listToolsets(): readonly CapabilityToolsetDescriptor[] {
    return [...this.toolsets.values()].sort((left, right) => `${left.name}:${left.id}`.localeCompare(`${right.name}:${right.id}`));
  }

  public resolveToolsets(ids: readonly string[]): readonly string[] {
    const resolved = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (resolved.has(id)) return;
      if (visiting.has(id)) throw new Error(`CAPABILITY_TOOLSET_CYCLE:${id}`);
      const toolset = this.listToolsets().find((entry) => entry.id === id);
      if (!toolset) throw new Error(`CAPABILITY_TOOLSET_NOT_FOUND:${id}`);
      visiting.add(id);
      for (const included of toolset.includes) visit(included);
      for (const capabilityId of toolset.capabilityIds) resolved.add(capabilityId);
      visiting.delete(id);
    };
    for (const id of sortedUnique(ids)) visit(id);
    return [...resolved].sort((left, right) => left.localeCompare(right));
  }

  public snapshot(input: { agentVersionId: string; capabilityIds?: readonly string[]; toolsetIds?: readonly string[] }): CapabilitySnapshot {
    if (!input.agentVersionId.trim()) throw new Error("CAPABILITY_SNAPSHOT_AGENT_VERSION_REQUIRED");
    const descriptorIds = sortedUnique([...(input.capabilityIds ?? []), ...this.resolveToolsets(input.toolsetIds ?? [])]);
    const descriptors = descriptorIds.map((id) => {
      const descriptor = this.get(id);
      if (!descriptor) throw new Error(`CAPABILITY_NOT_FOUND:${id}`);
      return descriptor;
    });
    const toolsetIds = sortedUnique(input.toolsetIds);
    const body = { agentVersionId: input.agentVersionId.trim(), descriptorIds, toolsetIds, descriptors };
    const snapshotChecksum = checksum(body);
    return freezeDeep({
      id: `capability-snapshot-${snapshotChecksum.slice(0, 24)}`,
      agentVersionId: input.agentVersionId.trim(),
      descriptorIds,
      toolsetIds,
      descriptors,
      checksum: snapshotChecksum,
    });
  }
}
