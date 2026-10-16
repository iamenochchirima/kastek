-- External memory-provider readiness is a separate projection of the
-- canonical revision.  A provider may acknowledge a write before it is
-- searchable; those states must never be collapsed into "saved".

CREATE TABLE IF NOT EXISTS agent_memory_provider_projection_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  provider_name TEXT NOT NULL CHECK (length(trim(provider_name)) BETWEEN 1 AND 160),
  provider_record_id TEXT CHECK (provider_record_id IS NULL OR length(trim(provider_record_id)) BETWEEN 1 AND 512),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'revalidate')),
  provider_state TEXT NOT NULL CHECK (provider_state IN ('accepted', 'indexed', 'visible', 'failed', 'deleted')),
  accepted_at TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ,
  visible_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  provider_operation_id TEXT CHECK (provider_operation_id IS NULL OR length(trim(provider_operation_id)) BETWEEN 1 AND 512),
  content_digest TEXT NOT NULL CHECK (length(trim(content_digest)) BETWEEN 1 AND 256),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,119}$'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (revision_id, provider_name, operation),
  CHECK (indexed_at IS NULL OR accepted_at IS NOT NULL),
  CHECK (visible_at IS NULL OR indexed_at IS NOT NULL),
  CHECK (deleted_at IS NULL OR provider_state = 'deleted')
);

CREATE INDEX IF NOT EXISTS agent_memory_provider_projection_receipts_scope_idx
  ON agent_memory_provider_projection_receipts (organization_id, workspace_id, installation_id, provider_name, provider_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_provider_projection_receipts_revision_idx
  ON agent_memory_provider_projection_receipts (organization_id, revision_id, provider_name, operation);

CREATE OR REPLACE FUNCTION kasitek_validate_memory_provider_projection_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected RECORD;
BEGIN
  SELECT fact.organization_id,
         fact.workspace_id,
         fact.agent_definition_id,
         fact.installation_id,
         fact.agent_version_id,
         revision.fact_id AS revision_fact_id
  INTO expected
  FROM agent_memory_revisions revision
  JOIN agent_memory_facts fact ON fact.id = revision.fact_id
  WHERE revision.id = NEW.revision_id;
  IF NOT FOUND
    OR expected.organization_id <> NEW.organization_id
    OR expected.workspace_id <> NEW.workspace_id
    OR expected.agent_definition_id <> NEW.agent_definition_id
    OR expected.installation_id <> NEW.installation_id
    OR expected.agent_version_id IS DISTINCT FROM NEW.agent_version_id
    OR expected.revision_fact_id <> NEW.fact_id
  THEN
    RAISE EXCEPTION 'Memory provider projection is outside the canonical revision scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kasitek_validate_memory_provider_projection_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.provider_state IS DISTINCT FROM OLD.provider_state THEN
    IF NOT (
      (OLD.provider_state = 'accepted' AND NEW.provider_state IN ('indexed', 'visible', 'failed', 'deleted')) OR
      (OLD.provider_state = 'indexed' AND NEW.provider_state IN ('visible', 'failed', 'deleted')) OR
      (OLD.provider_state = 'visible' AND NEW.provider_state = 'deleted') OR
      (OLD.provider_state = 'failed' AND NEW.provider_state IN ('accepted', 'indexed', 'deleted'))
    ) THEN
      RAISE EXCEPTION 'Invalid memory provider projection transition: % -> %', OLD.provider_state, NEW.provider_state;
    END IF;
  END IF;
  IF NEW.provider_state IN ('accepted', 'indexed', 'visible') AND NEW.accepted_at IS NULL THEN
    RAISE EXCEPTION 'Provider readiness requires accepted_at';
  END IF;
  IF NEW.provider_state IN ('indexed', 'visible') AND NEW.indexed_at IS NULL THEN
    RAISE EXCEPTION 'Indexed provider readiness requires indexed_at';
  END IF;
  IF NEW.provider_state = 'visible' AND NEW.visible_at IS NULL THEN
    RAISE EXCEPTION 'Visible provider readiness requires visible_at';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kasitek_touch_memory_provider_projection_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.observed_at := COALESCE(NEW.observed_at, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_provider_projection_scope_trigger ON agent_memory_provider_projection_receipts;
CREATE TRIGGER agent_memory_provider_projection_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, fact_id, revision_id
ON agent_memory_provider_projection_receipts
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_provider_projection_scope();

DROP TRIGGER IF EXISTS agent_memory_provider_projection_transition_trigger ON agent_memory_provider_projection_receipts;
CREATE TRIGGER agent_memory_provider_projection_transition_trigger
BEFORE INSERT OR UPDATE ON agent_memory_provider_projection_receipts
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_provider_projection_transition();

DROP TRIGGER IF EXISTS agent_memory_provider_projection_updated_at_trigger ON agent_memory_provider_projection_receipts;
CREATE TRIGGER agent_memory_provider_projection_updated_at_trigger
BEFORE UPDATE ON agent_memory_provider_projection_receipts
FOR EACH ROW EXECUTE FUNCTION kasitek_touch_memory_provider_projection_updated_at();

ALTER TABLE agent_memory_provider_projection_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_provider_projection_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_memory_provider_projection_receipts_agents_scope ON agent_memory_provider_projection_receipts;
CREATE POLICY agent_memory_provider_projection_receipts_agents_scope
  ON agent_memory_provider_projection_receipts
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id));
