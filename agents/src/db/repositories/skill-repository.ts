import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import {
  createSkillInputSchema,
  createSkillVersionInputSchema,
  skillMatchingSchema,
  type CreateSkillInput,
  type CreateSkillVersionInput,
  type SkillDefinitionRecord,
  type SkillVersionRecord,
} from "../../skills/contracts";

export class SkillRepository {
  public constructor(private readonly pool: Pool) {}

  public async createSkill(organizationId: string, actorId: string, input: CreateSkillInput): Promise<SkillDefinitionRecord> {
    const parsed = createSkillInputSchema.parse(input);
    const result = await query<SkillDefinitionRecord>(
      this.pool,
      `INSERT INTO agent_skill_definitions
        (organization_id, owner_type, owner_id, slug, name, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [organizationId, parsed.ownerType, parsed.ownerType === "user" ? actorId : organizationId, parsed.slug, parsed.name, parsed.description ?? null, actorId],
    );
    if (!result.rows[0]) throw new Error("SKILL_CREATE_FAILED");
    return result.rows[0];
  }

  public async createVersion(organizationId: string, actorId: string, skillId: string, input: CreateSkillVersionInput): Promise<SkillVersionRecord> {
    const parsed = createSkillVersionInputSchema.parse(input);
    return withTransaction(this.pool, async (client) => {
      const definition = await client.query<SkillDefinitionRecord>(
        `SELECT * FROM agent_skill_definitions
         WHERE id = $1 AND organization_id = $2 AND owner_type IN ('organization', 'user')
         FOR UPDATE`,
        [skillId, organizationId],
      );
      if (!definition.rows[0] || definition.rows[0].status === "revoked") throw new Error("SKILL_NOT_FOUND");
      const next = await client.query<{ version_number: number }>(
        "SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM agent_skill_versions WHERE skill_definition_id = $1",
        [skillId],
      );
      const versionNumber = Number(next.rows[0]!.version_number);
      const checksum = createHash("sha256").update(JSON.stringify({ ...parsed, skillId, versionNumber })).digest("hex");
      const created = await client.query<SkillVersionRecord>(
        `INSERT INTO agent_skill_versions
          (skill_definition_id, organization_id, version_number, instructions, matching,
           required_capabilities, required_connectors, knowledge_source_ids,
           compatible_channels, compatible_audiences, checksum, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [skillId, organizationId, versionNumber, parsed.instructions, JSON.stringify(parsed.matching), parsed.requiredCapabilities, parsed.requiredConnectors, parsed.knowledgeSourceIds, parsed.compatibleChannels, parsed.compatibleAudiences, checksum, actorId],
      );
      if (!created.rows[0]) throw new Error("SKILL_VERSION_CREATE_FAILED");
      return hydrateSkillVersion(created.rows[0]);
    });
  }

  public async publishVersion(organizationId: string, actorId: string, skillId: string, versionId: string): Promise<SkillVersionRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<SkillVersionRecord>(
        `UPDATE agent_skill_versions version
         SET status = 'published', published_at = COALESCE(published_at, now())
         WHERE version.id = $1 AND version.skill_definition_id = $2 AND version.organization_id = $3
           AND version.status = 'draft'
           AND EXISTS (
             SELECT 1 FROM agent_skill_definitions skill
             WHERE skill.id = version.skill_definition_id AND skill.organization_id = $3 AND skill.status <> 'revoked'
           )
         RETURNING version.*`,
        [versionId, skillId, organizationId],
      );
      if (!result.rows[0]) throw new Error("SKILL_VERSION_NOT_FOUND_OR_NOT_DRAFT");
      await client.query("UPDATE agent_skill_definitions SET status = 'published', updated_at = now() WHERE id = $1 AND organization_id = $2", [skillId, organizationId]);
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_skill_version.published', 'agent_skill_version', $3, $4::jsonb)`,
        [organizationId, actorId, versionId, JSON.stringify({ skillId })],
      );
      return hydrateSkillVersion(result.rows[0]);
    });
  }

  public async revokeVersion(organizationId: string, actorId: string, skillId: string, versionId: string): Promise<void> {
    const result = await query(
      this.pool,
      `UPDATE agent_skill_versions SET status = 'revoked'
       WHERE id = $1 AND skill_definition_id = $2 AND organization_id = $3 AND status <> 'revoked'`,
      [versionId, skillId, organizationId],
    );
    if (!result.rowCount) throw new Error("SKILL_VERSION_NOT_FOUND");
    await query(this.pool, "INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata) VALUES ($1, 'human', $2, 'agent_skill_version.revoked', 'agent_skill_version', $3, $4::jsonb)", [organizationId, actorId, versionId, JSON.stringify({ skillId })]);
  }

  public async listSkills(organizationId: string): Promise<SkillDefinitionRecord[]> {
    const result = await query<SkillDefinitionRecord>(
      this.pool,
      `SELECT * FROM agent_skill_definitions
       WHERE (organization_id = $1 OR owner_type = 'platform') AND status <> 'revoked'
       ORDER BY owner_type DESC, name ASC`,
      [organizationId],
    );
    return result.rows;
  }

  public async listVersions(organizationId: string, skillId: string): Promise<SkillVersionRecord[]> {
    const result = await query<SkillVersionRecord>(
      this.pool,
      `SELECT version.*, skill.slug AS skill_slug, skill.name AS skill_name, skill.status AS skill_status
       FROM agent_skill_versions version
       JOIN agent_skill_definitions skill ON skill.id = version.skill_definition_id
       WHERE version.skill_definition_id = $1
         AND (skill.organization_id = $2 OR skill.owner_type = 'platform')
         AND version.status <> 'revoked'
       ORDER BY version.version_number DESC`,
      [skillId, organizationId],
    );
    return result.rows.map(hydrateSkillVersion);
  }

  public async pinVersion(organizationId: string, actorId: string, agentVersionId: string, skillVersionId: string): Promise<void> {
    const result = await query(
      this.pool,
      `INSERT INTO agent_version_skills (organization_id, agent_version_id, skill_version_id, pinned_by)
       SELECT $1, version.id, skill.id, $2
       FROM agent_versions version
       JOIN agent_definitions definition ON definition.id = version.agent_definition_id
       JOIN agent_skill_versions skill ON skill.id = $4 AND skill.status = 'published'
       JOIN agent_skill_definitions skill_definition ON skill_definition.id = skill.skill_definition_id
       WHERE version.id = $3 AND definition.organization_id = $1
         AND (skill_definition.organization_id = $1 OR skill_definition.owner_type = 'platform')
         AND skill_definition.status = 'published'
       ON CONFLICT (agent_version_id, skill_version_id) DO NOTHING`,
      [organizationId, actorId, agentVersionId, skillVersionId],
    );
    if (!result.rowCount) throw new Error("SKILL_VERSION_NOT_FOUND_OR_NOT_PUBLISHED");
  }

  public async unpinVersion(organizationId: string, agentVersionId: string, skillVersionId: string): Promise<void> {
    const result = await query(this.pool, "DELETE FROM agent_version_skills WHERE organization_id = $1 AND agent_version_id = $2 AND skill_version_id = $3", [organizationId, agentVersionId, skillVersionId]);
    if (!result.rowCount) throw new Error("SKILL_PIN_NOT_FOUND");
  }

  public async loadPinnedVersions(organizationId: string, agentVersionId: string): Promise<SkillVersionRecord[]> {
    const result = await query<SkillVersionRecord>(
      this.pool,
      `SELECT skill_version.*, skill.slug AS skill_slug, skill.name AS skill_name, skill.status AS skill_status
       FROM agent_version_skills pin
       JOIN agent_skill_versions skill_version ON skill_version.id = pin.skill_version_id
       JOIN agent_skill_definitions skill ON skill.id = skill_version.skill_definition_id
       WHERE pin.organization_id = $1 AND pin.agent_version_id = $2
         AND skill_version.status = 'published' AND skill.status = 'published'
       ORDER BY skill.name ASC, skill_version.version_number DESC`,
      [organizationId, agentVersionId],
    );
    return result.rows.map(hydrateSkillVersion);
  }
}

function hydrateSkillVersion(row: SkillVersionRecord): SkillVersionRecord {
  return {
    ...row,
    matching: skillMatchingSchema.parse(typeof row.matching === "string" ? JSON.parse(row.matching) : row.matching ?? {}),
    required_capabilities: Array.isArray(row.required_capabilities) ? row.required_capabilities : [],
    required_connectors: Array.isArray(row.required_connectors) ? row.required_connectors : [],
    knowledge_source_ids: Array.isArray(row.knowledge_source_ids) ? row.knowledge_source_ids : [],
    compatible_channels: Array.isArray(row.compatible_channels) ? row.compatible_channels : [],
    compatible_audiences: Array.isArray(row.compatible_audiences) ? row.compatible_audiences as SkillVersionRecord["compatible_audiences"] : [],
  };
}
