import type { Pool } from "pg";
import { ExtensionResolver, type ConnectorExtensionDeclaration, type ExtensionDeclarationBase, type ExtensionKind, type ExtensionPackageSelectionKind, type ExtensionSnapshot, type McpCapabilityDeclaration, type PluginExtensionDeclaration, type SelectedExtensionPackage, type SkillExtensionDeclaration } from "../../extensions";
import { remoteMcpToolsSchema, remoteMcpToolName, type RemoteMcpTool } from "../../mcp/remote";
import { query, withTransaction } from "../pool";

export type ExtensionDeclaration =
  | SkillExtensionDeclaration
  | PluginExtensionDeclaration
  | ConnectorExtensionDeclaration
  | McpCapabilityDeclaration;

export interface ExtensionPackageDependencyInput {
  kind: ExtensionKind;
  id: string;
  versionConstraint?: string;
  required?: boolean;
}

export interface ExtensionPackageCompatibilityInput {
  minRuntimeVersion?: string;
  maxRuntimeVersion?: string;
  supportedAgentAudiences?: readonly string[];
  supportedChannels?: readonly string[];
  constraints?: Record<string, unknown>;
}

export interface CreateExtensionPackageInput {
  declaration: ExtensionDeclaration;
  dependencies?: readonly ExtensionPackageDependencyInput[];
  compatibility?: ExtensionPackageCompatibilityInput;
}

export interface ExtensionPackageDependencyRecord {
  organization_id: string;
  package_version_id: string;
  dependency_kind: ExtensionKind;
  dependency_id: string;
  version_constraint: string;
  required: boolean;
  created_at: string;
}

export interface ExtensionPackageCompatibilityRecord {
  organization_id: string;
  package_version_id: string;
  min_runtime_version: string | null;
  max_runtime_version: string | null;
  supported_agent_audiences: string[];
  supported_channels: string[];
  constraints: Record<string, unknown>;
  created_at: string;
}

export interface ExtensionPackageRecord {
  id: string;
  organization_id: string;
  kind: ExtensionKind;
  package_id: string;
  version: string;
  name: string | null;
  checksum: string;
  status: "draft" | "published" | "deprecated" | "revoked";
  declaration: ExtensionDeclaration;
  created_by: string;
  created_at: string;
  published_at: string | null;
  deprecated_at: string | null;
  revoked_at: string | null;
  dependencies: ExtensionPackageDependencyRecord[];
  compatibility: ExtensionPackageCompatibilityRecord | null;
}

export interface ExtensionSnapshotRecord {
  id: string;
  organization_id: string;
  agent_version_id: string;
  snapshot_key: string;
  checksum: string;
  snapshot: ExtensionSnapshot;
  created_by: string;
  created_at: string;
}

type ExtensionPackageRow = Omit<ExtensionPackageRecord, "declaration" | "dependencies" | "compatibility"> & {
  declaration: ExtensionDeclaration | string;
};

type ExtensionSnapshotRow = Omit<ExtensionSnapshotRecord, "snapshot"> & {
  snapshot: ExtensionSnapshot | string;
};

type VersionExtensionSource = {
  id: string;
  configuration: Record<string, unknown> | string;
  policy: Record<string, unknown> | string;
};

type CanonicalPackageReference = {
  kind: ExtensionPackageSelectionKind;
  id: string;
  version: string;
  checksum: string;
  configuration: Record<string, unknown>;
};

type CanonicalPackageGrant = {
  kind: ExtensionPackageSelectionKind;
  id: string;
  permissions: string[];
};

type PinnedMcpCapabilityRow = {
  provider_version_id: string;
  provider_id: string;
  provider_name: string | null;
  provider_status: "draft" | "approved" | "revoked";
  health_status: "unknown" | "healthy" | "unhealthy";
  revision: number;
  status: "draft" | "published" | "revoked";
  protocol_version: string;
  tools: RemoteMcpTool[] | string;
  checksum: string;
};

const extensionKinds = new Set<ExtensionKind>(["skill", "plugin", "connector", "mcp_capability"]);

function normalizeList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizePackageDeclaration(declaration: ExtensionDeclaration): ExtensionDeclaration {
  if (!declaration || typeof declaration !== "object" || !extensionKinds.has(declaration.kind)) {
    throw new Error("EXTENSION_PACKAGE_DECLARATION_INVALID");
  }
  if ("code" in declaration || "handler" in declaration) {
    throw new Error("EXTENSION_PACKAGE_EXECUTABLE_NOT_ALLOWED");
  }

  // Reuse the resolver's normalization and validation rules at the storage
  // seam. The package remains declarative; no handler or provider is invoked.
  const resolver = new ExtensionResolver();
  const resolved = resolver.resolve({
    agentVersionId: "extension-package-validation",
    skills: declaration.kind === "skill" ? [declaration] : [],
    plugins: declaration.kind === "plugin" ? [declaration] : [],
    connectors: declaration.kind === "connector" ? [declaration] : [],
    mcpCapabilities: declaration.kind === "mcp_capability" ? [declaration] : [],
    grants: {
      skillIds: declaration.kind === "skill" ? [declaration.id] : [],
      pluginIds: declaration.kind === "plugin" ? [declaration.id] : [],
      connectorIds: declaration.kind === "connector" ? [declaration.id] : [],
      capabilityIds: declaration.kind === "mcp_capability" ? [declaration.id] : [],
    },
  });
  const normalized = resolved[`${declaration.kind === "mcp_capability" ? "mcpCapabilities" : `${declaration.kind}s`}` as keyof typeof resolved];
  const entry = Array.isArray(normalized) ? normalized[0] : undefined;
  if (!entry) throw new Error("EXTENSION_PACKAGE_DECLARATION_INVALID");
  return entry.declaration as ExtensionDeclaration;
}

function normalizeDependencies(dependencies: readonly ExtensionPackageDependencyInput[] | undefined): ExtensionPackageDependencyInput[] {
  const seen = new Set<string>();
  return (dependencies ?? []).map((dependency) => {
    if (!extensionKinds.has(dependency.kind) || !dependency.id.trim()) throw new Error("EXTENSION_PACKAGE_DEPENDENCY_INVALID");
    const normalized = {
      kind: dependency.kind,
      id: dependency.id.trim(),
      versionConstraint: dependency.versionConstraint?.trim() || "*",
      required: dependency.required !== false,
    };
    const key = `${normalized.kind}:${normalized.id}:${normalized.versionConstraint}`;
    if (seen.has(key)) throw new Error(`EXTENSION_PACKAGE_DEPENDENCY_DUPLICATE:${key}`);
    seen.add(key);
    return normalized;
  });
}

function normalizeCompatibility(input: ExtensionPackageCompatibilityInput | undefined): ExtensionPackageCompatibilityInput | undefined {
  if (!input) return undefined;
  return {
    ...(input.minRuntimeVersion?.trim() ? { minRuntimeVersion: input.minRuntimeVersion.trim() } : {}),
    ...(input.maxRuntimeVersion?.trim() ? { maxRuntimeVersion: input.maxRuntimeVersion.trim() } : {}),
    supportedAgentAudiences: normalizeList(input.supportedAgentAudiences),
    supportedChannels: normalizeList(input.supportedChannels),
    constraints: input.constraints ?? {},
  };
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function pinnedMcpDeclarations(rows: readonly PinnedMcpCapabilityRow[]): McpCapabilityDeclaration[] {
  return rows.flatMap((row) => {
    if (row.provider_status !== "approved" || row.health_status !== "healthy" || row.status !== "published") {
      throw new Error(`EXTENSION_SNAPSHOT_MCP_PROVIDER_NOT_READY:${row.provider_version_id}`);
    }
    const tools = remoteMcpToolsSchema.parse(parseJson(row.tools));
    const version = `${row.revision}.0.0`;
    return tools.map((tool) => ({
      kind: "mcp_capability" as const,
      id: remoteMcpToolName(row.provider_version_id, tool.name),
      version,
      checksum: row.checksum,
      name: `${row.provider_name ?? row.provider_id}: ${tool.name}`,
      available: true,
      installed: true,
      configured: true,
      providerId: row.provider_id,
      toolName: tool.name,
      requiredConnectorIds: [],
    }));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extensionList<T extends ExtensionDeclaration>(value: unknown, kind: ExtensionKind): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`EXTENSION_SNAPSHOT_${kind.toUpperCase()}_INVALID`);
  return value.map((entry) => {
    if (!isRecord(entry) || entry.kind !== kind) throw new Error(`EXTENSION_SNAPSHOT_${kind.toUpperCase()}_INVALID`);
    return entry as T;
  });
}

function extensionConfig(source: VersionExtensionSource): {
  plugins: PluginExtensionDeclaration[];
  connectors: ConnectorExtensionDeclaration[];
  mcpCapabilities: McpCapabilityDeclaration[];
  grants: { skillIds: string[]; pluginIds: string[]; connectorIds: string[]; capabilityIds: string[] };
  packages: CanonicalPackageReference[];
  packageGrants: CanonicalPackageGrant[];
} {
  const configuration = parseJson(source.configuration);
  const policy = parseJson(source.policy);
  const configurationExtensions = isRecord(configuration.extensions) ? configuration.extensions : {};
  const policyExtensions = isRecord(policy.extensions) ? policy.extensions : {};
  const rawGrantValue = policyExtensions.grants;
  const rawGrants = isRecord(rawGrantValue) ? rawGrantValue : {};
  const list = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim()))]
    : [];
  const parseCanonicalPackages = (value: unknown): CanonicalPackageReference[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("EXTENSION_SNAPSHOT_CANONICAL_PACKAGES_INVALID");
    return value.map((entry) => {
      if (!isRecord(entry)
        || (entry.kind !== "skill" && entry.kind !== "plugin" && entry.kind !== "mcp_adapter")
        || typeof entry.id !== "string"
        || typeof entry.version !== "string"
        || typeof entry.checksum !== "string") {
        throw new Error("EXTENSION_SNAPSHOT_CANONICAL_PACKAGE_INVALID");
      }
      if (entry.configuration !== undefined && !isRecord(entry.configuration)) {
        throw new Error(`EXTENSION_SNAPSHOT_CANONICAL_PACKAGE_CONFIGURATION_INVALID:${entry.id}`);
      }
      return {
        kind: entry.kind,
        id: entry.id.trim(),
        version: entry.version.trim(),
        checksum: entry.checksum.trim().toLowerCase(),
        configuration: isRecord(entry.configuration) ? { ...entry.configuration } : {},
      };
    });
  };
  const parseCanonicalGrants = (value: unknown): CanonicalPackageGrant[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("EXTENSION_SNAPSHOT_CANONICAL_GRANTS_INVALID");
    return value.map((entry) => {
      if (!isRecord(entry)
        || (entry.kind !== "skill" && entry.kind !== "plugin" && entry.kind !== "mcp_adapter")
        || typeof entry.id !== "string"
        || (entry.permissions !== undefined && !Array.isArray(entry.permissions))) {
        throw new Error("EXTENSION_SNAPSHOT_CANONICAL_GRANT_INVALID");
      }
      return {
        kind: entry.kind,
        id: entry.id.trim(),
        permissions: list(entry.permissions),
      };
    });
  };
  const packages = parseCanonicalPackages(configurationExtensions.packages);
  const packageGrants = Array.isArray(rawGrantValue)
    ? parseCanonicalGrants(rawGrantValue)
    : rawGrantValue === undefined || isRecord(rawGrantValue)
      ? []
      : (() => { throw new Error("EXTENSION_SNAPSHOT_CANONICAL_GRANTS_INVALID"); })();
  const legacyExtensions = [configurationExtensions, policyExtensions];
  return {
    plugins: legacyExtensions.flatMap((extensions) => extensionList<PluginExtensionDeclaration>(extensions.plugins, "plugin")),
    connectors: legacyExtensions.flatMap((extensions) => extensionList<ConnectorExtensionDeclaration>(extensions.connectors, "connector")),
    mcpCapabilities: legacyExtensions.flatMap((extensions) => extensionList<McpCapabilityDeclaration>(extensions.mcpCapabilities, "mcp_capability")),
    grants: {
      skillIds: [...new Set(legacyExtensions.flatMap((extensions) => list(isRecord(extensions.grants) ? extensions.grants.skillIds : undefined)))],
      pluginIds: [...new Set(legacyExtensions.flatMap((extensions) => list(isRecord(extensions.grants) ? extensions.grants.pluginIds : undefined)))],
      connectorIds: [...new Set(legacyExtensions.flatMap((extensions) => list(isRecord(extensions.grants) ? extensions.grants.connectorIds : undefined)))],
      capabilityIds: [...new Set(legacyExtensions.flatMap((extensions) => list(isRecord(extensions.grants) ? extensions.grants.capabilityIds : undefined)))],
    },
    packages,
    packageGrants,
  };
}

function hydrateSnapshot(row: ExtensionSnapshotRow): ExtensionSnapshotRecord {
  return { ...row, snapshot: parseJson(row.snapshot) };
}

function hydratePackage(
  row: ExtensionPackageRow,
  dependencies: ExtensionPackageDependencyRecord[] = [],
  compatibility: ExtensionPackageCompatibilityRecord | null = null,
): ExtensionPackageRecord {
  return { ...row, declaration: parseJson(row.declaration), dependencies, compatibility };
}

function packageIdentity(kind: ExtensionPackageSelectionKind, id: string): string {
  return `${kind}:${id}`;
}

function mergeExtensionDeclarations<T extends ExtensionDeclarationBase>(
  kind: ExtensionKind,
  ...declarationLists: readonly (readonly T[])[]
): T[] {
  const merged = new Map<string, T>();
  for (const declarations of declarationLists) {
    for (const declaration of declarations) {
      const existing = merged.get(declaration.id);
      if (existing) {
        if (existing.version !== declaration.version || existing.checksum.toLowerCase() !== declaration.checksum.toLowerCase()) {
          throw new Error(`EXTENSION_SNAPSHOT_DECLARATION_CONFLICT:${kind}:${declaration.id}`);
        }
        continue;
      }
      merged.set(declaration.id, declaration);
    }
  }
  return [...merged.values()];
}

export class ExtensionSnapshotRepository {
  public constructor(private readonly pool: Pool) {}

  public async createPackage(organizationId: string, actorId: string, input: CreateExtensionPackageInput): Promise<ExtensionPackageRecord> {
    const declaration = normalizePackageDeclaration(input.declaration);
    const dependencies = normalizeDependencies(input.dependencies);
    const compatibility = normalizeCompatibility(input.compatibility);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<ExtensionPackageRow>(
        `INSERT INTO agent_extension_packages
          (organization_id, kind, package_id, version, name, checksum, declaration, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (organization_id, kind, package_id, version) DO NOTHING
         RETURNING *`,
        [organizationId, declaration.kind, declaration.id, declaration.version, declaration.name ?? null, declaration.checksum, JSON.stringify(declaration), actorId],
      );
      let row = inserted.rows[0];
      let created = true;
      if (!row) {
        const existing = await client.query<ExtensionPackageRow>(
          `SELECT * FROM agent_extension_packages
           WHERE organization_id = $1 AND kind = $2 AND package_id = $3 AND version = $4`,
          [organizationId, declaration.kind, declaration.id, declaration.version],
        );
        row = existing.rows[0];
        created = false;
      }
      if (!row) throw new Error("EXTENSION_PACKAGE_CREATE_FAILED");
      if (row.checksum.toLowerCase() !== declaration.checksum.toLowerCase()) {
        throw new Error("EXTENSION_PACKAGE_VERSION_CONFLICT");
      }
      if (created) {
        for (const dependency of dependencies) {
          await client.query(
            `INSERT INTO agent_extension_package_dependencies
              (organization_id, package_version_id, dependency_kind, dependency_id, version_constraint, required)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [organizationId, row.id, dependency.kind, dependency.id, dependency.versionConstraint ?? "*", dependency.required !== false],
          );
        }
        if (compatibility) {
          await client.query(
            `INSERT INTO agent_extension_package_compatibility
              (organization_id, package_version_id, min_runtime_version, max_runtime_version,
               supported_agent_audiences, supported_channels, constraints)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [organizationId, row.id, compatibility.minRuntimeVersion ?? null, compatibility.maxRuntimeVersion ?? null, compatibility.supportedAgentAudiences ?? [], compatibility.supportedChannels ?? [], JSON.stringify(compatibility.constraints ?? {})],
          );
        }
      }
      if (!created) {
        const existingPackage = await this.getPackageWithClient(client, organizationId, row.id);
        if (!existingPackage) throw new Error("EXTENSION_PACKAGE_CREATE_FAILED");
        return existingPackage;
      }
      return hydratePackage(row, dependencies.map((dependency) => ({
        organization_id: organizationId,
        package_version_id: row.id,
        dependency_kind: dependency.kind,
        dependency_id: dependency.id,
        version_constraint: dependency.versionConstraint ?? "*",
        required: dependency.required !== false,
        created_at: row.created_at,
      })), compatibility ? {
        organization_id: organizationId,
        package_version_id: row.id,
        min_runtime_version: compatibility.minRuntimeVersion ?? null,
        max_runtime_version: compatibility.maxRuntimeVersion ?? null,
        supported_agent_audiences: [...(compatibility.supportedAgentAudiences ?? [])],
        supported_channels: [...(compatibility.supportedChannels ?? [])],
        constraints: compatibility.constraints ?? {},
        created_at: row.created_at,
      } : null);
    });
  }

  public async getPackage(organizationId: string, packageVersionId: string): Promise<ExtensionPackageRecord | null> {
    return this.getPackageWithClient(this.pool, organizationId, packageVersionId);
  }

  public async listPackages(organizationId: string, kind?: ExtensionKind): Promise<ExtensionPackageRecord[]> {
    const result = await query<ExtensionPackageRow>(this.pool, `SELECT * FROM agent_extension_packages WHERE organization_id = $1 ${kind ? "AND kind = $2" : ""} ORDER BY package_id, version`, kind ? [organizationId, kind] : [organizationId]);
    return Promise.all(result.rows.map((row) => this.getPackageWithClient(this.pool, organizationId, row.id))).then((packages) => packages.filter((entry): entry is ExtensionPackageRecord => Boolean(entry)));
  }

  public async publishPackage(organizationId: string, actorId: string, packageVersionId: string): Promise<ExtensionPackageRecord> {
    return this.transitionPackage(organizationId, actorId, packageVersionId, "published");
  }

  public async deprecatePackage(organizationId: string, actorId: string, packageVersionId: string): Promise<ExtensionPackageRecord> {
    return this.transitionPackage(organizationId, actorId, packageVersionId, "deprecated");
  }

  public async revokePackage(organizationId: string, actorId: string, packageVersionId: string): Promise<ExtensionPackageRecord> {
    return this.transitionPackage(organizationId, actorId, packageVersionId, "revoked");
  }

  public async createSnapshot(organizationId: string, actorId: string, snapshot: ExtensionSnapshot): Promise<ExtensionSnapshotRecord> {
    if (!snapshot.agentVersionId.trim() || !snapshot.id.trim() || !/^[a-f0-9]{64}$/i.test(snapshot.checksum)) {
      throw new Error("EXTENSION_SNAPSHOT_INVALID");
    }
    return withTransaction(this.pool, async (client) => this.insertSnapshot(client, organizationId, actorId, snapshot));
  }

  private async resolveCanonicalPackages(
    executor: Pick<Pool, "query">,
    organizationId: string,
    references: readonly CanonicalPackageReference[],
    grants: readonly CanonicalPackageGrant[],
  ): Promise<{
    skills: SkillExtensionDeclaration[];
    plugins: PluginExtensionDeclaration[];
    selectedPackages: SelectedExtensionPackage[];
    grantedSkillIds: string[];
    grantedPluginIds: string[];
  }> {
    if (references.length === 0 && grants.length === 0) {
      return { skills: [], plugins: [], selectedPackages: [], grantedSkillIds: [], grantedPluginIds: [] };
    }

    const selected = new Map<string, CanonicalPackageReference>();
    for (const reference of references) {
      if (reference.kind === "mcp_adapter") {
        // The current database and immutable snapshot contracts use
        // `mcp_capability`; coercing a canonical adapter would change its
        // identity and make the AgentSpec selection unverifiable.
        throw new Error("EXTENSION_SNAPSHOT_MCP_ADAPTER_UNSUPPORTED");
      }
      const key = packageIdentity(reference.kind, reference.id);
      if (selected.has(key)) throw new Error(`EXTENSION_SNAPSHOT_CANONICAL_PACKAGE_DUPLICATE:${key}`);
      selected.set(key, reference);
    }
    const grantByKey = new Map<string, CanonicalPackageGrant>();
    for (const grant of grants) {
      if (grant.kind === "mcp_adapter") throw new Error("EXTENSION_SNAPSHOT_MCP_ADAPTER_UNSUPPORTED");
      const key = packageIdentity(grant.kind, grant.id);
      if (!selected.has(key)) throw new Error(`EXTENSION_SNAPSHOT_GRANT_NOT_SELECTED:${key}`);
      if (grantByKey.has(key)) throw new Error(`EXTENSION_SNAPSHOT_CANONICAL_GRANT_DUPLICATE:${key}`);
      grantByKey.set(key, grant);
    }

    if (references.length === 0) {
      return { skills: [], plugins: [], selectedPackages: [], grantedSkillIds: [], grantedPluginIds: [] };
    }

    const predicates = references.map((_, index) => {
      const offset = 2 + index * 3;
      return `(kind = $${offset} AND package_id = $${offset + 1} AND version = $${offset + 2})`;
    });
    const values: unknown[] = [organizationId];
    for (const reference of references) values.push(reference.kind, reference.id, reference.version);
    const packageResult = await executor.query<ExtensionPackageRow>(
      `SELECT * FROM agent_extension_packages
       WHERE organization_id = $1 AND (${predicates.join(" OR ")})
       ORDER BY package_id, version`,
      values,
    );
    const rowsByKey = new Map<string, ExtensionPackageRow>();
    for (const row of packageResult.rows) {
      if (row.organization_id !== organizationId) throw new Error("EXTENSION_SNAPSHOT_PACKAGE_ORGANIZATION_MISMATCH");
      const key = packageIdentity(row.kind, row.package_id);
      if (rowsByKey.has(key)) throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_VERSION_AMBIGUOUS:${key}`);
      rowsByKey.set(key, row);
    }

    const skills: SkillExtensionDeclaration[] = [];
    const plugins: PluginExtensionDeclaration[] = [];
    const selectedPackages: SelectedExtensionPackage[] = [];
    const grantedSkillIds: string[] = [];
    const grantedPluginIds: string[] = [];
    for (const reference of references) {
      const key = packageIdentity(reference.kind, reference.id);
      const row = rowsByKey.get(key);
      if (!row) throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_NOT_FOUND:${key}:${reference.version}`);
      if (row.version !== reference.version) throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_VERSION_MISMATCH:${key}`);
      if (row.checksum.toLowerCase() !== reference.checksum.toLowerCase()) {
        throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_CHECKSUM_MISMATCH:${key}`);
      }
      if (row.status === "revoked") throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_REVOKED:${key}`);
      if (row.status !== "published" && row.status !== "deprecated") {
        throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_NOT_PUBLISHED:${key}`);
      }
      const declaration = parseJson(row.declaration);
      if (!isRecord(declaration)
        || declaration.kind !== reference.kind
        || declaration.id !== reference.id
        || declaration.version !== reference.version
        || typeof declaration.checksum !== "string"
        || declaration.checksum.toLowerCase() !== reference.checksum.toLowerCase()) {
        throw new Error(`EXTENSION_SNAPSHOT_PACKAGE_DECLARATION_MISMATCH:${key}`);
      }
      if (reference.kind === "skill") skills.push(declaration as SkillExtensionDeclaration);
      if (reference.kind === "plugin") plugins.push(declaration as PluginExtensionDeclaration);
      const grant = grantByKey.get(key);
      selectedPackages.push({
        organizationId,
        packageVersionId: row.id,
        kind: reference.kind,
        id: reference.id,
        version: reference.version,
        checksum: reference.checksum.toLowerCase(),
        status: row.status,
        configuration: { ...reference.configuration },
        grantedPermissions: grant?.permissions ?? [],
      });
      if (grant?.kind === "skill") grantedSkillIds.push(grant.id);
      if (grant?.kind === "plugin") grantedPluginIds.push(grant.id);
    }
    return { skills, plugins, selectedPackages, grantedSkillIds, grantedPluginIds };
  }

  /**
   * Resolve a version's currently pinned declarative extensions and persist
   * the result in the caller's transaction. Publication and run admission
   * use this method so the version pin and snapshot cannot drift apart.
   */
  public async ensureSnapshotForVersion(
    executor: Pick<Pool, "query">,
    organizationId: string,
    actorId: string,
    agentVersionId: string,
  ): Promise<ExtensionSnapshotRecord> {
    const versionResult = await executor.query<VersionExtensionSource>(
      `SELECT version.id, version.configuration, version.policy
       FROM agent_versions version
       JOIN agent_definitions definition ON definition.id = version.agent_definition_id
       WHERE version.id = $2 AND definition.organization_id = $1`,
      [organizationId, agentVersionId],
    );
    const version = versionResult.rows[0];
    if (!version) throw new Error("EXTENSION_SNAPSHOT_VERSION_NOT_FOUND");
    const skillResult = await executor.query<{
      skill_definition_id: string;
      version_number: number;
      checksum: string;
      skill_name: string | null;
      required_capabilities: string[] | null;
      required_connectors: string[] | null;
    }>(
      `SELECT skill_version.skill_definition_id, skill_version.version_number,
              skill_version.checksum, skill.name AS skill_name,
              skill_version.required_capabilities, skill_version.required_connectors
       FROM agent_version_skills pin
       JOIN agent_skill_versions skill_version ON skill_version.id = pin.skill_version_id
       JOIN agent_skill_definitions skill ON skill.id = skill_version.skill_definition_id
       WHERE pin.organization_id = $1 AND pin.agent_version_id = $2
         AND skill_version.status = 'published' AND skill.status = 'published'
       ORDER BY skill_version.skill_definition_id`,
      [organizationId, agentVersionId],
    );
    const mcpResult = await executor.query<PinnedMcpCapabilityRow>(
      `SELECT pin.provider_version_id,
              provider_version.provider_id,
              provider.name AS provider_name,
              provider.status AS provider_status,
              provider.health_status,
              provider_version.revision,
              provider_version.status,
              provider_version.protocol_version,
              provider_version.tools,
              provider_version.checksum
       FROM agent_version_mcp_providers pin
       JOIN agent_mcp_provider_versions provider_version
         ON provider_version.id = pin.provider_version_id
        AND provider_version.organization_id = pin.organization_id
       JOIN agent_mcp_providers provider
         ON provider.id = provider_version.provider_id
        AND provider.organization_id = pin.organization_id
       WHERE pin.organization_id = $1 AND pin.agent_version_id = $2
       ORDER BY provider.name, provider_version.revision`,
      [organizationId, agentVersionId],
    );
    const extension = extensionConfig(version);
    const canonical = await this.resolveCanonicalPackages(executor, organizationId, extension.packages, extension.packageGrants);
    const pinnedSkillDeclarations: SkillExtensionDeclaration[] = skillResult.rows.map((skill) => ({
      kind: "skill",
      id: skill.skill_definition_id,
      version: `${skill.version_number}.0.0`,
      checksum: skill.checksum,
      ...(skill.skill_name ? { name: skill.skill_name } : {}),
      available: true,
      installed: true,
      configured: true,
      requiredCapabilityIds: skill.required_capabilities ?? [],
      requiredConnectorIds: skill.required_connectors ?? [],
    }));
    const skillDeclarations = mergeExtensionDeclarations("skill", pinnedSkillDeclarations, canonical.skills);
    const plugins = mergeExtensionDeclarations("plugin", extension.plugins, canonical.plugins);
    const connectors = mergeExtensionDeclarations("connector", extension.connectors);
    const pinnedMcpCapabilities = pinnedMcpDeclarations(mcpResult.rows);
    const mcpCapabilities = mergeExtensionDeclarations("mcp_capability", extension.mcpCapabilities, pinnedMcpCapabilities);
    const policy = parseJson(version.policy);
    const requestedSkills = isRecord(policy) && Array.isArray(policy.allowedSkillIds)
      ? policy.allowedSkillIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const snapshot = new ExtensionResolver().resolveForPublication({
      agentVersionId,
      skills: skillDeclarations,
      plugins,
      connectors,
      mcpCapabilities,
      grants: {
        skillIds: [...new Set([...pinnedSkillDeclarations.map((skill) => skill.id), ...requestedSkills, ...extension.grants.skillIds, ...canonical.grantedSkillIds])],
        pluginIds: [...new Set([...extension.grants.pluginIds, ...canonical.grantedPluginIds])],
        connectorIds: extension.grants.connectorIds,
        capabilityIds: [...new Set([...extension.grants.capabilityIds, ...pinnedMcpCapabilities.map((capability) => capability.id)])],
      },
      selectedPackages: canonical.selectedPackages,
    });
    return this.insertSnapshot(executor, organizationId, actorId, snapshot);
  }

  private async insertSnapshot(
    executor: Pick<Pool, "query">,
    organizationId: string,
    actorId: string,
    snapshot: ExtensionSnapshot,
  ): Promise<ExtensionSnapshotRecord> {
      const inserted = await executor.query<ExtensionSnapshotRow>(
        `INSERT INTO agent_extension_snapshots
          (organization_id, agent_version_id, snapshot_key, checksum, snapshot, created_by)
         SELECT $1, version.id, $3, $4, $5::jsonb, $6
         FROM agent_versions version
         JOIN agent_definitions definition ON definition.id = version.agent_definition_id
         WHERE version.id = $2 AND definition.organization_id = $1
         ON CONFLICT (organization_id, agent_version_id, checksum) DO NOTHING
         RETURNING *`,
        [organizationId, snapshot.agentVersionId, snapshot.id, snapshot.checksum, JSON.stringify(snapshot), actorId],
      );
      if (inserted.rows[0]) return hydrateSnapshot(inserted.rows[0]);
      const existing = await executor.query<ExtensionSnapshotRow>(
        `SELECT * FROM agent_extension_snapshots
         WHERE organization_id = $1 AND agent_version_id = $2 AND checksum = $3`,
        [organizationId, snapshot.agentVersionId, snapshot.checksum],
      );
      if (!existing.rows[0]) throw new Error("EXTENSION_SNAPSHOT_CREATE_FAILED");
      return hydrateSnapshot(existing.rows[0]);
  }

  public async getSnapshot(organizationId: string, snapshotId: string): Promise<ExtensionSnapshotRecord | null> {
    const result = await query<ExtensionSnapshotRow>(this.pool, "SELECT * FROM agent_extension_snapshots WHERE organization_id = $1 AND id = $2", [organizationId, snapshotId]);
    return result.rows[0] ? hydrateSnapshot(result.rows[0]) : null;
  }

  /**
   * Validate the immutable snapshot pin used to admit a run.
   *
   * This is intentionally a read of the already-pinned version and snapshot
   * only. It must not call ensureSnapshotForVersion(), because that method
   * resolves the current mutable version configuration and is appropriate for
   * publication, not for admitting a run against an existing version.
   */
  public async getVersionAdmissionSnapshot(
    executor: Pick<Pool, "query">,
    organizationId: string,
    agentVersionId: string,
    snapshotId: string,
  ): Promise<ExtensionSnapshotRecord | null> {
    const result = await executor.query<ExtensionSnapshotRow>(
      `SELECT snapshot.*
       FROM agent_versions version
       JOIN agent_definitions definition ON definition.id = version.agent_definition_id
       JOIN agent_extension_snapshots snapshot
         ON snapshot.id = version.extension_snapshot_id
        AND snapshot.agent_version_id = version.id
        AND snapshot.organization_id = definition.organization_id
       WHERE definition.organization_id = $1
         AND version.id = $2
         AND version.extension_snapshot_id = $3
       FOR SHARE OF version, snapshot`,
      [organizationId, agentVersionId, snapshotId],
    );
    return result.rows[0] ? hydrateSnapshot(result.rows[0]) : null;
  }

  public async pinVersion(organizationId: string, actorId: string, agentVersionId: string, snapshotId: string): Promise<ExtensionSnapshotRecord> {
    const result = await query<{ extension_snapshot_id: string }>(
      this.pool,
      `UPDATE agent_versions version
       SET extension_snapshot_id = $4
       FROM agent_definitions definition
       JOIN agent_extension_snapshots snapshot ON snapshot.id = $4
       WHERE version.id = $3
         AND definition.id = version.agent_definition_id
         AND definition.organization_id = $1
         AND snapshot.organization_id = $1
         AND snapshot.agent_version_id = version.id
         AND version.status = 'draft'
         AND (version.extension_snapshot_id IS NULL OR version.extension_snapshot_id = $4)
       RETURNING version.extension_snapshot_id`,
      [organizationId, actorId, agentVersionId, snapshotId],
    );
    if (!result.rows[0]) throw new Error("EXTENSION_SNAPSHOT_VERSION_PIN_FAILED");
    const snapshot = await this.getSnapshot(organizationId, result.rows[0].extension_snapshot_id);
    if (!snapshot) throw new Error("EXTENSION_SNAPSHOT_PIN_NOT_FOUND");
    return snapshot;
  }

  /**
   * Reads only the snapshot already captured by run admission. It deliberately
   * does not resolve the current version or package catalog, so publishing or
   * revoking an extension cannot rewrite an active run's meaning.
   */
  public async getRunAdmissionSnapshot(organizationId: string, runId: string): Promise<ExtensionSnapshotRecord | null> {
    const result = await query<ExtensionSnapshotRow>(
      this.pool,
      `SELECT snapshot.*
       FROM agent_runs run
       JOIN agent_versions version ON version.id = run.agent_version_id
       JOIN agent_extension_snapshots snapshot ON snapshot.id = run.extension_snapshot_id
       JOIN agent_definitions definition ON definition.id = version.agent_definition_id
       WHERE run.id = $2
         AND run.organization_id = $1
         AND definition.organization_id = $1
         AND snapshot.organization_id = $1
         AND snapshot.agent_version_id = version.id
         AND version.extension_snapshot_id = run.extension_snapshot_id`,
      [organizationId, runId],
    );
    return result.rows[0] ? hydrateSnapshot(result.rows[0]) : null;
  }

  private async getPackageWithClient(executor: Pick<Pool, "query">, organizationId: string, packageVersionId: string): Promise<ExtensionPackageRecord | null> {
    const packageResult = await executor.query<ExtensionPackageRow>("SELECT * FROM agent_extension_packages WHERE organization_id = $1 AND id = $2", [organizationId, packageVersionId]);
    const row = packageResult.rows[0];
    if (!row) return null;
    const [dependencies, compatibility] = await Promise.all([
      executor.query<ExtensionPackageDependencyRecord>("SELECT * FROM agent_extension_package_dependencies WHERE organization_id = $1 AND package_version_id = $2 ORDER BY dependency_kind, dependency_id", [organizationId, packageVersionId]),
      executor.query<ExtensionPackageCompatibilityRecord>("SELECT * FROM agent_extension_package_compatibility WHERE organization_id = $1 AND package_version_id = $2", [organizationId, packageVersionId]),
    ]);
    return hydratePackage(row, dependencies.rows, compatibility.rows[0] ?? null);
  }

  private async transitionPackage(organizationId: string, actorId: string, packageVersionId: string, status: "published" | "deprecated" | "revoked"): Promise<ExtensionPackageRecord> {
    return withTransaction(this.pool, async (client) => {
      if (status === "published") {
        const unresolved = await client.query(
          `SELECT dependency.dependency_id
           FROM agent_extension_package_dependencies dependency
           WHERE dependency.organization_id = $1
             AND dependency.package_version_id = $2
             AND dependency.required = TRUE
             AND NOT EXISTS (
               SELECT 1 FROM agent_extension_packages candidate
               WHERE candidate.organization_id = $1
                 AND candidate.kind = dependency.dependency_kind
                 AND candidate.package_id = dependency.dependency_id
                 AND candidate.status IN ('published', 'deprecated')
                 AND (dependency.version_constraint = '*' OR candidate.version = dependency.version_constraint)
             )`,
          [organizationId, packageVersionId],
        );
        if (unresolved.rows.length) throw new Error("EXTENSION_PACKAGE_DEPENDENCY_NOT_PUBLISHED");
      }
      const timestampColumn = status === "published" ? "published_at" : status === "deprecated" ? "deprecated_at" : "revoked_at";
      const statusPredicate = status === "revoked" ? "status <> 'revoked'" : "status = $4";
      const values = status === "revoked"
        ? [organizationId, packageVersionId, status]
        : [organizationId, packageVersionId, status, status === "published" ? "draft" : "published"];
      const result = await client.query<ExtensionPackageRow>(
        `UPDATE agent_extension_packages
         SET status = $3, ${timestampColumn} = COALESCE(${timestampColumn}, now())
         WHERE organization_id = $1 AND id = $2
           AND ${statusPredicate}
         RETURNING *`,
        values,
      );
      if (!result.rows[0]) throw new Error("EXTENSION_PACKAGE_LIFECYCLE_TRANSITION_FAILED");
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, $3, 'agent_extension_package', $4, '{}'::jsonb)`,
        [organizationId, actorId, `agent_extension_package.${status}`, packageVersionId],
      );
      return this.getPackageWithClient(client, organizationId, packageVersionId) as Promise<ExtensionPackageRecord>;
    });
  }
}
