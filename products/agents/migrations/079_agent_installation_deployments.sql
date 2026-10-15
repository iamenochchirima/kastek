-- Durable deployment history is the source of truth for rollback evidence and
-- allows operators to distinguish a version that was published from one that
-- was actually moved to an installation.
CREATE TABLE IF NOT EXISTS agent_installation_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  previous_agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  release_mode TEXT NOT NULL CHECK (release_mode IN ('pinned', 'follow_published', 'staged')),
  action TEXT NOT NULL CHECK (action IN ('deployed', 'rolled_back', 'failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('version_published', 'version_rolled_back', 'manual', 'canary')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_code TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'system')),
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_installation_deployments_organization_ids CHECK (length(organization_id) > 0),
  CONSTRAINT agent_installation_deployments_error_code_length CHECK (error_code IS NULL OR length(error_code) <= 120)
);

CREATE INDEX IF NOT EXISTS agent_installation_deployments_scope_idx
  ON agent_installation_deployments (organization_id, installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_installation_deployments_version_idx
  ON agent_installation_deployments (organization_id, agent_definition_id, agent_version_id, created_at DESC);

COMMENT ON TABLE agent_installation_deployments IS
  'Immutable version deployment attempts for installation rollout, rollback, and reconciliation evidence.';

CREATE OR REPLACE FUNCTION kasitek_validate_agent_installation_deployment_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agent_installations ai
    JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
    WHERE ai.id = NEW.installation_id
      AND ai.organization_id = NEW.organization_id
      AND ai.agent_definition_id = NEW.agent_definition_id
      AND ad.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Deployment installation, definition, and organization do not match';
  END IF;
  IF NEW.agent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_versions av
    WHERE av.id = NEW.agent_version_id AND av.agent_definition_id = NEW.agent_definition_id
  ) THEN
    RAISE EXCEPTION 'Deployment target version does not belong to its definition';
  END IF;
  IF NEW.previous_agent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_versions av
    WHERE av.id = NEW.previous_agent_version_id AND av.agent_definition_id = NEW.agent_definition_id
  ) THEN
    RAISE EXCEPTION 'Deployment previous version does not belong to its definition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_installation_deployments_scope_trigger ON agent_installation_deployments;
CREATE TRIGGER agent_installation_deployments_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, installation_id, agent_definition_id,
  previous_agent_version_id, agent_version_id ON agent_installation_deployments
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_agent_installation_deployment_scope();
