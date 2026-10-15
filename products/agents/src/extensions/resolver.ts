import { createHash } from "node:crypto";
import type {
  ConnectorExtensionDeclaration,
  ExtensionDeclarationBase,
  ExtensionKind,
  ExtensionReadiness,
  ExtensionReadinessBlocker,
  ExtensionResolverInput,
  ExtensionSnapshot,
  McpCapabilityDeclaration,
  PluginExtensionDeclaration,
  ResolvedExtension,
  SelectedExtensionPackage,
  SkillExtensionDeclaration,
} from "./contracts";

type Dependency = { kind: ExtensionKind; id: string };

type ResolvedByKind = {
  skill: ResolvedExtension<SkillExtensionDeclaration>[];
  plugin: ResolvedExtension<PluginExtensionDeclaration>[];
  connector: ResolvedExtension<ConnectorExtensionDeclaration>[];
  mcp_capability: ResolvedExtension<McpCapabilityDeclaration>[];
};

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

function immutable<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  return Object.freeze(value);
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizedIds(value: unknown, declarationId: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`EXTENSION_DEPENDENCIES_INVALID:${declarationId}`);
  }
  return sortedUnique(value);
}

function normalizeDeclaration<T extends ExtensionDeclarationBase>(declaration: T): T {
  if (!declaration.id.trim()) throw new Error("EXTENSION_ID_REQUIRED");
  if (!declaration.version.trim()) throw new Error(`EXTENSION_VERSION_REQUIRED:${declaration.id}`);
  if (!/^[a-f0-9]{64}$/i.test(declaration.checksum)) throw new Error(`EXTENSION_CHECKSUM_INVALID:${declaration.id}`);
  const normalized = {
    ...declaration,
    id: declaration.id.trim(),
    version: declaration.version.trim(),
    checksum: declaration.checksum.toLowerCase(),
    ...(declaration.name?.trim() ? { name: declaration.name.trim() } : {}),
  } as T;
  const fields = normalized as Record<string, unknown>;
  if ("requiredCapabilityIds" in fields) {
    Object.assign(normalized, { requiredCapabilityIds: normalizedIds(fields.requiredCapabilityIds, normalized.id) });
  }
  if ("requiredConnectorIds" in fields) {
    Object.assign(normalized, { requiredConnectorIds: normalizedIds(fields.requiredConnectorIds, normalized.id) });
  }
  if ("skillIds" in fields) Object.assign(normalized, { skillIds: normalizedIds(fields.skillIds, normalized.id) });
  if ("capabilityIds" in fields) Object.assign(normalized, { capabilityIds: normalizedIds(fields.capabilityIds, normalized.id) });
  if ("connectorIds" in fields) Object.assign(normalized, { connectorIds: normalizedIds(fields.connectorIds, normalized.id) });
  if ("mcpCapabilityIds" in fields) Object.assign(normalized, { mcpCapabilityIds: normalizedIds(fields.mcpCapabilityIds, normalized.id) });
  return immutable(normalized);
}

function assertUnique(kind: ExtensionKind, declarations: readonly ExtensionDeclarationBase[]): void {
  const ids = new Set<string>();
  for (const declaration of declarations) {
    if (ids.has(declaration.id)) throw new Error(`EXTENSION_DUPLICATE_ID:${kind}:${declaration.id}`);
    ids.add(declaration.id);
  }
}

function readiness(input: {
  declaration: ExtensionDeclarationBase;
  granted: boolean;
  dependencies: readonly Dependency[];
  resolved: ReadonlyMap<string, ResolvedExtension>;
}): ExtensionReadiness {
  const blockers: ExtensionReadinessBlocker[] = [];
  const available = input.declaration.available;
  if (!available) blockers.push({ code: "not_available" });
  const installed = available && input.declaration.installed;
  if (available && !installed) blockers.push({ code: "not_installed" });
  const configured = installed && input.declaration.configured;
  if (installed && !configured) blockers.push({ code: "not_configured" });

  let dependenciesReady = true;
  for (const dependency of input.dependencies) {
    const resolved = input.resolved.get(`${dependency.kind}:${dependency.id}`);
    if (!resolved) {
      dependenciesReady = false;
      blockers.push({ code: "dependency_not_found", dependency });
    } else if (!resolved.readiness.ready) {
      dependenciesReady = false;
      blockers.push({ code: "dependency_not_ready", dependency });
    }
  }
  const granted = configured && dependenciesReady && input.granted;
  if (configured && dependenciesReady && !granted) blockers.push({ code: "not_granted" });
  const ready = granted;
  return immutable({
    state: !available ? "available" : !installed ? "installed" : !configured ? "configured" : !granted ? "granted" : "ready",
    available,
    installed,
    configured,
    granted,
    ready,
    blockers,
  });
}

function resolve<T extends ExtensionDeclarationBase>(input: {
  kind: ExtensionKind;
  declarations: readonly T[];
  grants: ReadonlySet<string>;
  dependencies: (declaration: T) => Dependency[];
  resolved: ReadonlyMap<string, ResolvedExtension>;
}): ResolvedExtension<T>[] {
  return input.declarations
    .map((declaration) => immutable({
      kind: input.kind,
      declaration,
      readiness: readiness({
        declaration,
        granted: input.grants.has(declaration.id),
        dependencies: input.dependencies(declaration),
        resolved: input.resolved,
      }),
    }))
    .sort((left, right) => left.declaration.id.localeCompare(right.declaration.id));
}

function addResolved(target: Map<string, ResolvedExtension>, resolved: readonly ResolvedExtension[]): void {
  for (const extension of resolved) target.set(`${extension.kind}:${extension.declaration.id}`, extension);
}

function dependency(kind: ExtensionKind, ids: readonly string[] | undefined): Dependency[] {
  return sortedUnique(ids).map((id) => ({ kind, id }));
}

function normalizeSelectedPackages(packages: readonly SelectedExtensionPackage[] | undefined): SelectedExtensionPackage[] {
  const seen = new Set<string>();
  return (packages ?? [])
    .map((selected) => {
      const key = `${selected.kind}:${selected.id}:${selected.version}`;
      if (seen.has(key)) throw new Error(`EXTENSION_SELECTED_PACKAGE_DUPLICATE:${key}`);
      seen.add(key);
      if (!selected.organizationId.trim()) throw new Error("EXTENSION_SELECTED_PACKAGE_ORGANIZATION_REQUIRED");
      if (!selected.packageVersionId.trim()) throw new Error(`EXTENSION_SELECTED_PACKAGE_VERSION_ID_REQUIRED:${key}`);
      if (!selected.id.trim()) throw new Error("EXTENSION_SELECTED_PACKAGE_ID_REQUIRED");
      if (!selected.version.trim()) throw new Error(`EXTENSION_SELECTED_PACKAGE_VERSION_REQUIRED:${key}`);
      if (!/^[a-f0-9]{64}$/i.test(selected.checksum)) throw new Error(`EXTENSION_SELECTED_PACKAGE_CHECKSUM_INVALID:${key}`);
      if (selected.status !== "published" && selected.status !== "deprecated") {
        throw new Error(`EXTENSION_SELECTED_PACKAGE_STATUS_INVALID:${key}`);
      }
      const configuration = selected.configuration && typeof selected.configuration === "object" && !Array.isArray(selected.configuration)
        ? selected.configuration
        : {};
      const grantedPermissions = sortedUnique(selected.grantedPermissions);
      return immutable({
        organizationId: selected.organizationId.trim(),
        packageVersionId: selected.packageVersionId.trim(),
        kind: selected.kind,
        id: selected.id.trim(),
        version: selected.version.trim(),
        checksum: selected.checksum.toLowerCase(),
        status: selected.status,
        configuration: immutable({ ...configuration }),
        grantedPermissions,
      });
    })
    .sort((left, right) => `${left.kind}:${left.id}:${left.version}`.localeCompare(`${right.kind}:${right.id}:${right.version}`));
}

/**
 * Publication is stricter than diagnostic resolution. A resolver may produce
 * a blocked snapshot so callers can explain what is missing, but a published
 * version must never carry an extension that cannot run under its declared
 * gates or that was selected without a resolved catalog-backed declaration.
 */
export function assertExtensionSnapshotReady(snapshot: ExtensionSnapshot): void {
  const resolved = [
    ...snapshot.skills,
    ...snapshot.plugins,
    ...snapshot.connectors,
    ...snapshot.mcpCapabilities,
  ];
  const resolvedByKey = new Set(resolved.map((entry) => `${entry.kind}:${entry.declaration.id}`));
  for (const selected of snapshot.selectedPackages ?? []) {
    if (selected.kind === "mcp_adapter") {
      throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_UNSUPPORTED:${selected.kind}:${selected.id}`);
    }
    const key = `${selected.kind}:${selected.id}`;
    if (!resolvedByKey.has(key)) {
      throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_UNRESOLVED:${key}`);
    }
  }
  for (const entry of resolved) {
    if (entry.readiness.ready) continue;
    const blocker = entry.readiness.blockers[0]?.code ?? "unknown";
    throw new Error(`EXTENSION_SNAPSHOT_EXTENSION_NOT_READY:${entry.kind}:${entry.declaration.id}:${blocker}`);
  }
}

/**
 * Compiles a pinned declarative agent extension set. It performs no I/O and
 * never invokes a plugin, MCP provider, connector, or capability handler.
 */
export class ExtensionResolver {
  public resolve(input: ExtensionResolverInput): ExtensionSnapshot {
    if (!input.agentVersionId.trim()) throw new Error("EXTENSION_AGENT_VERSION_REQUIRED");
    const skills = (input.skills ?? []).map(normalizeDeclaration);
    const plugins = (input.plugins ?? []).map(normalizeDeclaration);
    const connectors = (input.connectors ?? []).map(normalizeDeclaration);
    const mcpCapabilities = (input.mcpCapabilities ?? []).map(normalizeDeclaration);
    assertUnique("skill", skills);
    assertUnique("plugin", plugins);
    assertUnique("connector", connectors);
    assertUnique("mcp_capability", mcpCapabilities);

    const resolved = new Map<string, ResolvedExtension>();
    const resolvedConnectors = resolve({
      kind: "connector",
      declarations: connectors,
      grants: new Set(sortedUnique(input.grants.connectorIds)),
      dependencies: () => [],
      resolved,
    });
    addResolved(resolved, resolvedConnectors);

    const resolvedMcpCapabilities = resolve({
      kind: "mcp_capability",
      declarations: mcpCapabilities,
      grants: new Set(sortedUnique(input.grants.capabilityIds)),
      dependencies: (entry) => dependency("connector", entry.requiredConnectorIds),
      resolved,
    });
    addResolved(resolved, resolvedMcpCapabilities);

    const resolvedSkills = resolve({
      kind: "skill",
      declarations: skills,
      grants: new Set(sortedUnique(input.grants.skillIds)),
      dependencies: (entry) => [
        ...dependency("connector", entry.requiredConnectorIds),
        ...dependency("mcp_capability", entry.requiredCapabilityIds),
      ],
      resolved,
    });
    addResolved(resolved, resolvedSkills);

    const resolvedPlugins = resolve({
      kind: "plugin",
      declarations: plugins,
      grants: new Set(sortedUnique(input.grants.pluginIds)),
      dependencies: (entry) => [
        ...dependency("skill", entry.skillIds),
        ...dependency("connector", entry.connectorIds),
        ...dependency("mcp_capability", entry.mcpCapabilityIds),
      ],
      resolved,
    });

    const selectedPackages = normalizeSelectedPackages(input.selectedPackages);

    const snapshotBody = {
      agentVersionId: input.agentVersionId.trim(),
      skills: resolvedSkills,
      plugins: resolvedPlugins,
      connectors: resolvedConnectors,
      mcpCapabilities: resolvedMcpCapabilities,
      selectedPackages,
    };
    const snapshotChecksum = checksum(snapshotBody);
    return immutable({
      id: `extension-snapshot-${snapshotChecksum.slice(0, 24)}`,
      checksum: snapshotChecksum,
      ...snapshotBody,
    });
  }

  /**
   * Resolve the immutable publication candidate and fail closed when any
   * selected or declared extension is not ready. The plain resolve() method
   * remains diagnostic and can still return readiness blockers to authoring
   * and tooling surfaces.
   */
  public resolveForPublication(input: ExtensionResolverInput): ExtensionSnapshot {
    const snapshot = this.resolve(input);
    assertExtensionSnapshotReady(snapshot);
    return snapshot;
  }
}
