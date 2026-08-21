import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AgentExecutionMode,
  CreateAgentInput,
  CreateExternalAgentInput,
  CreateInstallationInput,
  CreateVersionInput,
  HostedAgentCreationProfile,
  UpdateAgentInput,
} from "../../domain/types";
import { query, withTransaction } from "../pool";
import { validateVersionWorkflow } from "../../workflows/graph";
import { normalizeModelPolicy } from "../../model/policy";
import { getAgentTemplate, templateVersionInput } from "../../system/templates";
import { resolveHostedAgentAllowedTools } from "../../system/hosted-agent-defaults";
import { KASIAI_KNOWLEDGE_CHUNKS, KASIAI_KNOWLEDGE_SOURCE_NAME, KASIAI_KNOWLEDGE_VERSION } from "../../system/kasiai-knowledge";
import { KASIAI_EVALUATION_SCENARIOS, KASIAI_EVALUATION_VERSION } from "../../system/kasiai-evaluations";
import { createInstallationCredentialInTransaction, type CreatedInstallationCredential } from "./installation-credential-repository";

type DbExecutor = Pool | PoolClient;

export const SYSTEM_ORGANIZATION_ID = "kasitek-system";

export interface AgentRecord {
  id: string;
  organization_id: string;
  owner_type: string;
  name: string;
  slug: string;
  description: string | null;
  creation_profile: HostedAgentCreationProfile | "system";
  status: string;
  protected: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  installation_id?: string | null;
  execution_mode?: AgentExecutionMode | null;
  installation_status?: string | null;
  installation_settings?: Record<string, unknown> | null;
  version_number?: number | null;
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
  created_by: string;
  created_at: string;
  published_at: string | null;
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
}

export interface InstallationIdentity {
  agent_owner_type: string;
  agent_protected: boolean;
  agent_slug: string;
}

export interface SystemInstallationRecord extends InstallationRecord {
  agent_name: string;
  agent_slug: string;
  agent_protected: boolean;
  version_number: number;
  created: boolean;
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

type CreateSystemAgentInput = Omit<CreateAgentInput, "creationProfile"> & { creationProfile?: HostedAgentCreationProfile };

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function checksumVersion(input: CreateVersionInput, versionNumber: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...input, versionNumber }))
    .digest("hex");
}

export class AgentRepository {
  public constructor(private readonly pool: Pool) {}

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
    const slug = input.slug ?? slugify(input.name);
    const result = await query<AgentRecord>(
      this.pool,
      `INSERT INTO agent_definitions
        (organization_id, owner_type, name, slug, description, creation_profile, protected, created_by)
       VALUES ($1, 'organization', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [organizationId, input.name, slug, input.description ?? null, input.creationProfile ?? "custom", isProtected, actorId],
    );
    return result.rows[0]!;
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
    const requestedSlug = input.slug ?? `${slugify(input.name) || "external-agent"}-external`.slice(0, 80);
    const settings = {
      externalConnectionKey: input.idempotencyKey,
      runtime: input.runtime,
      protocols: input.protocols,
      capabilities: input.capabilities,
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
          (organization_id, owner_type, name, slug, description, protected, created_by)
         VALUES ($1, 'organization', $2, $3, $4, FALSE, $5)
         RETURNING *`,
        [organizationId, input.name, requestedSlug, input.description ?? null, actorId],
      );
      const agent = agentResult.rows[0]!;
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
          JSON.stringify({ allowedTools: input.capabilities }),
          checksumVersion({ instructions: input.instructions, configuration: { executionMode: "external_connected", runtime: input.runtime, protocols: input.protocols }, policy: { allowedTools: input.capabilities } }, 1),
          actorId,
        ],
      );
      const version = versionResult.rows[0]!;
      for (const toolName of input.capabilities) {
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
    const developerApiKeyId = input.apiKeyId.trim();
    const actorId = `developer-api-key:${developerApiKeyId}`;
    const settings = {
      developerApiKeyId,
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
          return { agent: agentResult.rows[0], version: versionResult.rows[0], installation, created: false };
        }

        const agentResult = await client.query<AgentRecord>(
          `INSERT INTO agent_definitions
            (organization_id, owner_type, name, slug, description, protected, created_by)
           VALUES ($1, 'organization', $2, $3, $4, FALSE, $5)
           RETURNING *`,
          [input.organizationId, "KasiTek Developer API", slug, "Workspace MCP access for Developer API keys", actorId],
        );
        const agent = agentResult.rows[0]!;
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
        const version = versionResult.rows[0]!;
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
    const settings = input.settings ?? {};
    const versionInput = templateVersionInput(template, settings);
    validateVersionWorkflow(versionInput.configuration);
    const name = input.name?.trim() || template.name;
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, protected, created_by)
         VALUES ($1, 'organization', $2, $3, $4, FALSE, $5)
         ON CONFLICT (organization_id, slug) DO NOTHING`,
        [input.organizationId, name, template.key, template.description, input.actorId],
      );
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
      const existingVersion = await client.query<AgentVersionRecord>(
        `SELECT * FROM agent_versions WHERE agent_definition_id = $1 AND status = 'published' LIMIT 1`,
        [agent.id],
      );
      let version = existingVersion.rows[0];
      let created = false;
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
            JSON.stringify(versionInput.policy),
            checksumVersion(versionInput, versionNumber),
            input.actorId,
          ],
        );
        version = inserted.rows[0]!;
        created = true;
        const allowedTools = Array.isArray(versionInput.policy.allowedTools)
          ? versionInput.policy.allowedTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
          : [];
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
      }
      const installationResult = await client.query<InstallationRecord>(
        `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
         VALUES ($1, $2, $3, 'organization', $3, 'kasitek_hosted', $4::jsonb, $5)
         ON CONFLICT (organization_id, agent_definition_id, scope_type, scope_id)
         DO UPDATE SET updated_at = agent_installations.updated_at
         RETURNING *`,
        [agent.id, version.id, input.organizationId, JSON.stringify({ ...settings, templateKey: template.key, templateVersion: template.version }), input.actorId],
      );
      const installation = installationResult.rows[0]!;
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
    const result = await query<AgentRecord>(
      this.pool,
      `INSERT INTO agent_definitions
        (organization_id, owner_type, name, slug, description, creation_profile, protected, created_by)
       VALUES ($1, 'system', $2, $3, $4, 'system', TRUE, $5)
       RETURNING *`,
      [organizationId, input.name, slug, input.description ?? null, actorId],
    );
    return result.rows[0]!;
  }

  public async ensureSystemAgent(
    actorId: string,
    input: CreateSystemAgentInput & { organizationId?: string },
  ): Promise<AgentRecord> {
    const organizationId = input.organizationId ?? SYSTEM_ORGANIZATION_ID;
    const slug = input.slug ?? slugify(input.name);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, creation_profile, protected, created_by)
         VALUES ($1, 'system', $2, $3, $4, 'system', TRUE, $5)
         ON CONFLICT (organization_id, slug) DO NOTHING`,
        [organizationId, input.name, slug, input.description ?? null, actorId],
      );
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
      return updated.rows[0]!;
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
        return published.rows[0];
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
      const version = created.rows[0]!;
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
      if (current.rows[0]?.instructions === input.instructions
        && JSON.stringify(current.rows[0].configuration) === JSON.stringify(input.configuration)
        && JSON.stringify(current.rows[0].policy) === JSON.stringify(input.policy)) return current.rows[0];
      const next = await client.query<{ version_number: number }>(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
         FROM agent_versions WHERE agent_definition_id = $1`,
        [agentId],
      );
      if (current.rows[0]) {
        await client.query("UPDATE agent_versions SET status = 'retired' WHERE id = $1", [current.rows[0].id]);
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
      const version = created.rows[0]!;
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

  public async listAgents(organizationId: string): Promise<AgentRecord[]> {
    const result = await query<AgentRecord>(
      this.pool,
      `SELECT ad.*, ai.id AS installation_id, ai.execution_mode, ai.status AS installation_status,
              ai.settings AS installation_settings,
              av.version_number
       FROM agent_definitions ad
       LEFT JOIN LATERAL (
         SELECT ai.* FROM agent_installations ai
         WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
         ORDER BY ai.updated_at DESC LIMIT 1
       ) ai ON TRUE
       LEFT JOIN agent_versions av ON av.id = ai.agent_version_id
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
       ORDER BY ad.protected DESC, ad.created_at DESC`,
      [organizationId],
    );
    return result.rows;
  }

  public async listExternalAgents(organizationId: string): Promise<AgentRecord[]> {
    const result = await query<AgentRecord>(
      this.pool,
      `SELECT ad.*, ai.id AS installation_id, ai.execution_mode, ai.status AS installation_status,
              ai.settings AS installation_settings, av.version_number
       FROM agent_definitions ad
       JOIN LATERAL (
         SELECT ai.* FROM agent_installations ai
         WHERE ai.agent_definition_id = ad.id
           AND ai.organization_id = $1
           AND ai.execution_mode = 'external_connected'
         ORDER BY ai.updated_at DESC LIMIT 1
       ) ai ON TRUE
       JOIN agent_versions av ON av.id = ai.agent_version_id
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
      await client.query(
        `UPDATE agent_installations SET status = 'disabled', updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [installationId, organizationId],
      );
      await client.query(
        `UPDATE agent_definitions SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND owner_type = 'organization' AND protected = FALSE`,
        [installation.agent_definition_id, organizationId],
      );
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
      const allowedTools = resolveHostedAgentAllowedTools(agent.rows[0]!.creation_profile, normalizedPolicy.allowedTools);
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
      for (const toolName of allowedTools) {
        await client.query(
          `INSERT INTO agent_tool_grants
            (organization_id, agent_version_id, tool_name, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [organizationId, created.rows[0]!.id, toolName.trim(), actorId],
        );
      }
      return created.rows[0]!;
    });
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
      await client.query(
        `UPDATE agent_versions
         SET status = 'retired', retired_at = now()
         WHERE agent_definition_id = $1 AND status = 'published'`,
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
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_version.published', 'agent_version', $3, $4::jsonb)`,
        [organizationId, actorId, versionId, JSON.stringify({ agentId })],
      );
      return published.rows[0]!;
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
      await client.query(
        `UPDATE agent_versions SET status = 'retired', retired_at = now()
         WHERE agent_definition_id = $1 AND status = 'published'`,
        [agentId],
      );
      const published = await client.query<AgentVersionRecord>(
        `UPDATE agent_versions SET status = 'published', published_at = now(), retired_at = NULL
         WHERE id = $1 RETURNING *`,
        [versionId],
      );
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
    const modeGuard = await query<{ execution_mode: AgentExecutionMode }>(
      this.pool,
      `SELECT ai.execution_mode FROM agent_installations ai
       WHERE ai.organization_id = $1 AND ai.agent_definition_id = $2
       ORDER BY ai.updated_at DESC LIMIT 1`,
      [organizationId, agentId],
    );
    if (modeGuard.rows[0]?.execution_mode === "external_connected") {
      throw new Error("External-connected definitions cannot use hosted agent editing");
    }
    const result = await query<AgentVersionRecord>(
      this.pool,
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
    await query(
      this.pool,
      `INSERT INTO audit_records
        (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'human', $2, 'agent_version.retired', 'agent_version', $3, $4::jsonb)`,
      [organizationId, actorId, versionId, JSON.stringify({ agentId })],
    );
    return version;
  }

  public async archiveAgent(organizationId: string, actorId: string, agentId: string): Promise<AgentRecord> {
    return withTransaction(this.pool, async (client) => {
      await this.assertHostedDefinition(client, organizationId, agentId);
      const result = await client.query<AgentRecord>(
        `UPDATE agent_definitions
         SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND protected = FALSE
         RETURNING *`,
        [organizationId, agentId],
      );
      const agent = result.rows[0];
      if (!agent) throw new Error("Agent not found or protected");
      await client.query(
        `UPDATE agent_installations SET status = 'disabled', updated_at = now()
         WHERE organization_id = $1 AND agent_definition_id = $2 AND status <> 'disabled'`,
        [organizationId, agentId],
      );
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent.archived', 'agent_definition', $3, '{}'::jsonb)`,
        [organizationId, actorId, agentId],
      );
      return agent;
    });
  }

  /** Permanently removes an organization-owned agent and all agent-scoped data. */
  public async deleteAgent(organizationId: string, actorId: string, agentId: string): Promise<{ agentId: string; installationIds: string[]; deleted: true }> {
    return withTransaction(this.pool, async (client) => {
      const agentResult = await client.query<Pick<AgentRecord, "id" | "name" | "owner_type" | "protected">>(
        `SELECT id, name, owner_type, protected
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

      // Preserve immutable audit history, but remove execution, conversation, knowledge,
      // credentials, channel, and installation data owned by this agent.
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent.deleted', 'agent_definition', $3, $4::jsonb)`,
        [organizationId, actorId, agentId, JSON.stringify({ name: agent.name })],
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
      await client.query("DELETE FROM agent_effect_receipts WHERE run_id IN (SELECT id FROM _agent_delete_runs)");
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
      await client.query("DELETE FROM agent_tool_grants WHERE agent_version_id IN (SELECT id FROM _agent_delete_versions)");
      await client.query("DELETE FROM agent_principals WHERE installation_id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_installations WHERE id IN (SELECT id FROM _agent_delete_installations)");
      await client.query("DELETE FROM agent_versions WHERE id IN (SELECT id FROM _agent_delete_versions)");
      await client.query("DELETE FROM agent_definitions WHERE organization_id = $1 AND id = $2", [organizationId, agentId]);
      return { agentId, installationIds, deleted: true };
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
    return withTransaction(this.pool, async (client) => {
      const version = await client.query<AgentVersionRecord & { owner_type: string; protected: boolean }>(
        `SELECT av.*, ad.owner_type, ad.protected FROM agent_versions av
         JOIN agent_definitions ad ON ad.id = av.agent_definition_id
         WHERE av.id = $2 AND av.status = 'published' AND ad.status = 'active' AND (
           ad.organization_id = $1 OR (ad.owner_type = 'system' AND ad.protected = TRUE)
         )`,
        [organizationId, input.agentVersionId],
      );
      if (!version.rows[0]) throw new Error("Published agent version not found");
      const target = version.rows[0]!;
      const executionMode = input.executionMode ?? "kasitek_hosted";
      if (executionMode === "external_connected") throw new Error("Use the external-agent creation flow for external installations");
      if (executionMode === "system_hosted" && !(target.owner_type === "system" && target.protected)) {
        throw new Error("Only protected system definitions may use system_hosted mode");
      }
      if (executionMode === "kasitek_hosted" && !(target.owner_type === "organization" && !target.protected)) {
        throw new Error("Only organization-owned definitions may use kasitek_hosted mode");
      }
      const created = await client.query<InstallationRecord>(
      `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, settings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING *`,
        [
          target.agent_definition_id,
          input.agentVersionId,
          organizationId,
          input.scopeType,
          input.scopeId ?? organizationId,
          executionMode,
          JSON.stringify(input.settings),
          actorId,
        ],
      );
      const installation = created.rows[0]!;
      await client.query(
        `INSERT INTO agent_principals (installation_id, organization_id) VALUES ($1, $2)`,
        [installation.id, organizationId],
      );
      await client.query(
        `INSERT INTO audit_records
          (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_installation.created', 'agent_installation', $3, $4::jsonb)`,
        [organizationId, actorId, installation.id, JSON.stringify({ versionId: input.agentVersionId, executionMode: installation.execution_mode })],
      );
      return installation;
    });
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
         ON CONFLICT (organization_id, agent_definition_id, scope_type, scope_id)
         DO UPDATE SET updated_at = agent_installations.updated_at
         RETURNING *, (xmax = 0) AS created_now`,
        [
          target.agent_definition_id,
          target.id,
          input.organizationId,
          scopeType,
          scopeId,
          JSON.stringify(input.settings ?? {}),
          input.actorId,
        ],
      );
      const installation = created.rows[0]!;
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
       LIMIT 1`,
      [
        input.organizationId,
        SYSTEM_ORGANIZATION_ID,
        input.systemSlug,
        input.scopeType ?? "organization",
        input.scopeId ?? input.organizationId,
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
              ad.protected AS agent_protected, ad.slug AS agent_slug
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
    const result = await query<InstallationRecord>(
      this.pool,
      `UPDATE agent_installations
       SET status = $3, updated_at = now()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [organizationId, installationId, status],
    );
    const installation = result.rows[0];
    if (!installation) throw new Error("Installation not found");
    await query(
      this.pool,
      `INSERT INTO audit_records
        (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'human', $2, $3, 'agent_installation', $4, $5::jsonb)`,
      [organizationId, actorId, `agent_installation.${status}`, installationId, JSON.stringify({ executionMode: installation.execution_mode })],
    );
    return installation;
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
