-- First-class, organization-scoped procedural skills. Skill versions are
-- immutable once published and agent versions pin a specific skill version.
CREATE TABLE IF NOT EXISTS agent_skill_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('platform', 'organization', 'user')),
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deprecated', 'revoked')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS agent_skill_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_definition_id UUID NOT NULL REFERENCES agent_skill_definitions(id),
  organization_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired', 'revoked')),
  instructions TEXT NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 40000),
  matching JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_capabilities TEXT[] NOT NULL DEFAULT '{}',
  required_connectors TEXT[] NOT NULL DEFAULT '{}',
  knowledge_source_ids TEXT[] NOT NULL DEFAULT '{}',
  compatible_channels TEXT[] NOT NULL DEFAULT '{}',
  compatible_audiences TEXT[] NOT NULL DEFAULT '{}',
  checksum TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (skill_definition_id, version_number)
);

CREATE INDEX IF NOT EXISTS agent_skill_definitions_scope_idx
  ON agent_skill_definitions (organization_id, status, slug);
CREATE INDEX IF NOT EXISTS agent_skill_versions_definition_idx
  ON agent_skill_versions (skill_definition_id, status, version_number DESC);

CREATE TABLE IF NOT EXISTS agent_version_skills (
  organization_id TEXT NOT NULL,
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  skill_version_id UUID NOT NULL REFERENCES agent_skill_versions(id),
  pinned_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_version_id, skill_version_id)
);

CREATE INDEX IF NOT EXISTS agent_version_skills_scope_idx
  ON agent_version_skills (organization_id, agent_version_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_skill_definitions, agent_skill_versions, agent_version_skills TO kasitek_agents_runtime;

ALTER TABLE agent_skill_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skill_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skill_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_version_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_version_skills FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_skill_definitions_agents_scope ON agent_skill_definitions
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (owner_type = 'platform' AND status = 'published')
    OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (owner_type IN ('organization', 'user') AND organization_id = NULLIF(current_setting('kasitek.organization_id', true), ''))
  );

CREATE POLICY agent_skill_versions_agents_scope ON agent_skill_versions
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR EXISTS (
      SELECT 1 FROM agent_skill_definitions skill
      WHERE skill.id = agent_skill_versions.skill_definition_id
        AND (
          (skill.owner_type = 'platform' AND skill.status = 'published')
          OR skill.organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
        )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR EXISTS (
      SELECT 1 FROM agent_skill_definitions skill
      WHERE skill.id = agent_skill_versions.skill_definition_id
        AND skill.organization_id = agent_skill_versions.organization_id
        AND skill.owner_type IN ('organization', 'user')
        AND skill.organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
    )
  );

CREATE POLICY agent_version_skills_agents_scope ON agent_version_skills
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND EXISTS (
        SELECT 1 FROM agent_versions version
        JOIN agent_definitions definition ON definition.id = version.agent_definition_id
        WHERE version.id = agent_version_skills.agent_version_id
          AND definition.organization_id = agent_version_skills.organization_id
      )
      AND EXISTS (
        SELECT 1 FROM agent_skill_versions skill_version
        JOIN agent_skill_definitions skill ON skill.id = skill_version.skill_definition_id
        WHERE skill_version.id = agent_version_skills.skill_version_id
          AND (skill.organization_id = agent_version_skills.organization_id OR skill.owner_type = 'platform')
          AND skill.status = 'published'
          AND skill_version.status = 'published'
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND EXISTS (
        SELECT 1 FROM agent_versions version
        JOIN agent_definitions definition ON definition.id = version.agent_definition_id
        WHERE version.id = agent_version_skills.agent_version_id
          AND definition.organization_id = agent_version_skills.organization_id
      )
      AND EXISTS (
        SELECT 1 FROM agent_skill_versions skill_version
        JOIN agent_skill_definitions skill ON skill.id = skill_version.skill_definition_id
        WHERE skill_version.id = agent_version_skills.skill_version_id
          AND (skill.organization_id = agent_version_skills.organization_id OR skill.owner_type = 'platform')
          AND skill.status = 'published'
          AND skill_version.status = 'published'
      )
    )
  );
