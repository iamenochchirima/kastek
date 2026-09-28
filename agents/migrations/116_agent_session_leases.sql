-- Durable, organization-scoped ownership for one logical agent session.
-- Released rows remain in place so fencing_token never resets when a lease is
-- reacquired after expiry or an explicit release.
CREATE TABLE IF NOT EXISTS agent_session_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  session_key TEXT NOT NULL CHECK (length(btrim(session_key)) > 0),
  owner_id TEXT NOT NULL CHECK (length(btrim(owner_id)) > 0),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  fencing_token BIGINT NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, session_key),
  CHECK (
    (status = 'active' AND released_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS agent_session_leases_expiry_idx
  ON agent_session_leases (organization_id, status, expires_at);

CREATE INDEX IF NOT EXISTS agent_session_leases_owner_idx
  ON agent_session_leases (organization_id, owner_id, run_id, status);

DROP TRIGGER IF EXISTS agent_session_leases_ownership_trigger ON agent_session_leases;
CREATE TRIGGER agent_session_leases_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON agent_session_leases
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();

GRANT SELECT, INSERT, UPDATE ON agent_session_leases TO kasitek_agents_runtime;

ALTER TABLE agent_session_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_leases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_session_leases_agents_scope ON agent_session_leases;
CREATE POLICY agent_session_leases_agents_scope ON agent_session_leases
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1
        FROM agent_runs run
        WHERE run.id = agent_session_leases.run_id
          AND run.organization_id = agent_session_leases.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1
        FROM agent_runs run
        WHERE run.id = agent_session_leases.run_id
          AND run.organization_id = agent_session_leases.organization_id
      )
    )
  );
