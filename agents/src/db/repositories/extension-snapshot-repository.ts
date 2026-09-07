import type { Pool } from "pg";
import { ExtensionResolver, type ConnectorExtensionDeclaration, type ExtensionDeclarationBase, type ExtensionKind, type ExtensionSnapshot, type McpCapabilityDeclaration, type PluginExtensionDeclaration, type SkillExtensionDeclaration } from "../../extensions";
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
} {
  const configuration = parseJson(source.configuration);
  const policy = parseJson(source.policy);
  const raw = isRecord(configuration.extensions) ? configuration.extensions : isRecord(policy.extensions) ? policy.extensions : {};
  const rawGrants = isRecord(raw.grants) ? raw.grants : {};
  const list = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim()))]
    : [];
  return {
    plugins: extensionList<PluginExtensionDeclaration>(raw.plugins, "plugin"),
    connectors: extensionList<ConnectorExtensionDeclaration>(raw.connectors, "connector"),
    mcpCapabilities: extensionList<McpCapabilityDeclaration>(raw.mcpCapabilities, "mcp_capability"),
    grants: {
      skillIds: list(rawGrants.skillIds),
      pluginIds: list(rawGrants.pluginIds),
      connectorIds: list(rawGrants.connectorIds),
      capabilityIds: list(rawGrants.capabilityIds),
    },
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
    const extension = extensionConfig(version);
    const skillDeclarations: SkillExtensionDeclaration[] = skillResult.rows.map((skill) => ({
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
    const policy = parseJson(version.policy);
    const requestedSkills = isRecord(policy) && Array.isArray(policy.allowedSkillIds)
      ? policy.allowedSkillIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const snapshot = new ExtensionResolver().resolve({
      agentVersionId,
      skills: skillDeclarations,
      plugins: extension.plugins,
      connectors: extension.connectors,
      mcpCapabilities: extension.mcpCapabilities,
      grants: {
        skillIds: [...new Set([...skillDeclarations.map((skill) => skill.id), ...requestedSkills, ...extension.grants.skillIds])],
        pluginIds: extension.grants.pluginIds,
        connectorIds: extension.grants.connectorIds,
        capabilityIds: extension.grants.capabilityIds,
      },
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
