import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CreateAgentInput,
  CreateInstallationInput,
  CreateVersionInput,
} from "../../domain/types";
import { query, withTransaction } from "../pool";
import { validateVersionWorkflow } from "../../workflows/graph";
import { getAgentTemplate, templateVersionInput } from "../../system/templates";

type DbExecutor = Pool | PoolClient;

export const SYSTEM_ORGANIZATION_ID = "kasitek-system";

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
  installation_id?: string | null;
  installation_status?: string | null;
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
  settings: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
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
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, settings, created_by)
         VALUES ($1, $2, $3, 'organization', $3, $4::jsonb, $5)
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
    input: CreateAgentInput & { organizationId?: string },
  ): Promise<AgentRecord> {
    const organizationId = input.organizationId ?? SYSTEM_ORGANIZATION_ID;
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

  public async ensureSystemAgent(
    actorId: string,
    input: CreateAgentInput & { organizationId?: string },
  ): Promise<AgentRecord> {
    const organizationId = input.organizationId ?? SYSTEM_ORGANIZATION_ID;
    const slug = input.slug ?? slugify(input.name);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_definitions
          (organization_id, owner_type, name, slug, description, protected, created_by)
         VALUES ($1, 'system', $2, $3, $4, TRUE, $5)
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
         WHERE agent_definition_id = $1 AND status <> 'disabled' FOR UPDATE`,
        [agentId],
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
      `SELECT ad.*, ai.id AS installation_id, ai.status AS installation_status,
              av.version_number
       FROM agent_definitions ad
       LEFT JOIN LATERAL (
         SELECT ai.* FROM agent_installations ai
         WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
         ORDER BY ai.updated_at DESC LIMIT 1
       ) ai ON TRUE
       LEFT JOIN agent_versions av ON av.id = ai.agent_version_id
       WHERE ad.organization_id = $1 OR (
         ad.owner_type = 'system' AND ad.protected = TRUE AND EXISTS (
           SELECT 1 FROM agent_installations ai
           WHERE ai.agent_definition_id = ad.id AND ai.organization_id = $1
         )
       )
       ORDER BY ad.protected DESC, ad.created_at DESC`,
      [organizationId],
    );
    return result.rows;
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
      const version = await client.query<AgentVersionRecord>(
        `SELECT av.* FROM agent_versions av
         JOIN agent_definitions ad ON ad.id = av.agent_definition_id
         WHERE av.id = $2 AND av.status = 'published' AND ad.status = 'active' AND (
           ad.organization_id = $1 OR (ad.owner_type = 'system' AND ad.protected = TRUE)
         )`,
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
          (agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, settings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
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
      if (installation.created_now) {
        await client.query(
          `INSERT INTO audit_records
            (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'human', $2, 'system_agent_installation.created', 'agent_installation', $3, $4::jsonb)`,
          [
            input.organizationId,
            input.actorId,
            installation.id,
            JSON.stringify({ agentId: target.agent_definition_id, versionId: target.id, systemSlug: input.systemSlug }),
          ],
        );
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
