-- Hermes-style linked skill files are immutable children of a skill version.
-- File contents stay out of the compact skill index and are loaded only by an
-- explicit skill_view request for a pinned, dependency-ready skill.
CREATE TABLE IF NOT EXISTS agent_skill_version_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_version_id UUID NOT NULL REFERENCES agent_skill_versions(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  path TEXT NOT NULL CHECK (
    path !~ '(^/|/$|//|(^|/)\.\.($|/))'
    AND path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
  ),
  content TEXT NOT NULL CHECK (char_length(content) <= 100000),
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_version_id, path)
);

CREATE INDEX IF NOT EXISTS agent_skill_version_files_version_idx
  ON agent_skill_version_files (skill_version_id, path);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_skill_version_files TO kasitek_agents_runtime;

ALTER TABLE agent_skill_version_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skill_version_files FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_skill_version_files_agents_scope ON agent_skill_version_files
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR EXISTS (
      SELECT 1
      FROM agent_skill_versions version
      JOIN agent_skill_definitions skill ON skill.id = version.skill_definition_id
      WHERE version.id = agent_skill_version_files.skill_version_id
        AND version.organization_id = agent_skill_version_files.organization_id
        AND (
          (skill.owner_type = 'platform' AND skill.status = 'published')
          OR skill.organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
        )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR EXISTS (
      SELECT 1
      FROM agent_skill_versions version
      JOIN agent_skill_definitions skill ON skill.id = version.skill_definition_id
      WHERE version.id = agent_skill_version_files.skill_version_id
        AND version.organization_id = agent_skill_version_files.organization_id
        AND skill.organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
        AND skill.owner_type IN ('organization', 'user')
    )
  );
