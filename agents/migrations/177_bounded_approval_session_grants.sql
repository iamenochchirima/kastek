-- A session grant widens one reviewed approval only within an exact
-- conversation, actor, capability/version, and resource selector. It is not
-- a persistent or organization-wide approval allow-list.
ALTER TABLE agent_approval_records
  ADD COLUMN IF NOT EXISTS resource_selector JSONB;

COMMENT ON COLUMN agent_approval_records.resource_selector IS
  'Exact manifest resource selector captured with the reviewed approval; null for legacy or unscoped operations';

CREATE TABLE IF NOT EXISTS agent_approval_session_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL CHECK (length(btrim(session_key)) BETWEEN 1 AND 240),
  actor_id TEXT NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 240),
  capability TEXT NOT NULL CHECK (length(btrim(capability)) BETWEEN 1 AND 240),
  capability_version TEXT NOT NULL CHECK (length(btrim(capability_version)) BETWEEN 1 AND 80),
  policy_revision TEXT NOT NULL CHECK (length(btrim(policy_revision)) BETWEEN 1 AND 160),
  resource_type TEXT NOT NULL CHECK (length(btrim(resource_type)) BETWEEN 1 AND 160),
  resource_argument TEXT NOT NULL CHECK (length(btrim(resource_argument)) BETWEEN 1 AND 160),
  resource_value TEXT NOT NULL CHECK (length(btrim(resource_value)) BETWEEN 1 AND 240),
  granted_by TEXT NOT NULL CHECK (length(btrim(granted_by)) BETWEEN 1 AND 240),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CHECK (session_key = 'conversation:' || installation_id::text || ':' || conversation_id::text),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
  UNIQUE (
    organization_id, session_key, actor_id, capability, capability_version,
    policy_revision, resource_type, resource_argument, resource_value
  )
);

CREATE INDEX IF NOT EXISTS agent_approval_session_grants_lookup_idx
  ON agent_approval_session_grants (
    organization_id, installation_id, conversation_id, actor_id,
    capability, capability_version, policy_revision, expires_at
  ) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_approval_session_grants_expiry_idx
  ON agent_approval_session_grants (organization_id, expires_at)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON agent_approval_session_grants TO kasitek_agents_runtime;

ALTER TABLE agent_approval_session_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_approval_session_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_approval_session_grants_agents_scope ON agent_approval_session_grants;
CREATE POLICY agent_approval_session_grants_agents_scope ON agent_approval_session_grants
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_installations installation
        WHERE installation.id = agent_approval_session_grants.installation_id
          AND installation.organization_id = agent_approval_session_grants.organization_id
      )
      AND EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = agent_approval_session_grants.conversation_id
          AND conversation.organization_id = agent_approval_session_grants.organization_id
          AND conversation.installation_id = agent_approval_session_grants.installation_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_installations installation
        WHERE installation.id = agent_approval_session_grants.installation_id
          AND installation.organization_id = agent_approval_session_grants.organization_id
      )
      AND EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = agent_approval_session_grants.conversation_id
          AND conversation.organization_id = agent_approval_session_grants.organization_id
          AND conversation.installation_id = agent_approval_session_grants.installation_id
      )
    )
  );

COMMENT ON TABLE agent_approval_session_grants IS
  'Bounded, actor/session/resource-scoped approval reuse; never a permanent global approval grant';
