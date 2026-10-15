import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AgentAudience,
  AgentExecutionMode,
  AgentReleaseMode,
  CreateAgentInput,
  CreateExternalAgentInput,
  CreateInstallationInput,
  DeployInstallationInput,
  CreateVersionInput,
  HostedAgentCreationProfile,
  InstallationDeploymentPreflightInput,
  InstallationPromotionInput,
  InstallationRollbackInput,
  StudioAgentCreationInput,
  UpdateAgentInput,
} from "../../domain/types";
import { query, withTransaction } from "../pool";
import { assertAgentReleaseMode, defaultAgentReleaseMode } from "../../domain/release-mode";
import { validateVersionWorkflow } from "../../workflows/graph";
import { normalizeModelPolicy } from "../../model/policy";
import { getAgentTemplate, templateVersionInput } from "../../system/templates";
import { CUSTOMER_SERVICE_HANDOFF_TOOL, LEGACY_CUSTOMER_SERVICE_HANDOFF_TOOL, resolveHostedAgentAllowedTools } from "../../system/hosted-agent-defaults";
import { KASIAI_KNOWLEDGE_CHUNKS, KASIAI_KNOWLEDGE_SOURCE_NAME, KASIAI_KNOWLEDGE_VERSION } from "../../system/kasiai-knowledge";
import { KASIAI_EVALUATION_SCENARIOS, KASIAI_EVALUATION_VERSION } from "../../system/kasiai-evaluations";
import { createInstallationCredentialInTransaction, type CreatedInstallationCredential } from "./installation-credential-repository";
import { buildDefinitionLifecycleEvent, buildInstallationLifecycleEvent, buildVersionLifecycleEvent, enqueueOutbox, type DefinitionLifecycleAnalyticsInput, type InstallationLifecycleAnalyticsInput, type VersionLifecycleAnalyticsInput } from "../../analytics";
import { AgentDeploymentModule, type DeploymentActivationResult, type DeploymentPreflightResult, type DeploymentVersionProjection } from "./agent-deployment-repository";
import { ExtensionSnapshotRepository } from "./extension-snapshot-repository";
import { parseAgentEnvironment, type AgentEnvironment } from "../../runtime/execution-environment";

type DbExecutor = Pool | PoolClient;

export const SYSTEM_ORGANIZATION_ID = "kasitek-system";

function normalizeInstallationSettings(
  settings: Record<string, unknown> | undefined,
  defaultEnvironment: AgentEnvironment = "live",
): Record<string, unknown> {
  return {
    ...(settings ?? {}),
    environment: parseAgentEnvironment(settings?.environment ?? defaultEnvironment),
  };
}

export interface AgentRecord {
  id: string;
  organization_id: string;
  owner_type: string;
  name: string;
  slug: string;
  description: string | null;
  creation_profile: HostedAgentCreationProfile | "system";
  agent_audience: AgentAudience;
  status: string;
  protected: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  installation_id?: string | null;
  execution_mode?: AgentExecutionMode | null;
  installation_status?: string | null;
  installation_settings?: Record<string, unknown> | null;
  installation_version_id?: string | null;
  published_version_id?: string | null;
  version_number?: number | null;
  published_version_number?: number | null;
}

export interface AgentVersionRecord {
  id: string;
  agent_definition_id: string;
  version_number: number;
  status: string;
  instructions: string;
  configuration: Record<string, unknown>;
  policy: Record<string, unknown>;
  checksum: string;
  extension_snapshot_id?: string | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
}

export type PlaygroundExtensionActivation =
  | {
      kind: "plugin";
      package: {
        id: string;
        version: string;
        checksum: string;
        configuration?: Record<string, unknown>;
      };
    }
  | { kind: "skill"; skillVersionId: string }
  | { kind: "mcp"; providerVersionId: string };

export interface PlaygroundExtensionActivationResult {
  installation: InstallationRecord;
  version: AgentVersionRecord;
  createdCandidate: boolean;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJson(nested)]),
    );
  }
  return value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function addPluginPackageSelection(
  configurationValue: unknown,
  policyValue: unknown,
  selection: Extract<PlaygroundExtensionActivation, { kind: "plugin" }>['package'],
): { configuration: Record<string, unknown>; policy: Record<string, unknown>; changed: boolean } {
  const configuration = { ...recordValue(configurationValue) };
  const existingConfigurationExtensions = recordValue(configuration.extensions);
  const packages = Array.isArray(existingConfigurationExtensions.packages)
    ? existingConfigurationExtensions.packages.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
  const alreadySelected = packages.some((entry) => entry.kind === "plugin" && entry.id === selection.id && entry.version === selection.version && entry.checksum === selection.checksum);
  const nextPackages = alreadySelected
    ? packages
    : [...packages, {
        kind: "plugin",
        id: selection.id,
        version: selection.version,
        checksum: selection.checksum,
        configuration: { ...(selection.configuration ?? {}) },
      }];

  const policy = { ...recordValue(policyValue) };
  const policyExtensions = { ...recordValue(policy.extensions) };
  const rawPolicyGrants = policyExtensions.grants;
  const packageGrant = { kind: "plugin", id: selection.id, permissions: [] };
  let nextPolicyGrants: unknown[];
  let alreadyGranted = false;
  if (Array.isArray(rawPolicyGrants)) {
    const grants = rawPolicyGrants.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
    alreadyGranted = grants.some((entry) => entry.kind === "plugin" && entry.id === selection.id);
    nextPolicyGrants = alreadyGranted
      ? grants
      : [...grants, packageGrant];
  } else {
    // Legacy extension grants use an object keyed by declaration kind. Keep
    // those IDs in the configuration projection while using the canonical
    // package-grant array for the selected package itself.
    const configurationGrants = recordValue(existingConfigurationExtensions.grants);
    const legacyGrants = recordValue(rawPolicyGrants);
    const pluginIds = [...new Set([
      ...(Array.isArray(configurationGrants.pluginIds) ? configurationGrants.pluginIds.filter((entry): entry is string => typeof entry === "string") : []),
      ...(Array.isArray(legacyGrants.pluginIds) ? legacyGrants.pluginIds.filter((entry): entry is string => typeof entry === "string") : []),
      selection.id,
    ])];
    existingConfigurationExtensions.grants = { ...configurationGrants, ...(pluginIds.length ? { pluginIds } : {}) };
    nextPolicyGrants = [packageGrant];
  }
  policyExtensions.grants = nextPolicyGrants;
  configuration.extensions = { ...existingConfigurationExtensions, packages: nextPackages };
  policy.extensions = policyExtensions;
  return {
    configuration,
    policy,
    changed: !alreadySelected || !alreadyGranted,
  };
}

export function agentVersionContentMatches(
  current: Pick<AgentVersionRecord, "instructions" | "configuration" | "policy">,
  input: CreateVersionInput,
): boolean {
  return current.instructions === input.instructions
    && JSON.stringify(canonicalizeJson(current.configuration)) === JSON.stringify(canonicalizeJson(input.configuration))
    && JSON.stringify(canonicalizeJson(current.policy)) === JSON.stringify(canonicalizeJson(input.policy));
}

export interface InstallationRecord {
  id: string;
  agent_definition_id: string;
  agent_version_id: string;
  organization_id: string;
  scope_type: string;
  scope_id: string;
  status: string;
  execution_mode: AgentExecutionMode;
  settings: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  release_mode: AgentReleaseMode;
}

export interface InstallationIdentity {
  agent_owner_type: string;
  agent_protected: boolean;
  agent_slug: string;
  agent_audience: AgentAudience;
}

export interface SystemInstallationRecord extends InstallationRecord {
  agent_name: string;
  agent_slug: string;
  agent_protected: boolean;
  version_number: number;
  created: boolean;
}

export interface SystemAgentReleaseStatus {
  agentId: string | null;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  publishedContentMatches: boolean;
  activeInstallationCount: number;
  matchingInstallationCount: number;
  staleInstallationCount: number;
}

export interface AgentDeploymentStatus {
  agentId: string;
  state: "pending" | "ready" | "blocked" | "deployed" | "rollback_available";
  status: "pending" | "ready" | "blocked" | "deployed" | "rollback_available";
  playground: {
    installationId: string | null;
    status: string | null;
    version: DeploymentVersionProjection | null;
    capabilityConfigurationDigest: string | null;
  };
  live: {
    installationId: string | null;
    status: string | null;
    version: DeploymentVersionProjection | null;
    capabilityConfigurationDigest: string | null;
  };
  rollbackTarget: DeploymentVersionProjection | null;
  latestPromotion: {
    id: string;
    candidateVersionId: string | null;
    previousVersionId: string | null;
    sourceInstallationId: string | null;
    capabilityConfigurationDigest: string | null;
    bindingRevision: string | null;
    createdAt: string;
  } | null;
}

export interface TemplateInstallationRecord {
  agent: AgentRecord;
  version: AgentVersionRecord;
  installation: InstallationRecord;
  templateKey: string;
  templateVersion: number;
  created: boolean;
}

export interface ExternalAgentConnectionRecord {
  agent: AgentRecord;
  version: AgentVersionRecord;
  installation: InstallationRecord;
  created: boolean;
  credential?: CreatedInstallationCredential;
}

export interface AgentDeletionResult {
  agentId: string;
  installationIds: string[];
  deleted: boolean;
  status: "deleted" | "queued";
  deletionJobId?: string;
}

interface InstallationAnalyticsRow extends InstallationRecord {
  creation_profile: HostedAgentCreationProfile | "system";
  agent_audience: AgentAudience;
}

interface DeploymentStatusRow {
  agent_id: string;
  playground_installation_id: string | null;
  playground_status: string | null;
  playground_version_id: string | null;
  playground_version_number: number | null;
  playground_version_status: string | null;
  playground_digest: string | null;
  playground_extension_snapshot_id: string | null;
  playground_extension_snapshot_checksum: string | null;
  live_installation_id: string | null;
  live_status: string | null;
  live_version_id: string | null;
  live_version_number: number | null;
  live_version_status: string | null;
  live_digest: string | null;
  live_extension_snapshot_id: string | null;
  live_extension_snapshot_checksum: string | null;
  latest_promotion_id: string | null;
  latest_candidate_version_id: string | null;
  latest_previous_version_id: string | null;
  latest_source_installation_id: string | null;
  latest_capability_configuration_digest: string | null;
  latest_binding_revision: string | null;
  latest_promotion_created_at: string | null;
  rollback_version_id: string | null;
  rollback_version_number: number | null;
  rollback_version_status: string | null;
  rollback_digest: string | null;
  rollback_extension_snapshot_id: string | null;
  rollback_extension_snapshot_checksum: string | null;
}

function projectDeploymentVersionRow(row: {
  version_id: string;
  version_number: number | null;
  status: string | null;
  checksum: string | null;
  extension_snapshot_id: string | null;
  extension_snapshot_checksum: string | null;
}): DeploymentVersionProjection {
  return {
    versionId: row.version_id,
    versionNumber: Number(row.version_number ?? 0),
    status: row.status ?? "unknown",
    digest: row.checksum ?? "",
    extensionSnapshotId: row.extension_snapshot_id,
    extensionSnapshotChecksum: row.extension_snapshot_checksum,
  };
}

type CreateSystemAgentInput = Omit<CreateAgentInput, "creationProfile"> & { creationProfile?: HostedAgentCreationProfile };

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Returns a stable, database-safe slug candidate for an automatically named agent.
 * Keep the base slug bounded so the suffix never pushes it past the API limit.
 */
export function agentSlugCandidate(baseSlug: string, attempt: number): string {
  if (attempt <= 1) return baseSlug.slice(0, 80);
  const suffix = `-${attempt}`;
  return `${baseSlug.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
}

function checksumVersion(input: CreateVersionInput, versionNumber: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...input, versionNumber }))
    .digest("hex");
}

export class AgentRepository {
  private readonly deploymentModule = new AgentDeploymentModule();

  public constructor(
    private readonly pool: Pool,
    extensionSnapshots?: ExtensionSnapshotRepository,
  ) {
    // Publication and run admission must never silently proceed without the
    // immutable extension-snapshot boundary. Keep the constructor convenient
    // for existing callers while making the reconciler mandatory in practice.
    this.extensionSnapshots = extensionSnapshots ?? new ExtensionSnapshotRepository(pool);
  }

  private readonly extensionSnapshots: ExtensionSnapshotRepository;

  private async ensureVersionExtensionSnapshot(
    client: PoolClient,
    organizationId: string,
    actorId: string,
    agentDefinitionId: string,
    versionId: string,
  ): Promise<AgentVersionRecord | undefined> {
    const snapshot = await this.extensionSnapshots.ensureSnapshotForVersion(client, organizationId, actorId, versionId);
    const pinned = await client.query<AgentVersionRecord>(
      `UPDATE agent_versions
       SET extension_snapshot_id = $3
       WHERE id = $1
         AND agent_definition_id = $2
         AND (extension_snapshot_id IS NULL OR extension_snapshot_id = $3)
       RETURNING *`,
      [versionId, agentDefinitionId, snapshot.id],
    );
    if (!pinned.rows[0]) throw new Error("EXTENSION_SNAPSHOT_VERSION_PIN_FAILED");
    return pinned.rows[0];
  }

  private async assertHostedDefinition(client: PoolClient, organizationId: string, agentId: string): Promise<void> {
    const result = await client.query<{ execution_mode: AgentExecutionMode }>(
      `SELECT ai.execution_mode
       FROM agent_installations ai
       WHERE ai.organization_id = $1 AND ai.agent_definition_id = $2
       ORDER BY ai.updated_at DESC
       LIMIT 1`,
      [organizationId, agentId],
    );
    if (result.rows[0]?.execution_mode === "external_connected") {
      throw new Error("External-connected definitions cannot use hosted agent editing");
    }
  }

  public async createAgent(
    organizationId: string,
    actorId: string,
    input: CreateAgentInput,
  ): Promise<AgentRecord> {
    const isProtected = input.protected ?? false;
    if (isProtected) throw new Error("Only system-owned agents may be protected");
    const requestedSlug = input.slug ?? slugify(input.name);
    if (!requestedSlug) {
      throw Object.assign(new Error("The agent name must contain letters or numbers"), { statusCode: 400, code: "AGENT_SLUG_INVALID" });
    }
    const autogeneratedSlug = input.slug === undefined;
    return withTransaction(this.pool, async (client) => {
      const insert = (slug: string, onConflictDoNothing: boolean) => client.query<AgentRecord>(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, creation_profile, agent_audience, protected, created_by)
         VALUES ($1, 'organization', $2, $3, $4, $5, $6, $7, $8)
         ${onConflictDoNothing ? "ON CONFLICT (organization_id, slug) DO NOTHING" : ""}
         RETURNING *`,
        [organizationId, input.name, slug, input.description ?? null, input.creationProfile ?? "custom", input.agentAudience ?? "personal", isProtected, actorId],
      );

      let agent: AgentRecord | undefined;
      if (autogeneratedSlug) {
        for (let attempt = 1; attempt <= 100; attempt += 1) {
          const result = await insert(agentSlugCandidate(requestedSlug, attempt), true);
          agent = result.rows[0];
          if (agent) break;
        }
        if (!agent) {
          throw Object.assign(new Error("Could not allocate a unique agent slug"), { statusCode: 409, code: "AGENT_SLUG_UNAVAILABLE" });
        }
      } else {
        const result = await insert(requestedSlug, false);
        agent = result.rows[0];
      }
      const createdAgent = agent;
      if (!createdAgent) throw new Error("Agent creation did not return a definition");
      await this.enqueueDefinitionLifecycle(client, organizationId, createdAgent, "created", "active", [], "human", createdAgent.created_at);
      return createdAgent;
    });
  }

  /**
   * Create the first Studio agent as one platform operation.
   *
   * The public repository methods remain independently useful for advanced
   * management flows, but the Studio should not have to coordinate definition,
   * version, publication, and Playground installation from the browser. The
   * compensation path removes the incomplete definition if a later stage
   * fails, so a rejected Studio setup does not leave an unusable agent behind.
   */
  public async createStudioAgent(
    organizationId: string,
    actorId: string,
    input: StudioAgentCreationInput,
    versionInput: CreateVersionInput,
  ): Promise<{ agent: AgentRecord; version: AgentVersionRecord; installation: InstallationRecord }> {
    const agent = await this.createAgent(organizationId, actorId, {
      name: input.name,
      description: input.description,
      creationProfile: "custom",
      agentAudience: "personal",
      protected: false,
    });

    try {
      const draft = await this.createVersion(organizationId, actorId, agent.id, versionInput);
      const version = await this.publishVersion(organizationId, actorId, agent.id, draft.id);
      const installation = await this.createInstallation(organizationId, actorId, {
        agentVersionId: version.id,
        scopeType: "organization",
        settings: {
          environment: "playground",
          source: "studio",
          executionProfile: "autonomous",
        },
        executionMode: "kasitek_hosted",
        releaseMode: "pinned",
      });
      // Every hosted agent has a separate Live target from its first
      // published candidate. Future edits update Playground only; the
      // explicit promotion contract moves the pinned Live pointer.
      await this.createInstallation(organizationId, actorId, {
        agentVersionId: version.id,
        scopeType: "organization",
        settings: {
          environment: "live",
          source: "studio",
          executionProfile: "autonomous",
          bindingRevision: "initial",
          bindingStatus: "ready",
        },
        executionMode: "kasitek_hosted",
        releaseMode: "pinned",
      });
      return { agent, version, installation };
    } catch (error) {
      await this.deleteAgent(organizationId, actorId, agent.id).catch(() => undefined);
      throw error;
    }
  }

  public async updateAgent(
    organizationId: string,
    actorId: string,
    agentId: string,
    input: UpdateAgentInput,
  ): Promise<AgentRecord> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<AgentRecord>(
        `SELECT * FROM agent_definitions
         WHERE id = $1 AND organization_id = $2 AND owner_type = 'organization' AND protected = FALSE
         FOR UPDATE`,
        [agentId, organizationId],
      );
      const agent = existing.rows[0];
      if (!agent) throw Object.assign(new Error("Agent not found"), { statusCode: 404, code: "AGENT_NOT_FOUND" });

      const name = input.name ?? agent.name;
      const slug = input.slug ?? (input.name ? slugify(name) : agent.slug);
      if (!slug) throw Object.assign(new Error("The agent name must contain letters or numbers"), { statusCode: 400, code: "AGENT_SLUG_INVALID" });
      const description = input.description === undefined ? agent.description : input.description || null;
      const changedFields: DefinitionLifecycleAnalyticsInput["changedFields"] = [
        ...(name !== agent.name ? ["name" as const] : []),
        ...(slug !== agent.slug ? ["slug" as const] : []),
        ...(description !== agent.description ? ["description" as const] : []),
      ];
      const conflict = await client.query<{ id: string }>(
        `SELECT id FROM agent_definitions
         WHERE organization_id = $1 AND slug = $2 AND id <> $3
         LIMIT 1`,
        [organizationId, slug, agentId],
      );
      if (conflict.rows[0]) throw Object.assign(new Error("That agent slug is already in use"), { statusCode: 409, code: "AGENT_SLUG_TAKEN" });

      const updated = await client.query<AgentRecord>(
        `UPDATE agent_definitions
         SET name = $3, slug = $4, description = $5, updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [agentId, organizationId, name, slug, description],
      );
      const result = updated.rows[0]!;
      if (changedFields.length) {
        await this.enqueueDefinitionLifecycle(client, organizationId, result, "updated", result.status as DefinitionLifecycleAnalyticsInput["status"], changedFields, "human", result.updated_at);
      }
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_definition.updated', 'agent_definition', $3, $4::jsonb)`,
        [organizationId, actorId, agentId, JSON.stringify({ previous: { name: agent.name, slug: agent.slug, description: agent.description }, next: { name, slug, description } })],
      );
      return result;
    });
  }

  /** Creates the dedicated external-connected aggregate in one database transaction. */
  public async createExternalInstallation(
    organizationId: string,
    actorId: string,
    input: CreateExternalAgentInput,
  ): Promise<ExternalAgentConnectionRecord> {
    const agentAudience = input.agentAudience ?? "personal";
    if (agentAudience === "personal" && input.capabilities.some((capability) => [CUSTOMER_SERVICE_HANDOFF_TOOL, LEGACY_CUSTOMER_SERVICE_HANDOFF_TOOL].includes(capability))) {
      throw new Error("Customer handoff capability requires a customer-service agent");
    }
    const capabilities = [...new Set([
      ...input.capabilities,
      ...(agentAudience === "customer_service" ? [CUSTOMER_SERVICE_HANDOFF_TOOL] : []),
    ])];
    const requestedSlug = input.slug ?? `${slugify(input.name) || "external-agent"}-external`.slice(0, 80);
    const settings = {
      externalConnectionKey: input.idempotencyKey,
      environment: "live",
      runtime: input.runtime,
      protocols: input.protocols,
      capabilities,
      resources: input.resources,
      connectors: input.connectors,
    };
    try {
      return await withTransaction(this.pool, async (client) => {
      const existing = await client.query<InstallationRecord>(
        `SELECT * FROM agent_installations
         WHERE organization_id = $1 AND execution_mode = 'external_connected'
           AND settings ->> 'externalConnectionKey' = $2
         FOR UPDATE`,
        [organizationId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const installation = existing.rows[0]!;
        const agentResult = await client.query<AgentRecord>("SELECT * FROM agent_definitions WHERE id = $1", [installation.agent_definition_id]);
        const versionResult = await client.query<AgentVersionRecord>("SELECT * FROM agent_versions WHERE id = $1", [installation.agent_version_id]);
        if (!agentResult.rows[0] || !versionResult.rows[0]) throw new Error("External installation aggregate is incomplete");
        return { agent: agentResult.rows[0], version: versionResult.rows[0], installation, created: false };
      }

      const agentResult = await client.query<AgentRecord>(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, agent_audience, protected, created_by)
         VALUES ($1, 'organization', $2, $3, $4, $5, FALSE, $6)
         RETURNING *`,
        [organizationId, input.name, requestedSlug, input.description ?? null, input.agentAudience ?? "personal", actorId],
      );
      const agent = agentResult.rows[0]!;
      await this.enqueueDefinitionLifecycle(client, organizationId, agent, "created", "active", [], "human", agent.created_at);
      const versionResult = await client.query<AgentVersionRecord>(
        `INSERT INTO agent_versions
          (agent_definition_id, version_number, status, instructions, configuration, policy,
           checksum, created_by, published_at)
         VALUES ($1, 1, 'published', $2, $3::jsonb, $4::jsonb, $5, $6, now())
         RETURNING *`,
        [
          agent.id,
          input.instructions,
          JSON.stringify({ executionMode: "external_connected", runtime: input.runtime, protocols: input.protocols }),
          JSON.stringify({ allowedTools: capabilities }),
          checksumVersion({ instructions: input.instructions, configuration: { executionMode: "external_connected", runtime: input.runtime, protocols: input.protocols }, policy: { allowedTools: capabilities } }, 1),
          actorId,
        ],
      );
      const version = (await this.ensureVersionExtensionSnapshot(client, organizationId, actorId, agent.id, versionResult.rows[0]!.id)) ?? versionResult.rows[0]!;
      await this.enqueueVersionLifecycle(client, organizationId, version, "created", "human", version.created_at);
      for (const toolName of capabilities) {
        await client.query(
          `INSERT INTO agent_tool_grants
            (organization_id, agent_version_id, tool_name, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
             WHERE revoked_at IS NULL DO NOTHING`,
          [organizationId, version.id, toolName, actorId],
        );
      }
      const installationResult = await client.query<InstallationRecord>(
        `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id,
           execution_mode, settings, created_by)
         VALUES ($1, $2, $3, 'organization', $3, 'external_connected', $4::jsonb, $5)
         RETURNING *`,
        [agent.id, version.id, organizationId, JSON.stringify(settings), actorId],
      );
      const installation = installationResult.rows[0]!;
      await this.enqueueInstallationLifecycle(client, installation, "created", null, "human", installation.created_at);
      await client.query(
        `INSERT INTO agent_principals (installation_id, organization_id) VALUES ($1, $2)`,
        [installation.id, organizationId],
      );
      for (const resource of input.resources) {
        await client.query(
          `INSERT INTO agent_installation_resource_grants
            (organization_id, installation_id, resource_type, resource_id, granted_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (installation_id, resource_type, resource_id) DO UPDATE SET revoked_at = NULL`,
          [organizationId, installation.id, resource.resourceType, resource.resourceId, actorId],
        );
      }
      for (const connectorId of input.connectors) {
        await client.query(
          `INSERT INTO agent_installation_connector_grants
            (organization_id, installation_id, connector_id, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (installation_id, connector_id) DO UPDATE SET revoked_at = NULL`,
          [organizationId, installation.id, connectorId, actorId],
        );
      }
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'external_agent_connection.created', 'agent_installation', $3, $4::jsonb)`,
        [organizationId, actorId, installation.id, JSON.stringify({ agentId: agent.id, versionId: version.id, executionMode: installation.execution_mode, runtime: input.runtime, protocols: input.protocols })],
      );
      const credential = await createInstallationCredentialInTransaction(client, {
        organizationId,
        installationId: installation.id,
        actorId,
        label: input.credentialLabel,
        expiresAt: input.expiresAt,
        clientKeyId: input.clientKeyId,
        clientPublicKey: input.clientPublicKey,
      });
        return { agent, version, installation, credential, created: true };
      });
    } catch (error) {
      // Two retries can race before either transaction commits. The unique
      // idempotency index is authoritative; return the committed aggregate
      // instead of leaking a database uniqueness error to the client.
      const code = (error as { code?: string }).code;
      if (code !== "23505") throw error;
      const existing = await query<InstallationRecord>(
        this.pool,
        `SELECT * FROM agent_installations
         WHERE organization_id = $1 AND execution_mode = 'external_connected'
           AND settings ->> 'externalConnectionKey' = $2
         LIMIT 1`,
        [organizationId, input.idempotencyKey],
      );
      const installation = existing.rows[0];
      if (!installation) throw error;
      const [agentResult, versionResult] = await Promise.all([
        query<AgentRecord>(this.pool, "SELECT * FROM agent_definitions WHERE id = $1", [installation.agent_definition_id]),
        query<AgentVersionRecord>(this.pool, "SELECT * FROM agent_versions WHERE id = $1", [installation.agent_version_id]),
      ]);
      if (!agentResult.rows[0] || !versionResult.rows[0]) throw new Error("External installation aggregate is incomplete");
      return { agent: agentResult.rows[0], version: versionResult.rows[0], installation, created: false };
    }
  }

  /**
   * Creates the internal installation used by a workspace Developer API key
   * when it first connects over MCP. The key remains the user-facing
   * credential; this installation only lets the existing capability/runtime
   * pipeline retain its workspace, grant, approval, and audit boundaries.
   */
  public async getOrCreateDeveloperApiKeyInstallation(input: {
    organizationId: string;
    apiKeyId: string;
    toolNames: readonly string[];
  }): Promise<ExternalAgentConnectionRecord> {
    if (input.toolNames.some((toolName) => [CUSTOMER_SERVICE_HANDOFF_TOOL, LEGACY_CUSTOMER_SERVICE_HANDOFF_TOOL].includes(toolName))) {
      throw new Error("Customer handoff capability requires a customer-service agent");
    }
    const developerApiKeyId = input.apiKeyId.trim();
    const actorId = `developer-api-key:${developerApiKeyId}`;
    const settings = {
      developerApiKeyId,
      environment: "live",
      runtime: "developer_api_key",
      protocols: ["mcp"],
      capabilities: [...input.toolNames],
    };
    const slug = `developer-api-${developerApiKeyId}`.slice(0, 80);

    try {
      return await withTransaction(this.pool, async (client) => {
        const existing = await client.query<InstallationRecord>(
          `SELECT * FROM agent_installations
           WHERE organization_id = $1 AND execution_mode = 'external_connected'
             AND settings ->> 'developerApiKeyId' = $2
           FOR UPDATE`,
          [input.organizationId, developerApiKeyId],
        );
        if (existing.rows[0]) {
          const installation = existing.rows[0]!;
          const [agentResult, versionResult] = await Promise.all([
            client.query<AgentRecord>("SELECT * FROM agent_definitions WHERE id = $1", [installation.agent_definition_id]),
            client.query<AgentVersionRecord>("SELECT * FROM agent_versions WHERE id = $1", [installation.agent_version_id]),
          ]);
          if (!agentResult.rows[0] || !versionResult.rows[0]) throw new Error("Developer API installation aggregate is incomplete");
          const version = (await this.ensureVersionExtensionSnapshot(
            client,
            input.organizationId,
            actorId,
            agentResult.rows[0].id,
            versionResult.rows[0].id,
          )) ?? versionResult.rows[0];
          return { agent: agentResult.rows[0], version, installation, created: false };
        }

        const agentResult = await client.query<AgentRecord>(
          `INSERT INTO agent_definitions
            (organization_id, owner_type, name, slug, description, protected, created_by)
           VALUES ($1, 'organization', $2, $3, $4, FALSE, $5)
           RETURNING *`,
          [input.organizationId, "KasiTek Developer API", slug, "Workspace MCP access for Developer API keys", actorId],
        );
        const agent = agentResult.rows[0]!;
        await this.enqueueDefinitionLifecycle(client, input.organizationId, agent, "created", "active", [], "system", agent.created_at);
        const policy = { allowedTools: [...input.toolNames] };
        const configuration = { executionMode: "external_connected", runtime: "developer_api_key", protocols: ["mcp"] };
        const versionResult = await client.query<AgentVersionRecord>(
          `INSERT INTO agent_versions
            (agent_definition_id, version_number, status, instructions, configuration, policy,
             checksum, created_by, published_at)
           VALUES ($1, 1, 'published', $2, $3::jsonb, $4::jsonb, $5, $6, now())
           RETURNING *`,
          [
            agent.id,
            "Developer API access is workspace-scoped and uses the shared KasiTek capability policy.",
            JSON.stringify(configuration),
            JSON.stringify(policy),
            checksumVersion({ instructions: "Developer API access is workspace-scoped and uses the shared KasiTek capability policy.", configuration, policy }, 1),
            actorId,
          ],
        );
        const version = (await this.ensureVersionExtensionSnapshot(
          client,
          input.organizationId,
          actorId,
          agent.id,
          versionResult.rows[0]!.id,
        )) ?? versionResult.rows[0]!;
        await this.enqueueVersionLifecycle(client, input.organizationId, version, "created", "system", version.created_at);
        for (const toolName of input.toolNames) {
          await client.query(
            `INSERT INTO agent_tool_grants
              (organization_id, agent_version_id, tool_name, granted_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
               WHERE revoked_at IS NULL DO NOTHING`,
            [input.organizationId, version.id, toolName, actorId],
          );
        }
        const installationResult = await client.query<InstallationRecord>(
          `INSERT INTO agent_installations
            (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id,
             execution_mode, settings, created_by)
           VALUES ($1, $2, $3, 'organization', $3, 'external_connected', $4::jsonb, $5)
           RETURNING *`,
          [agent.id, version.id, input.organizationId, JSON.stringify(settings), actorId],
        );
        const installation = installationResult.rows[0]!;
        await this.enqueueInstallationLifecycle(client, installation, "created", null, "system", installation.created_at);
        await client.query(
          `INSERT INTO agent_principals (installation_id, organization_id) VALUES ($1, $2)`,
          [installation.id, input.organizationId],
        );
        await client.query(
          `INSERT INTO audit_records
            (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'api_key', $2, 'developer_api_key_installation.created', 'agent_installation', $3, $4::jsonb)`,
          [input.organizationId, actorId, installation.id, JSON.stringify({ apiKeyId: developerApiKeyId, executionMode: "external_connected", runtime: "developer_api_key" })],
        );
        return { agent, version, installation, created: true };
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const existing = await query<InstallationRecord>(
        this.pool,
        `SELECT * FROM agent_installations
         WHERE organization_id = $1 AND execution_mode = 'external_connected'
           AND settings ->> 'developerApiKeyId' = $2
         LIMIT 1`,
        [input.organizationId, developerApiKeyId],
      );
      const installation = existing.rows[0];
      if (!installation) throw error;
      const [agentResult, versionResult] = await Promise.all([
        query<AgentRecord>(this.pool, "SELECT * FROM agent_definitions WHERE id = $1", [installation.agent_definition_id]),
        query<AgentVersionRecord>(this.pool, "SELECT * FROM agent_versions WHERE id = $1", [installation.agent_version_id]),
      ]);
      if (!agentResult.rows[0] || !versionResult.rows[0]) throw new Error("Developer API installation aggregate is incomplete");
      return { agent: agentResult.rows[0], version: versionResult.rows[0], installation, created: false };
    }
  }

  public async installTemplate(input: {
    organizationId: string;
    actorId: string;
    templateKey: string;
    name?: string;
    settings?: Record<string, unknown>;
  }): Promise<TemplateInstallationRecord> {
    const template = getAgentTemplate(input.templateKey);
    if (!template) throw new Error("Agent template not found");
    const settings = normalizeInstallationSettings(input.settings);
    const versionInput = templateVersionInput(template, settings);
    const allowedTools = resolveHostedAgentAllowedTools(template.profile, versionInput.policy.allowedTools, template.audience);
    const effectiveVersionInput = { ...versionInput, policy: { ...versionInput.policy, allowedTools } };
    validateVersionWorkflow(versionInput.configuration);
    const name = input.name?.trim() || template.name;
    return withTransaction(this.pool, async (client) => {
      const insertedDefinition = await client.query<AgentRecord>(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, agent_audience, protected, created_by)
         VALUES ($1, 'organization', $2, $3, $4, $5, FALSE, $6)
         ON CONFLICT (organization_id, slug) DO NOTHING
         RETURNING *`,
        [input.organizationId, name, template.key, template.description, template.audience, input.actorId],
      );
      const definitionCreated = Boolean(insertedDefinition.rows[0]);
      const agentResult = await client.query<AgentRecord>(
        `SELECT * FROM agent_definitions
         WHERE organization_id = $1 AND slug = $2
         FOR UPDATE`,
        [input.organizationId, template.key],
      );
      const agent = agentResult.rows[0];
      if (!agent || agent.owner_type !== "organization" || agent.protected) {
        throw new Error("Agent template slug is occupied by a protected or incompatible agent");
      }
      if (definitionCreated) {
        await this.enqueueDefinitionLifecycle(client, input.organizationId, agent, "created", "active", [], "human", agent.created_at);
      }
      const existingVersion = await client.query<AgentVersionRecord>(
        `SELECT * FROM agent_versions WHERE agent_definition_id = $1 AND status = 'published' LIMIT 1`,
        [agent.id],
      );
      let version = existingVersion.rows[0];
      let created = false;
      const existingAllowedTools = version && Array.isArray(version.policy.allowedTools) ? version.policy.allowedTools : [];
      const versionHasAllDefaultTools = Boolean(version) && allowedTools.every((toolName) => existingAllowedTools.includes(toolName));
      if (version && !versionHasAllDefaultTools) {
        const updated = await client.query<AgentVersionRecord>(
          `UPDATE agent_versions
           SET policy = $2::jsonb, checksum = $3
           WHERE id = $1
           RETURNING *`,
          [version.id, JSON.stringify(effectiveVersionInput.policy), checksumVersion(effectiveVersionInput, version.version_number)],
        );
        version = updated.rows[0] ?? version;
      }
      if (!version) {
        const next = await client.query<{ version_number: number }>(
          `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
           FROM agent_versions WHERE agent_definition_id = $1`,
          [agent.id],
        );
        const versionNumber = Number(next.rows[0]!.version_number);
        const inserted = await client.query<AgentVersionRecord>(
          `INSERT INTO agent_versions
            (agent_definition_id, version_number, status, instructions, configuration, policy,
             checksum, created_by, published_at)
           VALUES ($1, $2, 'published', $3, $4::jsonb, $5::jsonb, $6, $7, now())
           RETURNING *`,
          [
            agent.id,
            versionNumber,
            versionInput.instructions,
            JSON.stringify(versionInput.configuration),
            JSON.stringify(effectiveVersionInput.policy),
            checksumVersion(effectiveVersionInput, versionNumber),
            input.actorId,
          ],
        );
        version = inserted.rows[0]!;
        created = true;
        await this.enqueueVersionLifecycle(client, input.organizationId, version, "created", "human", version.created_at);
      }
      version = (await this.ensureVersionExtensionSnapshot(client, input.organizationId, input.actorId, agent.id, version.id)) ?? version;
      for (const toolName of allowedTools) {
        await client.query(
          `INSERT INTO agent_tool_grants
            (organization_id, agent_version_id, tool_name, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
             WHERE revoked_at IS NULL DO NOTHING`,
          [input.organizationId, version.id, toolName.trim(), input.actorId],
        );
      }
      const installationResult = await client.query<InstallationRecord & { created_now: boolean }>(
        `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, release_mode, settings, created_by)
         VALUES ($1, $2, $3, 'organization', $3, 'kasitek_hosted', 'pinned', $4::jsonb, $5)
         ON CONFLICT (
           organization_id,
           agent_definition_id,
           scope_type,
           scope_id,
           (COALESCE(settings ->> 'environment', 'live'))
         )
         DO UPDATE SET
           updated_at = agent_installations.updated_at,
           settings = CASE
             WHEN COALESCE(EXCLUDED.settings ->> 'environment', 'live') = 'live'
             THEN agent_installations.settings || jsonb_build_object(
               'environment', 'live',
               'bindingRevision', COALESCE(
                 agent_installations.settings ->> 'bindingRevision',
                 EXCLUDED.settings ->> 'bindingRevision',
                 'system-default'
               ),
               'bindingStatus', COALESCE(
                 agent_installations.settings ->> 'bindingStatus',
                 EXCLUDED.settings ->> 'bindingStatus',
                 'ready'
               )
             )
             ELSE agent_installations.settings
           END
         RETURNING *, (xmax = 0) AS created_now`,
        [agent.id, version.id, input.organizationId, JSON.stringify({ ...settings, templateKey: template.key, templateVersion: template.version }), input.actorId],
      );
      const installation = installationResult.rows[0]!;
      if (installation.created_now) {
        await this.enqueueInstallationLifecycle(client, installation, "created", null, "human", installation.created_at);
      }
      await client.query(
        `INSERT INTO agent_principals (installation_id, organization_id)
         VALUES ($1, $2) ON CONFLICT (installation_id) DO NOTHING`,
        [installation.id, input.organizationId],
      );
      if (created) {
        await client.query(
          `INSERT INTO audit_records
            (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'human', $2, 'agent_template.installed', 'agent_definition', $3, $4::jsonb)`,
          [input.organizationId, input.actorId, agent.id, JSON.stringify({ templateKey: template.key, templateVersion: template.version, versionId: version.id, installationId: installation.id })],
        );
      }
      return { agent, version, installation, templateKey: template.key, templateVersion: template.version, created };
    });
  }

  public async createSystemAgent(
    actorId: string,
    input: CreateSystemAgentInput & { organizationId?: string },
  ): Promise<AgentRecord> {
    const organizationId = input.organizationId ?? SYSTEM_ORGANIZATION_ID;
    const slug = input.slug ?? slugify(input.name);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<AgentRecord>(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, creation_profile, protected, created_by)
         VALUES ($1, 'system', $2, $3, $4, 'system', TRUE, $5)
         RETURNING *`,
        [organizationId, input.name, slug, input.description ?? null, actorId],
      );
      const agent = result.rows[0]!;
      await this.enqueueDefinitionLifecycle(client, organizationId, agent, "created", "active", [], "system", agent.created_at);
      return agent;
    });
  }

  public async ensureSystemAgent(
    actorId: string,
    input: CreateSystemAgentInput & { organizationId?: string },
  ): Promise<AgentRecord> {
    const organizationId = input.organizationId ?? SYSTEM_ORGANIZATION_ID;
    const slug = input.slug ?? slugify(input.name);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<AgentRecord>(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, creation_profile, protected, created_by)
         VALUES ($1, 'system', $2, $3, $4, 'system', TRUE, $5)
         ON CONFLICT (organization_id, slug) DO NOTHING
         RETURNING *`,
        [organizationId, input.name, slug, input.description ?? null, actorId],
      );
      const created = Boolean(inserted.rows[0]);
      const existing = await client.query<AgentRecord>(
        `SELECT * FROM agent_definitions
         WHERE organization_id = $1 AND slug = $2
         FOR UPDATE`,
        [organizationId, slug],
      );
      const agent = existing.rows[0];
      if (!agent || agent.owner_type !== "system" || !agent.protected) {
        throw new Error("System agent slug is occupied by a non-system definition");
      }
      const updated = await client.query<AgentRecord>(
        `UPDATE agent_definitions
         SET name = $3, description = $4, status = 'active', updated_at = now(), archived_at = NULL
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [organizationId, agent.id, input.name, input.description ?? null],
      );
      const result = updated.rows[0]!;
      if (created) {
        await this.enqueueDefinitionLifecycle(client, organizationId, result, "created", "active", [], "system", result.created_at);
      } else {
        const changedFields: DefinitionLifecycleAnalyticsInput["changedFields"] = [
          ...(agent.name !== result.name ? ["name" as const] : []),
          ...(agent.description !== result.description ? ["description" as const] : []),
          ...(agent.status !== result.status ? ["status" as const] : []),
        ];
        if (changedFields.length) {
          await this.enqueueDefinitionLifecycle(
            client,
            organizationId,
            result,
            agent.status === "archived" && result.status === "active" ? "restored" : "updated",
            "active",
            changedFields,
            "system",
            result.updated_at,
          );
        }
      }
      return result;
    });
  }

  public async ensureInitialSystemVersion(
    actorId: string,
    agentId: string,
    input: CreateVersionInput,
  ): Promise<AgentVersionRecord> {
    validateVersionWorkflow(input.configuration);
    return withTransaction(this.pool, async (client) => {
      const agentResult = await client.query<AgentRecord>(
        `SELECT * FROM agent_definitions
         WHERE id = $1 AND owner_type = 'system' AND protected = TRUE
         FOR UPDATE`,
        [agentId],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw new Error("Protected system agent not found");
      const published = await client.query<AgentVersionRecord & { content_matches: boolean }>(
        `SELECT av.*,
                (av.instructions = $2 AND av.configuration = $3::jsonb AND av.policy = $4::jsonb) AS content_matches
         FROM agent_versions av
         WHERE av.agent_definition_id = $1 AND av.status = 'published'
         LIMIT 1`,
        [agentId, input.instructions, JSON.stringify(input.configuration), JSON.stringify(input.policy)],
      );
      if (published.rows[0]) {
        if (!published.rows[0].content_matches) {
          throw new Error("Published system agent version differs; use an explicit release operation");
        }
        return (await this.ensureVersionExtensionSnapshot(client, agent.organization_id, actorId, agentId, published.rows[0].id)) ?? published.rows[0];
      }
      const versionResult = await client.query<{ version_number: number }>(
        "SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM agent_versions WHERE agent_definition_id = $1",
        [agentId],
      );
      const versionNumber = Number(versionResult.rows[0]!.version_number);
      const created = await client.query<AgentVersionRecord>(
        `INSERT INTO agent_versions
          (agent_definition_id, version_number, status, instructions, configuration, policy,
           checksum, created_by, published_at)
         VALUES ($1, $2, 'published', $3, $4::jsonb, $5::jsonb, $6, $7, now())
         RETURNING *`,
        [
          agentId,
          versionNumber,
          input.instructions,
          JSON.stringify(input.configuration),
          JSON.stringify(input.policy),
          checksumVersion(input, versionNumber),
          actorId,
        ],
      );
      let version = created.rows[0]!;
      version = (await this.ensureVersionExtensionSnapshot(client, agent.organization_id, actorId, agentId, version.id)) ?? version;
      await this.enqueueVersionLifecycle(client, agent.organization_id, version, "created", "system", version.created_at);
      const allowedTools = Array.isArray(input.policy.allowedTools)
        ? input.policy.allowedTools.filter(
            (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
          )
        : [];
      for (const toolName of allowedTools) {
        await client.query(
          `INSERT INTO agent_tool_grants
            (organization_id, agent_version_id, tool_name, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
             WHERE revoked_at IS NULL
           DO NOTHING`,
          [agent.organization_id, version.id, toolName.trim(), actorId],
        );
      }
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'system', $2, 'system_agent_version.published', 'agent_version', $3, $4::jsonb)`,
        [agent.organization_id, actorId, version.id, JSON.stringify({ agentId })],
      );
      return version;
    });
  }

  public async releaseSystemVersion(
    actorId: string,
    agentId: string,
    input: CreateVersionInput,
  ): Promise<AgentVersionRecord> {
    validateVersionWorkflow(input.configuration);
    return withTransaction(this.pool, async (client) => {
      const agent = await client.query<AgentRecord>(
        `SELECT * FROM agent_definitions
         WHERE id = $1 AND owner_type = 'system' AND protected = TRUE
         FOR UPDATE`,
        [agentId],
      );
      if (!agent.rows[0]) throw new Error("Protected system agent not found");
      const current = await client.query<AgentVersionRecord>(
        `SELECT * FROM agent_versions WHERE agent_definition_id = $1 AND status = 'published' LIMIT 1 FOR UPDATE`,
        [agentId],
      );
      if (current.rows[0] && agentVersionContentMatches(current.rows[0], input)) {
        return (await this.ensureVersionExtensionSnapshot(client, agent.rows[0].organization_id, actorId, agentId, current.rows[0].id)) ?? current.rows[0];
      }
      const next = await client.query<{ version_number: number }>(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
         FROM agent_versions WHERE agent_definition_id = $1`,
        [agentId],
      );
      if (current.rows[0]) {
        const retired = await client.query<AgentVersionRecord>(
          "UPDATE agent_versions SET status = 'retired', retired_at = now() WHERE id = $1 RETURNING *",
          [current.rows[0].id],
        );
        if (retired.rows[0]) {
          await this.enqueueVersionLifecycle(client, agent.rows[0].organization_id, retired.rows[0], "retired", "system", new Date().toISOString());
        }
      }
      const versionNumber = Number(next.rows[0]!.version_number);
      const created = await client.query<AgentVersionRecord>(
        `INSERT INTO agent_versions
          (agent_definition_id, version_number, status, instructions, configuration, policy,
           checksum, created_by, published_at)
         VALUES ($1, $2, 'published', $3, $4::jsonb, $5::jsonb, $6, $7, now())
         RETURNING *`,
        [agentId, versionNumber, input.instructions, JSON.stringify(input.configuration), JSON.stringify(input.policy), checksumVersion(input, versionNumber), actorId],
      );
      let version = created.rows[0]!;
      version = (await this.ensureVersionExtensionSnapshot(client, agent.rows[0].organization_id, actorId, agentId, version.id)) ?? version;
      await this.enqueueVersionLifecycle(client, agent.rows[0].organization_id, version, "created", "system", version.created_at);
      const allowedTools = Array.isArray(input.policy.allowedTools)
        ? input.policy.allowedTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
        : [];
      for (const toolName of allowedTools) {
        await client.query(
          `INSERT INTO agent_tool_grants
            (organization_id, agent_version_id, tool_name, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
             WHERE revoked_at IS NULL DO NOTHING`,
          [agent.rows[0].organization_id, version.id, toolName.trim(), actorId],
        );
      }
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'system', $2, 'system_agent_version.released', 'agent_version', $3, $4::jsonb)`,
        [agent.rows[0].organization_id, actorId, version.id, JSON.stringify({ agentId, previousVersionId: current.rows[0]?.id ?? null })],
      );
      return version;
    });
  }

  public async rolloutSystemVersion(agentId: string, versionId: string, actorId: string): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const installations = await client.query<{ id: string; organization_id: string }>(
        `SELECT id, organization_id FROM agent_installations
         WHERE agent_definition_id = $1 AND status <> 'disabled' AND agent_version_id <> $2 FOR UPDATE`,
        [agentId, versionId],
      );
      for (const installation of installations.rows) {
        await client.query(
          `UPDATE agent_installations SET agent_version_id = $2, updated_at = now() WHERE id = $1`,
          [installation.id, versionId],
        );
        await client.query(
          `INSERT INTO audit_records
            (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'system', $2, 'system_agent_installation.rolled_out', 'agent_installation', $3, $4::jsonb)`,
          [installation.organization_id, actorId, installation.id, JSON.stringify({ agentId, versionId })],
        );
      }
      return installations.rowCount ?? 0;
    });
  }

  /**
   * Compare the source-defined protected agent candidate with the published
   * database version and every active installation. This is deliberately a
   * read-only projection used by release gates and worker startup checks.
   */
  public async getSystemAgentReleaseStatus(input: {
    systemSlug: string;
    candidate: CreateVersionInput;
  }): Promise<SystemAgentReleaseStatus> {
    const result = await query<SystemAgentReleaseStatus>(
      this.pool,
      `SELECT ad.id AS "agentId",
              published.id AS "publishedVersionId",
              published.version_number AS "publishedVersionNumber",
              COALESCE(
                published.instructions = $2
                AND published.configuration = $3::jsonb
                AND published.policy = $4::jsonb,
                FALSE
              ) AS "publishedContentMatches",
              COUNT(installation.id) FILTER (WHERE installation.status <> 'disabled')::int AS "activeInstallationCount",
              COUNT(installation.id) FILTER (
                WHERE installation.status <> 'disabled'
                  AND installation.agent_version_id = published.id
              )::int AS "matchingInstallationCount"
       FROM agent_definitions ad
       LEFT JOIN agent_versions published
         ON published.agent_definition_id = ad.id AND published.status = 'published'
       LEFT JOIN agent_installations installation
         ON installation.agent_definition_id = ad.id
       WHERE ad.organization_id = $1
         AND ad.owner_type = 'system'
         AND ad.protected = TRUE
         AND ad.slug = $5
       GROUP BY ad.id, published.id, published.version_number,
                published.instructions, published.configuration, published.policy`,
      [
        SYSTEM_ORGANIZATION_ID,
        input.candidate.instructions,
        JSON.stringify(input.candidate.configuration),
        JSON.stringify(input.candidate.policy),
        input.systemSlug,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        agentId: null,
        publishedVersionId: null,
        publishedVersionNumber: null,
        publishedContentMatches: false,
        activeInstallationCount: 0,
        matchingInstallationCount: 0,
        staleInstallationCount: 0,
      };
    }
    return {
      ...row,
      staleInstallationCount: row.activeInstallationCount - row.matchingInstallationCount,
    };
  }

  public async getAgent(organizationId: string, agentId: string): Promise<AgentRecord | null> {
    const result = await query<AgentRecord>(
      this.pool,
      `SELECT ad.* FROM agent_definitions ad
       WHERE ad.id = $2 AND (
         ad.organization_id = $1 OR (
           ad.owner_type = 'system' AND ad.protected = TRUE AND EXISTS (
             SELECT 1 FROM agent_installations ai
             WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
           )
         )
       )`,
      [organizationId, agentId],
    );
    return result.rows[0] ?? null;
  }

  public async listAgents(organizationId: string, options: { environment?: "playground" | "live" } = {}): Promise<AgentRecord[]> {
    const result = await query<AgentRecord>(
      this.pool,
      `SELECT ad.*, ai.id AS installation_id, ai.execution_mode, ai.status AS installation_status,
              ai.settings AS installation_settings, ai.release_mode,
              ai.agent_version_id AS installation_version_id,
              av.version_number,
              published_av.id AS published_version_id,
              published_av.version_number AS published_version_number
       FROM agent_definitions ad
       LEFT JOIN LATERAL (
         SELECT ai.* FROM agent_installations ai
         WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
           AND ($2::text IS NULL OR COALESCE(ai.settings ->> 'environment', 'live') = $2)
         ORDER BY CASE WHEN $2::text IS NULL AND ai.settings ->> 'environment' = 'playground' THEN 0 ELSE 1 END,
                  ai.updated_at DESC LIMIT 1
       ) ai ON TRUE
       LEFT JOIN agent_versions av ON av.id = ai.agent_version_id
       LEFT JOIN agent_versions published_av
         ON published_av.agent_definition_id = ad.id AND published_av.status = 'published'
       WHERE (
         ad.organization_id = $1 OR (
           ad.owner_type = 'system' AND ad.protected = TRUE AND EXISTS (
             SELECT 1 FROM agent_installations ai
             WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM agent_installations hidden_ai
         WHERE hidden_ai.agent_definition_id = ad.id
           AND hidden_ai.organization_id = $1
           AND hidden_ai.settings ->> 'developerApiKeyId' IS NOT NULL
       )
       AND ($2::text IS NULL OR ai.id IS NOT NULL)
       ORDER BY ad.protected DESC, ad.created_at DESC`,
      [organizationId, options.environment ?? null],
    );
    return result.rows;
  }

  public async countAgentsByAudience(organizationId: string): Promise<{ total: number; personal: number; customer_service: number }> {
    const result = await query<{ agent_audience: AgentAudience; count: string }>(
      this.pool,
      `SELECT ad.agent_audience, COUNT(*)::text AS count
       FROM agent_definitions ad
       WHERE (
         ad.organization_id = $1 OR (
           ad.owner_type = 'system' AND ad.protected = TRUE AND EXISTS (
             SELECT 1 FROM agent_installations ai
             WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
           )
         )
       )
       AND ad.status <> 'archived'
       AND NOT EXISTS (
         SELECT 1 FROM agent_installations hidden_ai
         WHERE hidden_ai.agent_definition_id = ad.id
           AND hidden_ai.organization_id = $1
           AND hidden_ai.settings ->> 'developerApiKeyId' IS NOT NULL
       )
       GROUP BY ad.agent_audience`,
      [organizationId],
    );
    const counts = { total: 0, personal: 0, customer_service: 0 };
    for (const row of result.rows) {
      const count = Number(row.count);
      counts.total += count;
      counts[row.agent_audience] = count;
    }
    return counts;
  }

  public async listExternalAgents(organizationId: string): Promise<AgentRecord[]> {
    const result = await query<AgentRecord>(
      this.pool,
      `SELECT ad.*, ai.id AS installation_id, ai.execution_mode, ai.status AS installation_status,
              ai.settings AS installation_settings, ai.release_mode,
              ai.agent_version_id AS installation_version_id,
              av.version_number,
              published_av.id AS published_version_id,
              published_av.version_number AS published_version_number
       FROM agent_definitions ad
       JOIN LATERAL (
         SELECT ai.* FROM agent_installations ai
         WHERE ai.agent_definition_id = ad.id
           AND ai.organization_id = $1
           AND ai.execution_mode = 'external_connected'
         ORDER BY ai.updated_at DESC LIMIT 1
       ) ai ON TRUE
       JOIN agent_versions av ON av.id = ai.agent_version_id
       LEFT JOIN agent_versions published_av
         ON published_av.agent_definition_id = ad.id AND published_av.status = 'published'
       WHERE ad.organization_id = $1 AND ad.owner_type = 'organization' AND ad.protected = FALSE
         AND ai.settings ->> 'developerApiKeyId' IS NULL
       ORDER BY ai.updated_at DESC, ad.created_at DESC`,
      [organizationId],
    );
    return result.rows;
  }

  /** Archives an external connection and revokes every active credential in one transaction. */
  public async archiveExternalInstallation(
    organizationId: string,
    installationId: string,
    actorId: string,
  ): Promise<InstallationRecord> {
    return withTransaction(this.pool, async (client) => {
      const target = await client.query<InstallationRecord>(
        `SELECT * FROM agent_installations
         WHERE id = $1 AND organization_id = $2 AND execution_mode = 'external_connected'
         FOR UPDATE`,
        [installationId, organizationId],
      );
      const installation = target.rows[0];
      if (!installation) throw new Error("External installation not found");
      const revoked = await client.query(
        `UPDATE agent_installation_credentials
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), revoked_by = $3
         WHERE organization_id = $1 AND installation_id = $2 AND status = 'active'`,
        [organizationId, installationId, actorId],
      );
      const disabled = await client.query<InstallationRecord>(
        `UPDATE agent_installations SET status = 'disabled', updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [installationId, organizationId],
      );
      if (installation.status !== "disabled" && disabled.rows[0]) {
        await this.enqueueInstallationLifecycle(client, disabled.rows[0], "disabled", installation.status as InstallationLifecycleAnalyticsInput["previousStatus"], "human", disabled.rows[0].updated_at);
      }
      const archivedDefinition = await client.query<AgentRecord>(
        `UPDATE agent_definitions SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND owner_type = 'organization' AND protected = FALSE AND status <> 'archived'
         RETURNING *`,
        [installation.agent_definition_id, organizationId],
      );
      if (archivedDefinition.rows[0]) {
        await this.enqueueDefinitionLifecycle(client, organizationId, archivedDefinition.rows[0], "archived", "archived", ["status"], "human", archivedDefinition.rows[0].updated_at);
      }
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'external_agent_connection.archived', 'agent_installation', $3, $4::jsonb)`,
        [organizationId, actorId, installationId, JSON.stringify({ agentId: installation.agent_definition_id, executionMode: installation.execution_mode, revokedCredentialCount: revoked.rowCount ?? 0 })],
      );
      return { ...installation, status: "disabled", updated_at: new Date().toISOString() };
    });
  }

  public async listVersions(organizationId: string, agentId: string): Promise<AgentVersionRecord[]> {
    const result = await query<AgentVersionRecord>(
      this.pool,
      `SELECT av.* FROM agent_versions av
       JOIN agent_definitions ad ON ad.id = av.agent_definition_id
       WHERE ad.id = $2 AND (
         ad.organization_id = $1 OR (
           ad.owner_type = 'system' AND ad.protected = TRUE AND EXISTS (
             SELECT 1 FROM agent_installations ai
             WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
           )
         )
       )
       ORDER BY av.version_number DESC`,
      [organizationId, agentId],
    );
    return result.rows;
  }

  public async createVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    input: CreateVersionInput,
  ): Promise<AgentVersionRecord> {
    validateVersionWorkflow(input.configuration);
    return withTransaction(this.pool, async (client) => {
      await this.assertHostedDefinition(client, organizationId, agentId);
      const agent = await client.query<AgentRecord>(
        "SELECT * FROM agent_definitions WHERE organization_id = $1 AND id = $2 FOR UPDATE",
        [organizationId, agentId],
      );
      if (!agent.rows[0]) throw new Error("Agent not found");
      const versionResult = await client.query<{ version_number: number }>(
        "SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM agent_versions WHERE agent_definition_id = $1",
        [agentId],
      );
      const versionNumber = Number(versionResult.rows[0]!.version_number);
      const normalizedPolicy = normalizeModelPolicy(input.policy);
      if (agent.rows[0]!.agent_audience === "personal" && Array.isArray(normalizedPolicy.allowedTools)
        && normalizedPolicy.allowedTools.includes(CUSTOMER_SERVICE_HANDOFF_TOOL)) {
        throw new Error("Customer handoff capability requires a customer-service agent");
      }
      const allowedTools = resolveHostedAgentAllowedTools(
        agent.rows[0]!.creation_profile,
        normalizedPolicy.allowedTools,
        agent.rows[0]!.agent_audience,
      );
      const effectiveInput = { ...input, policy: { ...normalizedPolicy, allowedTools } };
      const checksum = checksumVersion(effectiveInput, versionNumber);
      const created = await client.query<AgentVersionRecord>(
        `INSERT INTO agent_versions
          (agent_definition_id, version_number, instructions, configuration, policy, checksum, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
         RETURNING *`,
        [
          agentId,
          versionNumber,
          input.instructions,
          JSON.stringify(input.configuration),
          JSON.stringify(effectiveInput.policy),
          checksum,
          actorId,
        ],
      );
      await this.enqueueVersionLifecycle(client, organizationId, created.rows[0]!, "created", "human", created.rows[0]!.created_at);
      for (const toolName of allowedTools) {
        await client.query(
          `INSERT INTO agent_tool_grants
            (organization_id, agent_version_id, tool_name, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [organizationId, created.rows[0]!.id, toolName.trim(), actorId],
        );
      }
      const effectivePolicy = effectiveInput.policy as Record<string, unknown>;
      const requestedSkillIds = [...new Set(
        Array.isArray(effectivePolicy.allowedSkillIds)
          ? effectivePolicy.allowedSkillIds.filter((skillId): skillId is string => typeof skillId === "string")
          : [],
      )];
      if (requestedSkillIds.length) {
        const pinned = await client.query(
          `INSERT INTO agent_version_skills (organization_id, agent_version_id, skill_version_id, pinned_by)
           SELECT $1, $2, latest.id, $3
           FROM unnest($4::text[]) requested(skill_id)
           JOIN agent_skill_definitions definition ON definition.id::text = requested.skill_id
           CROSS JOIN LATERAL (
             SELECT version.id
             FROM agent_skill_versions version
             WHERE version.skill_definition_id = definition.id
               AND version.status = 'published'
             ORDER BY version.version_number DESC
             LIMIT 1
           ) latest
           WHERE definition.status = 'published'
             AND (definition.organization_id = $1 OR definition.owner_type = 'platform')
           ON CONFLICT (agent_version_id, skill_version_id) DO NOTHING
           RETURNING skill_version_id`,
          [organizationId, created.rows[0]!.id, actorId, requestedSkillIds],
        );
        if (pinned.rowCount !== requestedSkillIds.length) throw new Error("SKILL_VERSION_UNAVAILABLE");
      }
      // Draft versions are reconciled at publication time. This prevents a
      // package being revoked or becoming unready after draft creation from
      // being hidden behind an already-pinned draft snapshot.
      return created.rows[0]!;
    });
  }

  /**
   * Activate one extension on the next Playground candidate. Published
   * versions are immutable: when the Playground still points at a published
   * version, this clones the version, copies its pins and installation grants,
   * applies the requested extension, materializes a fresh extension snapshot,
   * and retargets only that Playground installation. Live remains pinned to
   * its previous version until an explicit promotion.
   */
  public async activatePlaygroundExtension(
    input: {
      organizationId: string;
      actorId: string;
      installationId?: string;
      agentVersionId?: string;
      extension: PlaygroundExtensionActivation;
      remove?: boolean;
    },
  ): Promise<PlaygroundExtensionActivationResult> {
    return withTransaction(this.pool, async (client) => {
      const installationResult = await client.query<InstallationRecord>(
        `SELECT * FROM agent_installations
         WHERE organization_id = $1
           AND (id = $2 OR ($2::uuid IS NULL AND agent_version_id = $3))
           AND COALESCE(settings ->> 'environment', 'live') = 'playground'
           AND status <> 'disabled'
         ORDER BY updated_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.organizationId, input.installationId ?? null, input.agentVersionId ?? null],
      );
      const installation = installationResult.rows[0];
      if (!installation) throw new Error("PLAYGROUND_INSTALLATION_NOT_FOUND");
      if (input.agentVersionId && installation.agent_version_id !== input.agentVersionId) {
        throw new Error("PLAYGROUND_VERSION_NOT_ACTIVE");
      }

      const sourceResult = await client.query<AgentVersionRecord>(
        `SELECT version.*
         FROM agent_versions version
         JOIN agent_definitions definition ON definition.id = version.agent_definition_id
         WHERE version.id = $2 AND version.agent_definition_id = $3
           AND definition.organization_id = $1
         FOR UPDATE`,
        [input.organizationId, installation.agent_version_id, installation.agent_definition_id],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new Error("PLAYGROUND_VERSION_NOT_FOUND");

      let configuration = source.configuration ?? {};
      let policy = source.policy ?? {};
      let extensionChanged = false;
      if (input.extension.kind === "plugin") {
        const selected = addPluginPackageSelection(configuration, policy, input.extension.package);
        configuration = selected.configuration;
        policy = selected.policy;
        extensionChanged = selected.changed;
      }

      const skillAlreadyPinned = input.extension.kind === "skill"
        ? Boolean((await client.query(
          `SELECT 1 FROM agent_version_skills
           WHERE organization_id = $1 AND agent_version_id = $2 AND skill_version_id = $3`,
          [input.organizationId, source.id, input.extension.skillVersionId],
        )).rows[0])
        : false;
      const mcpAlreadyPinned = input.extension.kind === "mcp"
        ? Boolean((await client.query(
          `SELECT 1 FROM agent_version_mcp_providers
           WHERE organization_id = $1 AND agent_version_id = $2 AND provider_version_id = $3`,
          [input.organizationId, source.id, input.extension.providerVersionId],
        )).rows[0])
        : false;
      extensionChanged ||= input.extension.kind === "skill" ? !skillAlreadyPinned : input.extension.kind === "mcp" ? (input.remove ? mcpAlreadyPinned : !mcpAlreadyPinned) : false;
      if (!extensionChanged) return { installation, version: source, createdCandidate: false };

      if (source.status === "draft") {
        const updated = await client.query<AgentVersionRecord>(
          `UPDATE agent_versions
           SET configuration = $2::jsonb,
               policy = $3::jsonb,
               checksum = $4
           WHERE id = $1
           RETURNING *`,
          [source.id, JSON.stringify(configuration), JSON.stringify(policy), checksumVersion({ instructions: source.instructions, configuration, policy } as CreateVersionInput, source.version_number)],
        );
        const version = updated.rows[0] ?? source;
        await this.applyPlaygroundExtensionPin(client, input, version.id, installation.id);
        return { installation, version, createdCandidate: false };
      }

      const nextNumber = await client.query<{ version_number: number }>(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
         FROM agent_versions WHERE agent_definition_id = $1`,
        [source.agent_definition_id],
      );
      const versionNumber = Number(nextNumber.rows[0]?.version_number ?? source.version_number + 1);
      const inserted = await client.query<AgentVersionRecord>(
        `INSERT INTO agent_versions
          (agent_definition_id, version_number, status, instructions, configuration, policy,
           checksum, created_by)
         VALUES ($1, $2, 'draft', $3, $4::jsonb, $5::jsonb, $6, $7)
         RETURNING *`,
        [
          source.agent_definition_id,
          versionNumber,
          source.instructions,
          JSON.stringify(configuration),
          JSON.stringify(policy),
          checksumVersion({ instructions: source.instructions, configuration, policy } as CreateVersionInput, versionNumber),
          input.actorId,
        ],
      );
      const candidate = inserted.rows[0];
      if (!candidate) throw new Error("PLAYGROUND_CANDIDATE_CREATE_FAILED");

      // Portable version grants and extension pins travel with the candidate.
      await client.query(
        `INSERT INTO agent_tool_grants
           (organization_id, agent_version_id, installation_id, tool_name, granted_by)
         SELECT organization_id, $2, installation_id, tool_name, granted_by
         FROM agent_tool_grants
         WHERE organization_id = $1 AND agent_version_id = $3 AND revoked_at IS NULL
         ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
           WHERE revoked_at IS NULL DO NOTHING`,
        [input.organizationId, candidate.id, source.id],
      );
      await client.query(
        `INSERT INTO agent_version_skills (organization_id, agent_version_id, skill_version_id, pinned_by)
         SELECT organization_id, $2, skill_version_id, pinned_by
         FROM agent_version_skills
         WHERE organization_id = $1 AND agent_version_id = $3
         ON CONFLICT (agent_version_id, skill_version_id) DO NOTHING`,
        [input.organizationId, candidate.id, source.id],
      );
      await client.query(
        `INSERT INTO agent_version_mcp_providers (organization_id, agent_version_id, provider_version_id, pinned_by)
         SELECT organization_id, $2, provider_version_id, pinned_by
         FROM agent_version_mcp_providers
         WHERE organization_id = $1 AND agent_version_id = $3
         ON CONFLICT DO NOTHING`,
        [input.organizationId, candidate.id, source.id],
      );
      await this.applyPlaygroundExtensionPin(client, input, candidate.id, installation.id);

      const snapshot = await this.extensionSnapshots.ensureSnapshotForVersion(client, input.organizationId, input.actorId, candidate.id);
      const pinned = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions SET extension_snapshot_id = $2 WHERE id = $1 RETURNING *`,
        [candidate.id, snapshot.id],
      );
      const retired = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions SET status = 'retired', retired_at = now()
         WHERE id = $1 AND status = 'published' RETURNING *`,
        [source.id],
      );
      const published = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions SET status = 'published', published_at = now()
         WHERE id = $1 AND status = 'draft' RETURNING *`,
        [candidate.id],
      );
      const publishedVersion = published.rows[0] ?? pinned.rows[0];
      if (!publishedVersion) throw new Error("PLAYGROUND_CANDIDATE_PUBLISH_FAILED");
      for (const version of retired.rows) {
        await this.enqueueVersionLifecycle(client, input.organizationId, version, "retired", "human", new Date().toISOString());
      }
      await this.enqueueVersionLifecycle(client, input.organizationId, publishedVersion, "published", "human", new Date().toISOString());
      const deployed = await this.deploymentModule.deployInstallation(client, input.organizationId, input.actorId, installation.id, {
        versionId: publishedVersion.id,
        expectedVersionId: source.id,
      });
      return { installation: deployed, version: publishedVersion, createdCandidate: true };
    });
  }

  private async applyPlaygroundExtensionPin(
    client: PoolClient,
    input: { organizationId: string; actorId: string; extension: PlaygroundExtensionActivation; remove?: boolean },
    agentVersionId: string,
    installationId: string,
  ): Promise<void> {
    if (input.extension.kind === "skill") {
      const result = await client.query(
        `INSERT INTO agent_version_skills (organization_id, agent_version_id, skill_version_id, pinned_by)
         SELECT $1, $2, version.id, $3
         FROM agent_skill_versions version
         JOIN agent_skill_definitions definition ON definition.id = version.skill_definition_id
         WHERE version.id = $4 AND version.organization_id = $1
           AND version.status = 'published' AND definition.status = 'published'
           AND (definition.organization_id = $1 OR definition.owner_type = 'platform')
         ON CONFLICT (agent_version_id, skill_version_id) DO NOTHING`,
        [input.organizationId, agentVersionId, input.actorId, input.extension.skillVersionId],
      );
      if (!result.rowCount && !((await client.query("SELECT 1 FROM agent_version_skills WHERE organization_id = $1 AND agent_version_id = $2 AND skill_version_id = $3", [input.organizationId, agentVersionId, input.extension.skillVersionId])).rows[0])) {
        throw new Error("SKILL_VERSION_NOT_FOUND_OR_NOT_PUBLISHED");
      }
      return;
    }
    if (input.extension.kind === "mcp") {
      if (input.remove) {
        await client.query("DELETE FROM agent_version_mcp_providers WHERE organization_id = $1 AND agent_version_id = $2 AND provider_version_id = $3",
          [input.organizationId, agentVersionId, input.extension.providerVersionId]);
        return;
      }
      const result = await client.query(
        `INSERT INTO agent_version_mcp_providers (organization_id, agent_version_id, provider_version_id, pinned_by)
         SELECT $1, $2, provider_version.id, $3
         FROM agent_mcp_provider_versions provider_version
         JOIN agent_mcp_providers provider ON provider.id = provider_version.provider_id
         WHERE provider_version.id = $4 AND provider_version.organization_id = $1
           AND provider_version.status = 'published' AND provider.status = 'approved'
           AND provider.health_status = 'healthy'
         ON CONFLICT DO NOTHING`,
        [input.organizationId, agentVersionId, input.actorId, input.extension.providerVersionId],
      );
      if (!result.rowCount && !((await client.query("SELECT 1 FROM agent_version_mcp_providers WHERE organization_id = $1 AND agent_version_id = $2 AND provider_version_id = $3", [input.organizationId, agentVersionId, input.extension.providerVersionId])).rows[0])) {
        throw new Error("REMOTE_MCP_PROVIDER_VERSION_NOT_FOUND_OR_NOT_PUBLISHED_OR_UNHEALTHY");
      }
      return;
    }
    // Plugin selection is represented in the version configuration. The
    // package itself was already validated and published by the caller.
    void installationId;
  }

  public async publishVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> {
    return withTransaction(this.pool, async (client) => {
      await this.assertHostedDefinition(client, organizationId, agentId);
      const agent = await client.query<AgentRecord>(
        "SELECT * FROM agent_definitions WHERE organization_id = $1 AND id = $2 FOR UPDATE",
        [organizationId, agentId],
      );
      if (!agent.rows[0]) throw new Error("Agent not found");
      if (agent.rows[0].protected && agent.rows[0].owner_type !== "system") {
        throw new Error("Protected agent ownership is invalid");
      }
      const draft = await client.query<AgentVersionRecord>(
        `SELECT * FROM agent_versions
         WHERE id = $1 AND agent_definition_id = $2 AND status = 'draft'
         FOR UPDATE`,
        [versionId, agentId],
      );
      if (!draft.rows[0]) throw new Error("Draft version not found");
      // Resolve against the current persisted package catalog while the
      // version is still draft. The transaction cannot publish if any
      // selected package is missing, revoked, or not ready.
      await this.ensureVersionExtensionSnapshot(client, organizationId, actorId, agentId, draft.rows[0].id);
      const lifecycleAt = new Date().toISOString();
      const retired = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions
         SET status = 'retired', retired_at = now()
         WHERE agent_definition_id = $1 AND status = 'published'
         RETURNING *`,
        [agentId],
      );
      const published = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions
         SET status = 'published', published_at = now()
         WHERE id = $1 AND agent_definition_id = $2 AND status = 'draft'
         RETURNING *`,
        [versionId, agentId],
      );
      if (!published.rows[0]) throw new Error("Draft version not found");
      const publishedVersion = published.rows[0];
      for (const version of retired.rows) {
        await this.enqueueVersionLifecycle(client, organizationId, version, "retired", "human", lifecycleAt);
      }
      await this.enqueueVersionLifecycle(client, organizationId, publishedVersion, "published", "human", lifecycleAt);
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_version.published', 'agent_version', $3, $4::jsonb)`,
        [organizationId, actorId, versionId, JSON.stringify({ agentId })],
      );
      return publishedVersion;
    });
  }

  public async rollbackVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> {
    return withTransaction(this.pool, async (client) => {
      await this.assertHostedDefinition(client, organizationId, agentId);
      const agent = await client.query<AgentRecord>(
        `SELECT * FROM agent_definitions WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, agentId],
      );
      if (!agent.rows[0]) throw new Error("Agent not found");
      const target = await client.query<AgentVersionRecord>(
        `SELECT * FROM agent_versions WHERE id = $1 AND agent_definition_id = $2 FOR UPDATE`,
        [versionId, agentId],
      );
      if (!target.rows[0]) throw new Error("Version not found");
      if (target.rows[0].status === "published") return target.rows[0];
      if (target.rows[0].status !== "retired") throw new Error("Only a retired version can be rolled back");
      const lifecycleAt = new Date().toISOString();
      const retired = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions SET status = 'retired', retired_at = now()
         WHERE agent_definition_id = $1 AND status = 'published'
         RETURNING *`,
        [agentId],
      );
      const published = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions SET status = 'published', published_at = now(), retired_at = NULL
         WHERE id = $1 RETURNING *`,
        [versionId],
      );
      for (const version of retired.rows) {
        await this.enqueueVersionLifecycle(client, organizationId, version, "retired", "human", lifecycleAt);
      }
      if (published.rows[0]) {
        await this.enqueueVersionLifecycle(client, organizationId, published.rows[0], "rolled_back", "human", lifecycleAt);
      }
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_version.rolled_back', 'agent_version', $3, $4::jsonb)`,
        [organizationId, actorId, versionId, JSON.stringify({ agentId })],
      );
      return published.rows[0]!;
    });
  }

  public async retireVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> {
    return withTransaction(this.pool, async (client) => {
      const modeGuard = await client.query<{ execution_mode: AgentExecutionMode }>(
        `SELECT ai.execution_mode FROM agent_installations ai
         WHERE ai.organization_id = $1 AND ai.agent_definition_id = $2
         ORDER BY ai.updated_at DESC LIMIT 1`,
        [organizationId, agentId],
      );
      if (modeGuard.rows[0]?.execution_mode === "external_connected") {
        throw new Error("External-connected definitions cannot use hosted agent editing");
      }
      const result = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions av
         SET status = 'retired', retired_at = now()
         FROM agent_definitions ad
         WHERE av.id = $1 AND av.agent_definition_id = $2 AND ad.id = av.agent_definition_id
           AND ad.organization_id = $3 AND av.status = 'published'
         RETURNING av.*`,
        [versionId, agentId, organizationId],
      );
      const version = result.rows[0];
      if (!version) throw new Error("Published version not found");
      await this.enqueueVersionLifecycle(client, organizationId, version, "retired", "human", new Date().toISOString());
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_version.retired', 'agent_version', $3, $4::jsonb)`,
        [organizationId, actorId, versionId, JSON.stringify({ agentId })],
      );
      return version;
    });
  }

  public async archiveAgent(organizationId: string, actorId: string, agentId: string): Promise<AgentRecord> {
    return withTransaction(this.pool, async (client) => {
      await this.assertHostedDefinition(client, organizationId, agentId);
      const existing = await client.query<AgentRecord>(
        `SELECT * FROM agent_definitions
         WHERE organization_id = $1 AND id = $2 AND protected = FALSE
         FOR UPDATE`,
        [organizationId, agentId],
      );
      const previous = existing.rows[0];
      if (!previous) throw new Error("Agent not found or protected");
      const result = await client.query<AgentRecord>(
        `UPDATE agent_definitions
         SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND protected = FALSE
         RETURNING *`,
        [organizationId, agentId],
      );
      const agent = result.rows[0];
      if (!agent) throw new Error("Agent archive failed");
      if (previous.status !== "archived") {
        await this.enqueueDefinitionLifecycle(client, organizationId, agent, "archived", "archived", ["status"], "human", agent.updated_at);
      }
      const installations = await client.query<InstallationRecord>(
        `SELECT * FROM agent_installations
         WHERE organization_id = $1 AND agent_definition_id = $2 AND status <> 'disabled'
         FOR UPDATE`,
        [organizationId, agentId],
      );
      const disabled = await client.query<InstallationRecord>(
        `UPDATE agent_installations SET status = 'disabled', updated_at = now()
         WHERE organization_id = $1 AND agent_definition_id = $2 AND status <> 'disabled'
         RETURNING *`,
        [organizationId, agentId],
      );
      const previousById = new Map(installations.rows.map((installation) => [installation.id, installation.status]));
      for (const installation of disabled.rows) {
        const previousStatus = previousById.get(installation.id);
        if (previousStatus) {
          await this.enqueueInstallationLifecycle(client, installation, "disabled", previousStatus as InstallationLifecycleAnalyticsInput["previousStatus"], "human", installation.updated_at);
        }
      }
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent.archived', 'agent_definition', $3, '{}'::jsonb)`,
        [organizationId, actorId, agentId],
      );
      return agent;
    });
  }

  /**
   * Requests deletion of an organization-owned agent.
   *
   * Agents with v2 memory are archived and routed through the durable memory
   * deletion workflow first. This prevents installations from disappearing
   * before source events, checkpoints, canonical revisions, and remote
   * provider projections have been purged and acknowledged.
   */
  public async deleteAgent(organizationId: string, actorId: string, agentId: string): Promise<AgentDeletionResult> {
    const queued = await withTransaction(this.pool, async (client) => {
      const agentResult = await client.query<Pick<AgentRecord, "id" | "name" | "owner_type" | "protected" | "creation_profile" | "agent_audience" | "status">>(
        `SELECT id, name, owner_type, protected, creation_profile, agent_audience, status
         FROM agent_definitions
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [organizationId, agentId],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw Object.assign(new Error("Agent not found"), { statusCode: 404, code: "AGENT_NOT_FOUND" });
      if (agent.protected || agent.owner_type !== "organization") {
        throw Object.assign(new Error("Protected agents cannot be deleted"), { statusCode: 403, code: "AGENT_PROTECTED" });
      }

      const installations = await client.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status
         FROM agent_installations
         WHERE organization_id = $1 AND agent_definition_id = $2
         ORDER BY created_at
         FOR UPDATE`,
        [organizationId, agentId],
      );
      const installationIds = installations.rows.map((row) => row.id);
      const memoryState = await client.query<{ requires_workflow: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM agent_memory_facts WHERE organization_id = $1 AND agent_definition_id = $2) OR
           EXISTS (SELECT 1 FROM memory_source_events WHERE organization_id = $1 AND agent_definition_id = $2) OR
           EXISTS (SELECT 1 FROM memory_checkpoints WHERE organization_id = $1 AND agent_definition_id = $2) OR
           EXISTS (SELECT 1 FROM agent_memory_provider_deletion_jobs provider_job
                   WHERE provider_job.organization_id = $1
                     AND provider_job.installation_id = ANY($3::uuid[])) OR
           EXISTS (SELECT 1 FROM memory_deletion_jobs
                   WHERE organization_id = $1 AND target_type = 'agent' AND target_id = $2::text
                     AND status IN ('queued', 'running', 'held', 'provider_pending')) AS requires_workflow`,
        [organizationId, agentId, installationIds],
      );
      if (!memoryState.rows[0]?.requires_workflow) return null;

      const activeRuns = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM agent_runs
         WHERE organization_id = $1 AND agent_definition_id = $2
           AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
        [organizationId, agentId],
      );
      if (Number(activeRuns.rows[0]?.count ?? 0) > 0) {
        throw Object.assign(new Error("Cancel active agent runs before deleting this agent"), { statusCode: 409, code: "AGENT_ACTIVE_RUNS" });
      }
      const activeLegalHold = await client.query(
        `SELECT 1
         FROM agent_legal_holds
         WHERE organization_id = $1
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
           AND (
             (scope_type = 'organization' AND scope_id = $1)
             OR (scope_type = 'installation' AND scope_id = ANY($2::text[]))
           )
         LIMIT 1`,
        [organizationId, installationIds],
      );
      if (activeLegalHold.rows[0]) {
        throw Object.assign(new Error("Release the active legal hold before deleting this agent"), { statusCode: 409, code: "AGENT_LEGAL_HOLD_ACTIVE" });
      }

      const existingJob = await client.query<{ id: string }>(
        `SELECT id::text AS id
         FROM memory_deletion_jobs
         WHERE organization_id = $1 AND target_type = 'agent' AND target_id = $2
           AND status IN ('queued', 'running', 'held', 'provider_pending')
         ORDER BY created_at DESC
         LIMIT 1`,
        [organizationId, agentId],
      );
      const deletionJobId = existingJob.rows[0]?.id ?? (await client.query<{ id: string }>(
        `INSERT INTO memory_deletion_jobs
           (organization_id, requested_by, target_type, target_id, status, next_attempt_at)
         VALUES ($1, $2, 'agent', $3, 'queued', now())
         RETURNING id::text AS id`,
        [organizationId, actorId, agentId],
      )).rows[0]!.id;

      const archived = await client.query<AgentRecord>(
        `UPDATE agent_definitions
         SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [organizationId, agentId],
      );
      const archivedAgent = archived.rows[0];
      if (!archivedAgent) throw new Error("Agent archive failed");
      if (agent.status !== "archived") {
        await this.enqueueDefinitionLifecycle(client, organizationId, archivedAgent, "archived", "archived", ["status"], "human", archivedAgent.updated_at);
      }
      const disabled = await client.query<InstallationRecord>(
        `UPDATE agent_installations
         SET status = 'disabled', updated_at = now()
         WHERE organization_id = $1 AND agent_definition_id = $2 AND status <> 'disabled'
         RETURNING *`,
        [organizationId, agentId],
      );
      const previousById = new Map(installations.rows.map((installation) => [installation.id, installation.status]));
      for (const installation of disabled.rows) {
        const previousStatus = previousById.get(installation.id);
        if (previousStatus) {
          await this.enqueueInstallationLifecycle(client, installation, "disabled", previousStatus as InstallationLifecycleAnalyticsInput["previousStatus"], "human", installation.updated_at);
        }
      }
      await client.query(
        `INSERT INTO audit_records
           (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent.deletion.requested', 'agent_definition', $3, $4::jsonb)`,
        [organizationId, actorId, agentId, JSON.stringify({ deletionJobId })],
      );
      return { agentId, installationIds, deleted: false, status: "queued" as const, deletionJobId };
    });
    if (queued) return queued;
    return this.deleteAgentImmediately(organizationId, actorId, agentId);
  }

  /** Finalizer entrypoint used after the memory/provider deletion job completes. */
  public async finalizeAgentDeletion(organizationId: string, actorId: string, agentId: string): Promise<AgentDeletionResult> {
    return this.deleteAgentImmediately(organizationId, actorId, agentId);
  }

  /** Permanently removes an organization-owned agent after memory deletion is complete. */
  private async deleteAgentImmediately(organizationId: string, actorId: string, agentId: string): Promise<AgentDeletionResult> {
    return withTransaction(this.pool, async (client) => {
      const agentResult = await client.query<Pick<AgentRecord, "id" | "name" | "owner_type" | "protected" | "creation_profile" | "agent_audience" | "status">>(
        `SELECT id, name, owner_type, protected, creation_profile, agent_audience, status
         FROM agent_definitions
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [organizationId, agentId],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw Object.assign(new Error("Agent not found"), { statusCode: 404, code: "AGENT_NOT_FOUND" });
      if (agent.protected || agent.owner_type !== "organization") {
        throw Object.assign(new Error("Protected agents cannot be deleted"), { statusCode: 403, code: "AGENT_PROTECTED" });
      }

      const residualMemory = await client.query<{ requires_workflow: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM agent_memory_facts WHERE organization_id = $1 AND agent_definition_id = $2) OR
           EXISTS (SELECT 1 FROM memory_source_events WHERE organization_id = $1 AND agent_definition_id = $2) OR
           EXISTS (SELECT 1 FROM memory_checkpoints WHERE organization_id = $1 AND agent_definition_id = $2) AS requires_workflow`,
        [organizationId, agentId],
      );
      if (residualMemory.rows[0]?.requires_workflow) {
        throw Object.assign(new Error("Agent memory deletion is still pending"), { statusCode: 409, code: "AGENT_MEMORY_DELETION_PENDING" });
      }

      await client.query(
        `CREATE TEMP TABLE _agent_delete_installations ON COMMIT DROP AS
           SELECT id FROM agent_installations WHERE organization_id = $1 AND agent_definition_id = $2`,
        [organizationId, agentId],
      );
      await client.query(
        `CREATE TEMP TABLE _agent_delete_versions ON COMMIT DROP AS
           SELECT id FROM agent_versions WHERE agent_definition_id = $1`,
        [agentId],
      );
      await client.query(
        `CREATE TEMP TABLE _agent_delete_runs ON COMMIT DROP AS
           SELECT id FROM agent_runs WHERE organization_id = $1 AND agent_definition_id = $2`,
        [organizationId, agentId],
      );
      await client.query(
        `CREATE TEMP TABLE _agent_delete_conversations ON COMMIT DROP AS
           SELECT id FROM conversations WHERE organization_id = $1 AND installation_id IN (SELECT id FROM _agent_delete_installations)`,
        [organizationId],
      );
      await client.query(
        `CREATE TEMP TABLE _agent_delete_sources ON COMMIT DROP AS
           SELECT id FROM knowledge_sources
           WHERE organization_id = $1
             AND (agent_definition_id = $2 OR installation_id IN (SELECT id FROM _agent_delete_installations))`,
        [organizationId, agentId],
      );
      const installationIds = (await client.query<{ id: string }>("SELECT id::text AS id FROM _agent_delete_installations")).rows.map((row) => row.id);

      const activeRuns = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_runs
         WHERE id IN (SELECT id FROM _agent_delete_runs)
           AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
      );
      if (Number(activeRuns.rows[0]?.count ?? 0) > 0) {
        throw Object.assign(new Error("Cancel active agent runs before deleting this agent"), { statusCode: 409, code: "AGENT_ACTIVE_RUNS" });
      }
      const activeLegalHold = await client.query(
        `SELECT 1
         FROM agent_legal_holds
         WHERE organization_id = $1
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
           AND (
             (scope_type = 'organization' AND scope_id = $1)
             OR (scope_type = 'installation' AND scope_id IN (SELECT id::text FROM _agent_delete_installations))
             OR (scope_type = 'conversation' AND scope_id IN (SELECT id::text FROM _agent_delete_conversations))
           )
         LIMIT 1`,
        [organizationId],
      );
      if (activeLegalHold.rows[0]) {
        throw Object.assign(new Error("Release the active legal hold before deleting this agent"), { statusCode: 409, code: "AGENT_LEGAL_HOLD_ACTIVE" });
      }

      const providerPending = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM agent_memory_provider_deletion_jobs
         WHERE organization_id = $1
           AND installation_id IN (SELECT id FROM _agent_delete_installations)
           AND status <> 'completed'`,
        [organizationId],
      );
      if (Number(providerPending.rows[0]?.count ?? 0) > 0) {
        throw Object.assign(new Error("Remote memory provider deletion is still pending"), { statusCode: 409, code: "AGENT_PROVIDER_DELETION_PENDING" });
      }

      const deletedAt = new Date().toISOString();
      await this.enqueueDefinitionLifecycle(client, organizationId, agent, "deleted", "deleted", ["status"], "human", deletedAt);
      // Preserve immutable audit history, but remove execution, conversation, knowledge,
      // credentials, channel, and installation data owned by this agent.
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent.deleted', 'agent_definition', $3, $4::jsonb)`,
        [organizationId, actorId, agentId, JSON.stringify({ name: agent.name })],
      );
      await client.query(
        `DELETE FROM agent_delivery_obligations
         WHERE organization_id = $1
           AND (run_id IN (SELECT id FROM _agent_delete_runs)
             OR conversation_id IN (SELECT id FROM _agent_delete_conversations))`,
        [organizationId],
      );
      await client.query("DELETE FROM agent_client_assertion_replays WHERE credential_id IN (SELECT id FROM agent_installation_credentials WHERE installation_id IN (SELECT id FROM _agent_delete_installations))");
      await client.query("DELETE FROM agent_usage_records WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_installation_resource_grants WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_installation_connector_grants WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_installation_credentials WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_attachment_references WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_schedules WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_operator_holds WHERE organization_id = $1 AND ((scope_type = 'installation' AND scope_id IN (SELECT id::text FROM _agent_delete_installations)) OR (scope_type = 'run' AND scope_id IN (SELECT id::text FROM _agent_delete_runs)))", [organizationId]);
      await client.query("DELETE FROM agent_operator_feature_flags WHERE scope_type = 'installation' AND scope_id IN (SELECT id::text FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_kill_switches WHERE (organization_id = $1 AND scope_type = 'agent' AND scope_id = $2) OR (organization_id = $1 AND scope_type = 'installation' AND scope_id IN (SELECT id::text FROM _agent_delete_installations))", [organizationId, agentId]);

      await client.query("DELETE FROM agent_operator_run_assignments WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM agent_approval_records WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM agent_approval_groups WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM agent_session_transcript_entries WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM agent_effect_receipts WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM memory_consolidation_jobs WHERE trigger_run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM tool_invocations WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM run_attempts WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM run_steps WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM model_calls WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM evaluation_runs WHERE run_id IN (SELECT id FROM _agent_delete_runs) OR agent_version_id IN (SELECT id FROM _agent_delete_versions) OR scenario_id IN (SELECT id FROM evaluation_scenarios WHERE agent_definition_id = $1)", [agentId]);
      await client.query("DELETE FROM agent_events WHERE run_id IN (SELECT id FROM _agent_delete_runs) OR installation_id IN (SELECT id FROM _agent_delete_installations)");
      // Platform chat messages may reference a run without belonging to a
      // conversation, so remove those before deleting the referenced runs.
      await client.query("DELETE FROM messages WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM agent_runs WHERE id IN (SELECT id FROM _agent_delete_runs)");
      await client.query("DELETE FROM evaluation_scenarios WHERE agent_definition_id = $1", [agentId]);

      await client.query("DELETE FROM agent_approval_session_grants WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_session_transcript_entries WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_session_contexts WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM delivery_attempts WHERE conversation_id IN (SELECT id FROM _agent_delete_conversations)");
      await client.query("DELETE FROM conversation_summaries WHERE conversation_id IN (SELECT id FROM _agent_delete_conversations)");
      await client.query("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM _agent_delete_conversations)");
      await client.query("DELETE FROM participants WHERE conversation_id IN (SELECT id FROM _agent_delete_conversations)");
      await client.query("UPDATE conversations SET rotated_from_id = NULL WHERE id IN (SELECT id FROM _agent_delete_conversations)");
      await client.query("DELETE FROM conversations WHERE id IN (SELECT id FROM _agent_delete_conversations)");
      await client.query("DELETE FROM channel_pairing_tokens WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM channel_bindings WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM channel_connections WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM kasiai_user_preferences WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");

      await client.query("DELETE FROM memory_records WHERE agent_definition_id = $1 OR installation_id IN (SELECT id FROM _agent_delete_installations) OR conversation_id IN (SELECT id FROM _agent_delete_conversations)", [agentId]);
      await client.query("DELETE FROM knowledge_chunks WHERE source_id IN (SELECT id FROM _agent_delete_sources) OR agent_definition_id = $1", [agentId]);
      await client.query("DELETE FROM knowledge_sources WHERE id IN (SELECT id FROM _agent_delete_sources)");
      // Provider deletion children are retained until remote confirmation. At
      // this point the preflight above proves every child is completed, so it
      // is safe to remove the receipts before removing installations.
      await client.query("DELETE FROM agent_memory_provider_deletion_jobs WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_tool_grants WHERE agent_version_id IN (SELECT id FROM _agent_delete_versions)");
      await client.query("DELETE FROM agent_principals WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_installations WHERE id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_versions WHERE id IN (SELECT id FROM _agent_delete_versions)");
      await client.query("DELETE FROM agent_definitions WHERE organization_id = $1 AND id = $2", [organizationId, agentId]);
      return { agentId, installationIds, deleted: true, status: "deleted" as const };
    });
  }

  public async getVersion(organizationId: string, versionId: string): Promise<AgentVersionRecord | null> {
    const result = await query<AgentVersionRecord>(
      this.pool,
      `SELECT av.* FROM agent_versions av
       JOIN agent_definitions ad ON ad.id = av.agent_definition_id
       WHERE av.id = $2 AND (
         ad.organization_id = $1 OR (
           ad.owner_type = 'system' AND ad.protected = TRUE AND EXISTS (
             SELECT 1 FROM agent_installations ai
             WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
           )
         )
       )`,
      [organizationId, versionId],
    );
    return result.rows[0] ?? null;
  }

  public async createInstallation(
    organizationId: string,
    actorId: string,
    input: CreateInstallationInput,
  ): Promise<InstallationRecord> {
    const installationSettings = normalizeInstallationSettings(input.settings);
    return withTransaction(this.pool, async (client) => {
      const version = await client.query<AgentVersionRecord & { owner_type: string; protected: boolean; agent_audience: AgentAudience }>(
        `SELECT av.*, ad.owner_type, ad.protected, ad.agent_audience FROM agent_versions av
         JOIN agent_definitions ad ON ad.id = av.agent_definition_id
         WHERE av.id = $2 AND av.status = 'published' AND ad.status = 'active' AND (
           ad.organization_id = $1 OR (ad.owner_type = 'system' AND ad.protected = TRUE)
         )`,
        [organizationId, input.agentVersionId],
      );
      if (!version.rows[0]) throw new Error("Published agent version not found");
      const target = version.rows[0]!;
      const executionMode = input.executionMode ?? "kasitek_hosted";
      const releaseMode = input.releaseMode ?? defaultAgentReleaseMode(executionMode);
      if (executionMode === "external_connected") throw new Error("Use the external-agent creation flow for external installations");
      assertAgentReleaseMode(executionMode, releaseMode);
      if (executionMode === "system_hosted" && !(target.owner_type === "system" && target.protected)) {
        throw new Error("Only protected system definitions may use system_hosted mode");
      }
      if (executionMode === "system_hosted" && target.agent_audience !== "personal") {
        throw new Error("System-hosted installations must use the personal audience");
      }
      if (executionMode === "kasitek_hosted" && !(target.owner_type === "organization" && !target.protected)) {
        throw new Error("Only organization-owned definitions may use kasitek_hosted mode");
      }
      const created = await client.query<InstallationRecord>(
      `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, release_mode, settings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING *`,
        [
          target.agent_definition_id,
          input.agentVersionId,
          organizationId,
          input.scopeType,
          input.scopeId ?? organizationId,
          executionMode,
          releaseMode,
          JSON.stringify(installationSettings),
          actorId,
        ],
      );
      const installation = created.rows[0]!;
      await this.enqueueInstallationLifecycle(client, installation, "created", null, "human", installation.created_at);
      await client.query(
        `INSERT INTO agent_principals (installation_id, organization_id) VALUES ($1, $2)`,
        [installation.id, organizationId],
      );
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_installation.created', 'agent_installation', $3, $4::jsonb)`,
        [organizationId, actorId, installation.id, JSON.stringify({ versionId: input.agentVersionId, executionMode: installation.execution_mode, releaseMode: installation.release_mode })],
      );
      return installation;
    });
  }

  public async ensurePlaygroundInstallation(
    organizationId: string,
    actorId: string,
    agentId: string,
  ): Promise<InstallationRecord> {
    return withTransaction(this.pool, async (client) => {
      const version = await client.query<AgentVersionRecord & { owner_type: string; protected: boolean }>(
        `SELECT av.*, ad.owner_type, ad.protected
         FROM agent_versions av
         JOIN agent_definitions ad ON ad.id = av.agent_definition_id
         WHERE ad.id = $2 AND ad.organization_id = $1 AND ad.owner_type = 'organization'
           AND ad.protected = FALSE AND ad.status = 'active' AND av.status = 'published'
         LIMIT 1`,
        [organizationId, agentId],
      );
      const target = version.rows[0];
      if (!target) throw new Error("Published organization agent version not found");
      const created = await client.query<InstallationRecord & { created_now: boolean }>(
        `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id,
           execution_mode, release_mode, settings, created_by)
         VALUES ($1, $2, $3, 'organization', $3, 'kasitek_hosted', 'pinned', $4::jsonb, $5)
         ON CONFLICT (
           organization_id,
           agent_definition_id,
           scope_type,
           scope_id,
           (COALESCE(settings ->> 'environment', 'live'))
         )
         DO UPDATE SET updated_at = agent_installations.updated_at
         RETURNING *, (xmax = 0) AS created_now`,
        [agentId, target.id, organizationId, JSON.stringify(normalizeInstallationSettings({ environment: "playground", source: "studio", executionProfile: "autonomous" }, "playground")), actorId],
      );
      const installation = created.rows[0];
      if (!installation) throw new Error("Playground installation was not created");
      if (installation.created_now) {
        await this.enqueueInstallationLifecycle(client, installation, "created", null, "human", installation.created_at);
        await client.query(
          `INSERT INTO agent_principals (installation_id, organization_id)
           VALUES ($1, $2) ON CONFLICT (installation_id) DO NOTHING`,
          [installation.id, organizationId],
        );
        await client.query(
          `INSERT INTO audit_records
            (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'human', $2, 'agent_installation.created', 'agent_installation', $3, $4::jsonb)`,
          [organizationId, actorId, installation.id, JSON.stringify({ versionId: target.id, environment: "playground", source: "studio" })],
        );
      }
      return installation;
    });
  }

  public async deployInstallation(
    organizationId: string,
    actorId: string,
    installationId: string,
    input: DeployInstallationInput,
  ): Promise<InstallationRecord> {
    return withTransaction(this.pool, (client) => this.deploymentModule.deployInstallation(client, organizationId, actorId, installationId, input));
  }

  private async getCapabilityConfigurationDigest(
    organizationId: string,
    installationId: string | null,
    versionId: string | null,
  ): Promise<string | null> {
    if (!installationId) return null;
    const result = await query<{ digest: string }>(
      this.pool,
      `SELECT md5(COALESCE(string_agg(entry, '|' ORDER BY entry), '')) AS digest
       FROM (
         SELECT concat('connection:', integration_id, ':', COALESCE(credential_id::text, ''), ':', status, ':', configuration::text) AS entry
         FROM integration_connections
         WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
         UNION ALL
         SELECT concat('resource:', resource_type, ':', resource_id) AS entry
         FROM agent_installation_resource_grants
         WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
         UNION ALL
         SELECT concat('connector:', connector_id) AS entry
         FROM agent_installation_connector_grants
         WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
         UNION ALL
         SELECT concat('tool:', tool_name) AS entry
         FROM agent_tool_grants
         WHERE organization_id = $1 AND installation_id = $2
           AND agent_version_id = $3 AND revoked_at IS NULL
       ) capability_entries`,
      [organizationId, installationId, versionId],
    );
    return result.rows[0]?.digest ?? null;
  }

  public async getDeploymentStatus(organizationId: string, agentId: string): Promise<AgentDeploymentStatus | null> {
    const result = await query<DeploymentStatusRow>(
      this.pool,
      `SELECT definition.id AS agent_id,
              playground.id AS playground_installation_id,
              playground.status AS playground_status,
              playground_version.id AS playground_version_id,
              playground_version.version_number AS playground_version_number,
              playground_version.status AS playground_version_status,
              playground_version.checksum AS playground_digest,
              playground_version.extension_snapshot_id AS playground_extension_snapshot_id,
              playground_snapshot.checksum AS playground_extension_snapshot_checksum,
              live.id AS live_installation_id,
              live.status AS live_status,
              live_version.id AS live_version_id,
              live_version.version_number AS live_version_number,
              live_version.status AS live_version_status,
              live_version.checksum AS live_digest,
              live_version.extension_snapshot_id AS live_extension_snapshot_id,
              live_snapshot.checksum AS live_extension_snapshot_checksum,
              latest.id AS latest_promotion_id,
              latest.agent_version_id AS latest_candidate_version_id,
              latest.previous_agent_version_id AS latest_previous_version_id,
              latest.source_installation_id AS latest_source_installation_id,
              latest.capability_configuration_digest AS latest_capability_configuration_digest,
              latest.binding_revision AS latest_binding_revision,
              latest.created_at AS latest_promotion_created_at,
              rollback_version.id AS rollback_version_id,
              rollback_version.version_number AS rollback_version_number,
              rollback_version.status AS rollback_version_status,
              rollback_version.checksum AS rollback_digest,
              rollback_version.extension_snapshot_id AS rollback_extension_snapshot_id,
              rollback_snapshot.checksum AS rollback_extension_snapshot_checksum
       FROM agent_definitions definition
       LEFT JOIN LATERAL (
         SELECT installation.* FROM agent_installations installation
         WHERE installation.organization_id = $1
           AND installation.agent_definition_id = definition.id
           AND COALESCE(installation.settings ->> 'environment', 'live') = 'playground'
         ORDER BY installation.updated_at DESC LIMIT 1
       ) playground ON TRUE
       LEFT JOIN agent_versions playground_version ON playground_version.id = playground.agent_version_id
       LEFT JOIN agent_extension_snapshots playground_snapshot ON playground_snapshot.id = playground_version.extension_snapshot_id
       LEFT JOIN LATERAL (
         SELECT installation.* FROM agent_installations installation
         WHERE installation.organization_id = $1
           AND installation.agent_definition_id = definition.id
           AND COALESCE(installation.settings ->> 'environment', 'live') = 'live'
         ORDER BY installation.updated_at DESC LIMIT 1
       ) live ON TRUE
       LEFT JOIN agent_versions live_version ON live_version.id = live.agent_version_id
       LEFT JOIN agent_extension_snapshots live_snapshot ON live_snapshot.id = live_version.extension_snapshot_id
       LEFT JOIN LATERAL (
         SELECT deployment.* FROM agent_installation_deployments deployment
         WHERE deployment.organization_id = $1
           AND deployment.installation_id = live.id
           AND deployment.outcome = 'success'
           AND deployment.idempotency_key IS NOT NULL
         ORDER BY deployment.created_at DESC LIMIT 1
       ) latest ON TRUE
       LEFT JOIN agent_versions rollback_version ON rollback_version.id = latest.previous_agent_version_id
       LEFT JOIN agent_extension_snapshots rollback_snapshot ON rollback_snapshot.id = rollback_version.extension_snapshot_id
       WHERE definition.id = $2
         AND (
           definition.organization_id = $1
           OR (
             definition.owner_type = 'system' AND definition.protected = TRUE
             AND EXISTS (
               SELECT 1 FROM agent_installations visible
               WHERE visible.organization_id = $1 AND visible.agent_definition_id = definition.id
             )
           )
         )`,
      [organizationId, agentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const [playgroundCapabilityConfigurationDigest, liveCapabilityConfigurationDigest] = await Promise.all([
      this.getCapabilityConfigurationDigest(organizationId, row.playground_installation_id, row.playground_version_id),
      this.getCapabilityConfigurationDigest(organizationId, row.live_installation_id, row.live_version_id),
    ]);
    const playground = row.playground_version_id ? projectDeploymentVersionRow({
      version_id: row.playground_version_id,
      version_number: row.playground_version_number,
      status: row.playground_version_status,
      checksum: row.playground_digest,
      extension_snapshot_id: row.playground_extension_snapshot_id,
      extension_snapshot_checksum: row.playground_extension_snapshot_checksum,
    }) : null;
    const live = row.live_version_id ? projectDeploymentVersionRow({
      version_id: row.live_version_id,
      version_number: row.live_version_number,
      status: row.live_version_status,
      checksum: row.live_digest,
      extension_snapshot_id: row.live_extension_snapshot_id,
      extension_snapshot_checksum: row.live_extension_snapshot_checksum,
    }) : null;
    const rollbackTarget = row.rollback_version_id ? projectDeploymentVersionRow({
      version_id: row.rollback_version_id,
      version_number: row.rollback_version_number,
      status: row.rollback_version_status,
      checksum: row.rollback_digest,
      extension_snapshot_id: row.rollback_extension_snapshot_id,
      extension_snapshot_checksum: row.rollback_extension_snapshot_checksum,
    }) : null;
    const blocked = !row.playground_installation_id || !row.live_installation_id
      || row.playground_status !== "active" || row.live_status !== "active";
    const differs = Boolean(playground && live && (
      playground.versionId !== live.versionId
      || playground.extensionSnapshotChecksum !== live.extensionSnapshotChecksum
      || playgroundCapabilityConfigurationDigest !== liveCapabilityConfigurationDigest
    ));
    const state = blocked
      ? "blocked"
      : differs
        ? "pending"
        : rollbackTarget
          ? "rollback_available"
          : "deployed";
    return {
      agentId: row.agent_id,
      state,
      status: state,
      playground: {
        installationId: row.playground_installation_id,
        status: row.playground_status,
        version: playground,
        capabilityConfigurationDigest: playgroundCapabilityConfigurationDigest,
      },
      live: {
        installationId: row.live_installation_id,
        status: row.live_status,
        version: live,
        capabilityConfigurationDigest: liveCapabilityConfigurationDigest,
      },
      rollbackTarget,
      latestPromotion: row.latest_promotion_id ? {
        id: row.latest_promotion_id,
        candidateVersionId: row.latest_candidate_version_id,
        previousVersionId: row.latest_previous_version_id,
        sourceInstallationId: row.latest_source_installation_id,
        capabilityConfigurationDigest: row.latest_capability_configuration_digest,
        bindingRevision: row.latest_binding_revision,
        createdAt: row.latest_promotion_created_at ?? "",
      } : null,
    };
  }

  public async preflightInstallationDeployment(
    organizationId: string,
    installationId: string,
    input: InstallationDeploymentPreflightInput,
  ): Promise<DeploymentPreflightResult> {
    return withTransaction(this.pool, (client) => this.deploymentModule.preflightInstallation(client, organizationId, installationId, input));
  }

  public async promoteInstallation(
    organizationId: string,
    actorId: string,
    installationId: string,
    input: InstallationPromotionInput,
  ): Promise<DeploymentActivationResult> {
    return withTransaction(this.pool, (client) => this.deploymentModule.promoteInstallation(client, organizationId, actorId, installationId, input));
  }

  public async rollbackInstallation(
    organizationId: string,
    actorId: string,
    installationId: string,
    input: InstallationRollbackInput,
  ): Promise<DeploymentActivationResult> {
    return withTransaction(this.pool, (client) => this.deploymentModule.rollbackInstallation(client, organizationId, actorId, installationId, input));
  }

  public async ensureSystemInstallation(input: {
    organizationId: string;
    actorId: string;
    systemSlug: string;
    scopeType?: "organization" | "user" | "business";
    scopeId?: string;
    settings?: Record<string, unknown>;
  }): Promise<SystemInstallationRecord> {
    const scopeType = input.scopeType ?? "organization";
    const scopeId = input.scopeId ?? input.organizationId;
    return withTransaction(this.pool, async (client) => {
      const version = await client.query<AgentVersionRecord & { name: string; slug: string }>(
        `SELECT av.*, ad.name, ad.slug FROM agent_versions av
         JOIN agent_definitions ad ON ad.id = av.agent_definition_id
         WHERE ad.organization_id = $1 AND ad.owner_type = 'system' AND ad.protected = TRUE
           AND ad.status = 'active' AND ad.slug = $2 AND av.status = 'published'
         LIMIT 1`,
        [SYSTEM_ORGANIZATION_ID, input.systemSlug],
      );
      const target = version.rows[0];
      if (!target) throw new Error("Published system agent version not found");
      const created = await client.query<InstallationRecord & { created_now: boolean }>(
        `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
         VALUES ($1, $2, $3, $4, $5, 'system_hosted', $6::jsonb, $7)
         ON CONFLICT (
           organization_id,
           agent_definition_id,
           scope_type,
           scope_id,
           (COALESCE(settings ->> 'environment', 'live'))
         )
         DO UPDATE SET updated_at = agent_installations.updated_at
         RETURNING *, (xmax = 0) AS created_now`,
        [
          target.agent_definition_id,
          target.id,
          input.organizationId,
          scopeType,
          scopeId,
          JSON.stringify(normalizeInstallationSettings(input.settings)),
          input.actorId,
        ],
      );
      const installation = created.rows[0]!;
      if (installation.created_now) {
        await this.enqueueInstallationLifecycle(client, installation, "created", null, "system", installation.created_at);
      }
      await client.query(
        `INSERT INTO agent_principals (installation_id, organization_id)
         VALUES ($1, $2)
         ON CONFLICT (installation_id) DO NOTHING`,
        [installation.id, input.organizationId],
      );
      if (input.systemSlug === "kasiai") {
        await client.query(
          `INSERT INTO channel_connections
            (organization_id, installation_id, channel_type, channel_key, metadata, created_by)
           VALUES ($1, $2, 'platform', 'sidebar', $3::jsonb, $4)
           ON CONFLICT (organization_id, channel_type, channel_key) DO UPDATE
           SET installation_id = EXCLUDED.installation_id,
               metadata = EXCLUDED.metadata,
               status = 'active',
               updated_at = now()`,
          [input.organizationId, installation.id, JSON.stringify({ managed: true, channel: "authenticated-platform" }), input.actorId],
        );
      }
      if (installation.created_now) {
        await client.query(
          `INSERT INTO audit_records
            (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'human', $2, 'system_agent_installation.created', 'agent_installation', $3, $4::jsonb)`,
          [
            input.organizationId,
            input.actorId,
            installation.id,
            JSON.stringify({ agentId: target.agent_definition_id, versionId: target.id, systemSlug: input.systemSlug, executionMode: installation.execution_mode }),
          ],
        );
      }
      await this.ensureSystemKnowledge(client, {
        organizationId: input.organizationId,
        agentDefinitionId: target.agent_definition_id,
        installationId: installation.id,
        actorId: input.actorId,
      });
      if (input.systemSlug === "kasiai") {
        await this.ensureSystemEvaluations(client, {
          organizationId: input.organizationId,
          agentDefinitionId: target.agent_definition_id,
          actorId: input.actorId,
        });
      }
      return {
        ...installation,
        agent_name: target.name,
        agent_slug: target.slug,
        agent_protected: true,
        version_number: target.version_number,
        created: installation.created_now,
      };
    });
  }

  private async ensureSystemEvaluations(
    client: PoolClient,
    input: { organizationId: string; agentDefinitionId: string; actorId: string },
  ): Promise<void> {
    for (const scenario of KASIAI_EVALUATION_SCENARIOS) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM evaluation_scenarios
         WHERE organization_id = $1 AND agent_definition_id = $2 AND name = $3 AND status = 'active'
         LIMIT 1`,
        [input.organizationId, input.agentDefinitionId, scenario.name],
      );
      if (existing.rows[0]) continue;
      await client.query(
        `INSERT INTO evaluation_scenarios
          (organization_id, agent_definition_id, name, description, input, assertions, rubric, tags, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          input.organizationId,
          input.agentDefinitionId,
          scenario.name,
          scenario.description,
          JSON.stringify({ ...scenario.input, managedBy: "kasitek", evaluationVersion: KASIAI_EVALUATION_VERSION }),
          JSON.stringify(scenario.assertions),
          JSON.stringify({ kind: "deterministic-contract", version: KASIAI_EVALUATION_VERSION }),
          [...scenario.tags, `version:${KASIAI_EVALUATION_VERSION}`],
          input.actorId,
        ],
      );
    }
  }

  private async ensureSystemKnowledge(
    client: PoolClient,
    input: { organizationId: string; agentDefinitionId: string; installationId: string; actorId: string },
  ): Promise<void> {
    await client.query(
      `UPDATE knowledge_sources
       SET status = 'deleted', deleted_at = now(), updated_at = now()
       WHERE organization_id = $1 AND agent_definition_id = $2 AND installation_id = $3
         AND status = 'active' AND provenance->>'kind' = 'kasiai-platform-guidance'
         AND name <> $4`,
      [input.organizationId, input.agentDefinitionId, input.installationId, KASIAI_KNOWLEDGE_SOURCE_NAME],
    );
    const existing = await client.query<{ id: string; revision: number; provenance: Record<string, unknown> }>(
      `SELECT id, revision, provenance
       FROM knowledge_sources
       WHERE organization_id = $1 AND agent_definition_id = $2 AND installation_id = $3
         AND name = $4 AND status = 'active'
       LIMIT 1
       FOR UPDATE`,
      [input.organizationId, input.agentDefinitionId, input.installationId, KASIAI_KNOWLEDGE_SOURCE_NAME],
    );
    const source = existing.rows[0] ?? (await client.query<{ id: string; revision: number }>(
      `INSERT INTO knowledge_sources
        (organization_id, agent_definition_id, installation_id, name, source_type, provenance, created_by)
       VALUES ($1, $2, $3, $4, 'platform', $5::jsonb, $6)
       RETURNING id, revision`,
      [
        input.organizationId,
        input.agentDefinitionId,
        input.installationId,
        KASIAI_KNOWLEDGE_SOURCE_NAME,
        JSON.stringify({ kind: "kasiai-platform-guidance", version: KASIAI_KNOWLEDGE_VERSION, managedBy: "kasitek" }),
        input.actorId,
      ],
    )).rows[0]!;
    const revision = KASIAI_KNOWLEDGE_VERSION;
    for (const [chunkIndex, text] of KASIAI_KNOWLEDGE_CHUNKS.entries()) {
      await client.query(
        `INSERT INTO knowledge_chunks
          (source_id, organization_id, agent_definition_id, installation_id, revision, chunk_index, canonical_text, metadata, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         ON CONFLICT (source_id, revision, chunk_index) DO UPDATE
         SET canonical_text = EXCLUDED.canonical_text,
             metadata = EXCLUDED.metadata,
             provenance = EXCLUDED.provenance`,
        [
          source.id,
          input.organizationId,
          input.agentDefinitionId,
          input.installationId,
          revision,
          chunkIndex,
          text,
          JSON.stringify({ managed: true, knowledgeVersion: KASIAI_KNOWLEDGE_VERSION }),
          JSON.stringify({ source: KASIAI_KNOWLEDGE_SOURCE_NAME, version: KASIAI_KNOWLEDGE_VERSION, chunkIndex }),
        ],
      );
    }
    await client.query(
      `UPDATE knowledge_sources SET revision = $2, provenance = $3::jsonb, updated_at = now() WHERE id = $1`,
      [source.id, revision, JSON.stringify({ kind: "kasiai-platform-guidance", version: KASIAI_KNOWLEDGE_VERSION, managedBy: "kasitek" })],
    );
  }

  public async getSystemInstallation(input: {
    organizationId: string;
    systemSlug: string;
    scopeType?: "organization" | "user" | "business";
    scopeId?: string;
    environment?: AgentEnvironment;
  }): Promise<SystemInstallationRecord | null> {
    const result = await query<SystemInstallationRecord>(
      this.pool,
      `SELECT ai.*, ad.name AS agent_name, ad.slug AS agent_slug,
              ad.protected AS agent_protected, av.version_number, FALSE AS created
       FROM agent_installations ai
       JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
       JOIN agent_versions av ON av.id = ai.agent_version_id
         WHERE ai.organization_id = $1 AND ad.organization_id = $2
         AND ad.owner_type = 'system' AND ad.protected = TRUE AND ad.slug = $3
         AND ai.scope_type = $4 AND ai.scope_id = $5
         AND COALESCE(ai.settings ->> 'environment', 'live') = $6
       LIMIT 1`,
      [
        input.organizationId,
        SYSTEM_ORGANIZATION_ID,
        input.systemSlug,
        input.scopeType ?? "organization",
        input.scopeId ?? input.organizationId,
        input.environment ?? "live",
      ],
    );
    return result.rows[0] ?? null;
  }

  public async getInstallation(
    organizationId: string,
    installationId: string,
  ): Promise<(InstallationRecord & InstallationIdentity) | null> {
    const result = await query<InstallationRecord & InstallationIdentity>(
      this.pool,
      `SELECT ai.*, ad.owner_type AS agent_owner_type,
              ad.protected AS agent_protected, ad.slug AS agent_slug,
              ad.agent_audience
       FROM agent_installations ai
       JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
       WHERE ai.organization_id = $1 AND ai.id = $2`,
      [organizationId, installationId],
    );
    return result.rows[0] ?? null;
  }

  public async setInstallationStatus(
    organizationId: string,
    installationId: string,
    status: "active" | "paused" | "disabled",
    actorId: string,
  ): Promise<InstallationRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<InstallationRecord>(
        `SELECT * FROM agent_installations
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [organizationId, installationId],
      );
      const previous = current.rows[0];
      if (!previous) throw new Error("Installation not found");
      const result = await client.query<InstallationRecord>(
        `UPDATE agent_installations
         SET status = $3, updated_at = now()
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [organizationId, installationId, status],
      );
      const installation = result.rows[0];
      if (!installation) throw new Error("Installation not found");
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, $3, 'agent_installation', $4, $5::jsonb)`,
        [organizationId, actorId, `agent_installation.${status}`, installationId, JSON.stringify({ executionMode: installation.execution_mode })],
      );
      if (previous.status !== status) {
        await this.enqueueInstallationLifecycle(
          client,
          installation,
          status === "active" ? "activated" : status,
          previous.status as InstallationLifecycleAnalyticsInput["previousStatus"],
          "human",
          installation.updated_at,
        );
      }
      return installation;
    });
  }

  private async enqueueInstallationLifecycle(
    client: PoolClient,
    installation: InstallationRecord,
    action: InstallationLifecycleAnalyticsInput["action"],
    previousStatus: InstallationLifecycleAnalyticsInput["previousStatus"],
    actorType: InstallationLifecycleAnalyticsInput["actorType"],
    occurredAt: Date | string,
  ): Promise<void> {
    const result = await client.query<InstallationAnalyticsRow>(
      `SELECT ai.*, ad.creation_profile, ad.agent_audience
       FROM agent_installations ai
       JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
       WHERE ai.organization_id = $1 AND ai.id = $2`,
      [installation.organization_id, installation.id],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Installation analytics context not found");
    await enqueueOutbox(client, buildInstallationLifecycleEvent({
      installationId: row.id,
      organizationId: row.organization_id,
      agentDefinitionId: row.agent_definition_id,
      agentVersionId: row.agent_version_id,
      executionMode: row.execution_mode,
      creationProfile: row.creation_profile,
      agentAudience: row.agent_audience,
      scopeType: row.scope_type as InstallationLifecycleAnalyticsInput["scopeType"],
      action,
      status: row.status as InstallationLifecycleAnalyticsInput["status"],
      previousStatus,
      actorType,
      occurredAt,
    }));
  }

  private async enqueueVersionLifecycle(
    client: PoolClient,
    organizationId: string,
    version: AgentVersionRecord,
    action: VersionLifecycleAnalyticsInput["action"],
    actorType: VersionLifecycleAnalyticsInput["actorType"],
    occurredAt: Date | string,
  ): Promise<void> {
    await enqueueOutbox(client, buildVersionLifecycleEvent({
      organizationId,
      agentDefinitionId: version.agent_definition_id,
      agentVersionId: version.id,
      versionNumber: version.version_number,
      status: version.status as VersionLifecycleAnalyticsInput["status"],
      action,
      actorType,
      occurredAt,
    }));
  }

  private async enqueueDefinitionLifecycle(
    client: PoolClient,
    organizationId: string,
    agent: Pick<AgentRecord, "id" | "owner_type" | "creation_profile" | "agent_audience">,
    action: DefinitionLifecycleAnalyticsInput["action"],
    status: DefinitionLifecycleAnalyticsInput["status"],
    changedFields: DefinitionLifecycleAnalyticsInput["changedFields"],
    actorType: DefinitionLifecycleAnalyticsInput["actorType"],
    occurredAt: Date | string,
  ): Promise<void> {
    await enqueueOutbox(client, buildDefinitionLifecycleEvent({
      organizationId,
      agentDefinitionId: agent.id,
      ownerType: agent.owner_type as DefinitionLifecycleAnalyticsInput["ownerType"],
      creationProfile: agent.creation_profile,
      agentAudience: agent.agent_audience,
      action,
      status,
      changedFields,
      actorType,
      occurredAt,
    }));
  }

  public async setInstallationSettings(
    organizationId: string,
    installationId: string,
    actorId: string,
    settings: Record<string, unknown>,
  ): Promise<InstallationRecord> {
    const result = await query<InstallationRecord & { protected: boolean }>(
      this.pool,
      `UPDATE agent_installations ai
       SET settings = COALESCE(ai.settings, '{}'::jsonb) || $3::jsonb, updated_at = now()
       FROM agent_definitions ad
       WHERE ai.id = $1 AND ai.organization_id = $2 AND ad.id = ai.agent_definition_id
       RETURNING ai.*, ad.protected`,
      [installationId, organizationId, JSON.stringify(settings)],
    );
    const installation = result.rows[0];
    if (!installation) throw new Error("Installation not found");
    await query(
      this.pool,
      `INSERT INTO audit_records
        (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'human', $2, 'agent_installation.settings_updated', 'agent_installation', $3, $4::jsonb)`,
      [organizationId, actorId, installationId, JSON.stringify({ keys: Object.keys(settings), protected: installation.protected, executionMode: installation.execution_mode })],
    );
    return installation;
  }
}
