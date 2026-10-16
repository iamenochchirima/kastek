CREATE TABLE IF NOT EXISTS agent_tool_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  installation_id UUID REFERENCES agent_installations(id),
  tool_name TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CHECK (length(trim(tool_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_tool_grants_active_idx
  ON agent_tool_grants (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_tool_grants_effective_idx
  ON agent_tool_grants (organization_id, agent_version_id, installation_id, revoked_at);

INSERT INTO agent_tool_grants (organization_id, agent_version_id, tool_name, granted_by)
SELECT ad.organization_id, av.id, tool_name, av.created_by
FROM agent_versions av
JOIN agent_definitions ad ON ad.id = av.agent_definition_id
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(av.policy -> 'allowedTools', '[]'::jsonb)) AS tool(tool_name)
WHERE jsonb_typeof(av.policy -> 'allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM agent_tool_grants existing
    WHERE existing.agent_version_id = av.id
      AND existing.installation_id IS NULL
      AND existing.tool_name = tool_name
      AND existing.revoked_at IS NULL
  );
