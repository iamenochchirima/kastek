import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CreateAgentInput,
  CreateInstallationInput,
  CreateVersionInput,
} from "../../domain/types";
import { query, withTransaction } from "../pool";
import { validateVersionWorkflow } from "../../workflows/graph";

type DbExecutor = Pool | PoolClient;

export interface AgentRecord {
  id: string;
  organization_id: string;
  owner_type: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  protected: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
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
  settings: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

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
        (organization_id, owner_type, name, slug, description, protected, created_by)
       VALUES ($1, 'organization', $2, $3, $4, $5, $6)
       RETURNING *`,
      [organizationId, input.name, slug, input.description ?? null, isProtected, actorId],
    );
    return result.rows[0]!;
  }

  public async createSystemAgent(
    actorId: string,
    input: CreateAgentInput & { organizationId?: string },
  ): Promise<AgentRecord> {
    const organizationId = input.organizationId ?? "kasitek-system";
    const slug = input.slug ?? slugify(input.name);
    const result = await query<AgentRecord>(
      this.pool,
      `INSERT INTO agent_definitions
        (organization_id, owner_type, name, slug, description, protected, created_by)
       VALUES ($1, 'system', $2, $3, $4, TRUE, $5)
       RETURNING *`,
      [organizationId, input.name, slug, input.description ?? null, actorId],
    );
    return result.rows[0]!;
  }

  public async getAgent(organizationId: string, agentId: string): Promise<AgentRecord | null> {
    const result = await query<AgentRecord>(
      this.pool,
      "SELECT * FROM agent_definitions WHERE organization_id = $1 AND id = $2",
      [organizationId, agentId],
    );
    return result.rows[0] ?? null;
  }

  public async listAgents(organizationId: string): Promise<AgentRecord[]> {
    const result = await query<AgentRecord>(
      this.pool,
      `SELECT * FROM agent_definitions
       WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return result.rows;
  }

  public async listVersions(organizationId: string, agentId: string): Promise<AgentVersionRecord[]> {
    const result = await query<AgentVersionRecord>(
      this.pool,
      `SELECT av.* FROM agent_versions av
       JOIN agent_definitions ad ON ad.id = av.agent_definition_id
       WHERE ad.organization_id = $1 AND ad.id = $2
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
      const checksum = checksumVersion(input, versionNumber);
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
          JSON.stringify(input.policy),
          checksum,
          actorId,
        ],
      );
      const allowedTools = Array.isArray(input.policy.allowedTools)
        ? input.policy.allowedTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
        : [];
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

  public async getVersion(organizationId: string, versionId: string): Promise<AgentVersionRecord | null> {
    const result = await query<AgentVersionRecord>(
      this.pool,
      `SELECT av.* FROM agent_versions av
       JOIN agent_definitions ad ON ad.id = av.agent_definition_id
       WHERE ad.organization_id = $1 AND av.id = $2`,
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
      const version = await client.query<AgentVersionRecord>(
        `SELECT av.* FROM agent_versions av
         JOIN agent_definitions ad ON ad.id = av.agent_definition_id
         WHERE ad.organization_id = $1 AND av.id = $2 AND av.status = 'published'`,
        [organizationId, input.agentVersionId],
      );
      if (!version.rows[0]) throw new Error("Published agent version not found");
      const created = await client.query<InstallationRecord>(
        `INSERT INTO agent_installations
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, settings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [
          version.rows[0].agent_definition_id,
          input.agentVersionId,
          organizationId,
          input.scopeType,
          input.scopeId,
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
        [organizationId, actorId, installation.id, JSON.stringify({ versionId: input.agentVersionId })],
      );
      return installation;
    });
  }

  public async getInstallation(
    organizationId: string,
    installationId: string,
  ): Promise<(InstallationRecord & { agent_definition_id: string; agent_version_id: string }) | null> {
    const result = await query<InstallationRecord>(
      this.pool,
      `SELECT * FROM agent_installations
       WHERE organization_id = $1 AND id = $2`,
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
       VALUES ($1, 'human', $2, $3, 'agent_installation', $4, '{}'::jsonb)`,
      [organizationId, actorId, `agent_installation.${status}`, installationId],
    );
    return installation;
  }
}
