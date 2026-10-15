-- Canonical memory revision foundation.
--
-- This is intentionally a new append-only domain. It does not extend
-- memory_records: the legacy table is a compatibility surface until the
-- M2 backfill and cutover are complete. Facts provide stable identity while
-- revisions preserve every asserted value and its lineage.

CREATE TABLE IF NOT EXISTS agent_memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  end_user_id TEXT,
  namespace TEXT NOT NULL CHECK (namespace IN ('conversation', 'end_user_private', 'workspace_shared', 'agent_private')),
  memory_type TEXT NOT NULL CHECK (memory_type IN ('semantic', 'episodic')),
  subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) BETWEEN 1 AND 240),
  predicate_key TEXT NOT NULL CHECK (length(trim(predicate_key)) BETWEEN 1 AND 240),
  fact_key TEXT NOT NULL CHECK (length(trim(fact_key)) BETWEEN 1 AND 512),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_facts_identity_idx
  ON agent_memory_facts (
    organization_id,
    installation_id,
    namespace,
    memory_type,
    fact_key,
    COALESCE(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(end_user_id, '')
  );

CREATE INDEX IF NOT EXISTS agent_memory_facts_scope_idx
  ON agent_memory_facts (organization_id, agent_definition_id, installation_id, namespace, memory_type, created_at DESC);

CREATE OR REPLACE FUNCTION kasitek_validate_memory_fact_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  definition RECORD;
  installation RECORD;
  version_exists BOOLEAN;
  conversation_exists BOOLEAN;
BEGIN
  SELECT organization_id, owner_type, protected
  INTO definition
  FROM agent_definitions
  WHERE id = NEW.agent_definition_id;
  IF NOT FOUND OR (
    definition.organization_id <> NEW.organization_id
    AND NOT (definition.owner_type = 'system' AND definition.protected = TRUE)
  ) THEN
    RAISE EXCEPTION 'Memory fact agent is outside the tenant scope';
  END IF;

  SELECT agent_definition_id, organization_id
  INTO installation
  FROM agent_installations
  WHERE id = NEW.installation_id;
  IF NOT FOUND OR installation.organization_id <> NEW.organization_id OR installation.agent_definition_id <> NEW.agent_definition_id THEN
    RAISE EXCEPTION 'Memory fact installation is outside the agent scope';
  END IF;

  IF NEW.agent_version_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM agent_versions
      WHERE id = NEW.agent_version_id AND agent_definition_id = NEW.agent_definition_id
    ) INTO version_exists;
    IF NOT version_exists THEN
      RAISE EXCEPTION 'Memory fact version is outside the agent scope';
    END IF;
  END IF;

  IF NEW.conversation_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM conversations
      WHERE id = NEW.conversation_id
        AND organization_id = NEW.organization_id
        AND installation_id = NEW.installation_id
    ) INTO conversation_exists;
    IF NOT conversation_exists THEN
      RAISE EXCEPTION 'Memory fact conversation is outside the installation scope';
    END IF;
  END IF;

  IF NEW.namespace = 'conversation' AND NEW.conversation_id IS NULL THEN
    RAISE EXCEPTION 'Conversation memory requires conversation scope';
  END IF;
  IF NEW.namespace = 'end_user_private' AND NULLIF(trim(NEW.end_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'End-user memory requires end-user scope';
  END IF;
  IF NEW.namespace <> 'conversation' AND NEW.conversation_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only conversation memory may carry conversation scope';
  END IF;
  IF NEW.namespace <> 'end_user_private' AND NEW.end_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only end-user memory may carry end-user scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_facts_scope_trigger ON agent_memory_facts;
CREATE TRIGGER agent_memory_facts_scope_trigger
BEFORE INSERT OR UPDATE OF namespace, conversation_id, end_user_id
ON agent_memory_facts
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_fact_scope();

CREATE TABLE IF NOT EXISTS agent_memory_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  transition_type TEXT NOT NULL CHECK (transition_type IN ('assertion', 'correction', 'supersession', 'revalidation', 'expiration', 'deletion')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('observed', 'candidate', 'review_pending', 'quarantined', 'active', 'superseded', 'expired', 'rejected', 'deleted')),
  canonical_text TEXT NOT NULL CHECK (length(trim(canonical_text)) BETWEEN 1 AND 16000),
  typed_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_time TIMESTAMPTZ,
  event_summary TEXT,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome TEXT,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence NUMERIC(5, 4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_trust TEXT NOT NULL CHECK (source_trust IN ('user_explicit', 'platform_curated', 'model_inferred', 'imported', 'system_observed')),
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive', 'restricted')),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_digest TEXT NOT NULL CHECK (length(trim(evidence_digest)) BETWEEN 1 AND 256),
  extraction_version TEXT NOT NULL CHECK (length(trim(extraction_version)) BETWEEN 1 AND 120),
  predecessor_revision_id UUID REFERENCES agent_memory_revisions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 240),
  operation_fingerprint TEXT NOT NULL CHECK (length(trim(operation_fingerprint)) BETWEEN 1 AND 128),
  accepted_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at TIMESTAMPTZ,
  visible_at TIMESTAMPTZ,
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fact_id, revision_number),
  UNIQUE (fact_id, idempotency_key),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (
    (transition_type = 'assertion' AND predecessor_revision_id IS NULL)
    OR (transition_type <> 'assertion' AND predecessor_revision_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS agent_memory_revisions_current_idx
  ON agent_memory_revisions (organization_id, fact_id, lifecycle_state, valid_from DESC, revision_number DESC);
CREATE INDEX IF NOT EXISTS agent_memory_revisions_temporal_idx
  ON agent_memory_revisions (organization_id, valid_from DESC, valid_to DESC NULLS FIRST);
CREATE INDEX IF NOT EXISTS agent_memory_revisions_evidence_idx
  ON agent_memory_revisions (organization_id, evidence_digest);

CREATE OR REPLACE FUNCTION kasitek_validate_memory_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fact agent_memory_facts%ROWTYPE;
  predecessor agent_memory_revisions%ROWTYPE;
BEGIN
  SELECT * INTO fact FROM agent_memory_facts WHERE id = NEW.fact_id;
  IF NOT FOUND OR fact.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Memory revision fact is outside the tenant scope';
  END IF;

  IF NEW.transition_type = 'assertion' AND fact.memory_type = 'episodic' AND NEW.event_time IS NULL THEN
    RAISE EXCEPTION 'Episodic memory requires event time';
  END IF;
  IF fact.memory_type = 'episodic' AND NULLIF(trim(COALESCE(NEW.event_summary, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Episodic memory requires event summary';
  END IF;
  IF fact.memory_type = 'semantic' AND NEW.event_time IS NOT NULL THEN
    RAISE EXCEPTION 'Semantic memory cannot carry episodic event time';
  END IF;

  IF NEW.predecessor_revision_id IS NOT NULL THEN
    SELECT * INTO predecessor
    FROM agent_memory_revisions
    WHERE id = NEW.predecessor_revision_id;
    IF NOT FOUND
      OR predecessor.fact_id <> NEW.fact_id
      OR predecessor.organization_id <> NEW.organization_id
      OR predecessor.revision_number >= NEW.revision_number
    THEN
      RAISE EXCEPTION 'Memory revision predecessor is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_revisions_validation_trigger ON agent_memory_revisions;
CREATE TRIGGER agent_memory_revisions_validation_trigger
BEFORE INSERT ON agent_memory_revisions
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_revision();

-- Revisions are append-only domain facts. Corrections and supersessions are
-- new rows; no repository operation updates an existing revision.
CREATE OR REPLACE FUNCTION kasitek_reject_memory_revision_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Memory revisions are immutable; append a transition revision instead';
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_revisions_immutable_trigger ON agent_memory_revisions;
CREATE TRIGGER agent_memory_revisions_immutable_trigger
BEFORE UPDATE ON agent_memory_revisions
FOR EACH ROW EXECUTE FUNCTION kasitek_reject_memory_revision_update();

CREATE TABLE IF NOT EXISTS agent_memory_revision_sources (
  revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  source_event_id TEXT NOT NULL CHECK (length(trim(source_event_id)) BETWEEN 1 AND 240),
  source_event_type TEXT NOT NULL CHECK (length(trim(source_event_type)) BETWEEN 1 AND 120),
  source_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  source_occurred_at TIMESTAMPTZ,
  source_digest TEXT,
  redaction_class TEXT NOT NULL DEFAULT 'standard' CHECK (redaction_class IN ('standard', 'sensitive', 'restricted')),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (revision_id, source_event_type, source_event_id)
);

CREATE INDEX IF NOT EXISTS agent_memory_revision_sources_event_idx
  ON agent_memory_revision_sources (organization_id, source_event_type, source_event_id);
CREATE INDEX IF NOT EXISTS agent_memory_revision_sources_run_idx
  ON agent_memory_revision_sources (organization_id, source_run_id, source_occurred_at);

CREATE OR REPLACE FUNCTION kasitek_validate_memory_revision_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_organization TEXT;
  source_run_organization TEXT;
BEGIN
  SELECT organization_id INTO revision_organization
  FROM agent_memory_revisions
  WHERE id = NEW.revision_id;
  IF revision_organization IS NULL OR revision_organization <> NEW.organization_id THEN
    RAISE EXCEPTION 'Memory revision source is outside the tenant scope';
  END IF;
  IF NEW.source_run_id IS NOT NULL THEN
    SELECT organization_id INTO source_run_organization FROM agent_runs WHERE id = NEW.source_run_id;
    IF source_run_organization IS NULL OR source_run_organization <> NEW.organization_id THEN
      RAISE EXCEPTION 'Memory revision source run is outside the tenant scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_revision_sources_validation_trigger ON agent_memory_revision_sources;
CREATE TRIGGER agent_memory_revision_sources_validation_trigger
BEFORE INSERT ON agent_memory_revision_sources
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_revision_source();

CREATE TABLE IF NOT EXISTS agent_memory_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  from_revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  to_revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'contradicts', 'supersedes', 'derived_from', 'about')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_revision_id, to_revision_id, relation_type),
  CHECK (from_revision_id <> to_revision_id)
);

CREATE INDEX IF NOT EXISTS agent_memory_relations_from_idx
  ON agent_memory_relations (organization_id, from_revision_id, relation_type);
CREATE INDEX IF NOT EXISTS agent_memory_relations_to_idx
  ON agent_memory_relations (organization_id, to_revision_id, relation_type);

CREATE OR REPLACE FUNCTION kasitek_validate_memory_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  from_organization TEXT;
  to_organization TEXT;
BEGIN
  SELECT organization_id INTO from_organization FROM agent_memory_revisions WHERE id = NEW.from_revision_id;
  SELECT organization_id INTO to_organization FROM agent_memory_revisions WHERE id = NEW.to_revision_id;
  IF from_organization IS NULL OR to_organization IS NULL OR from_organization <> NEW.organization_id OR to_organization <> NEW.organization_id THEN
    RAISE EXCEPTION 'Memory relation is outside the tenant scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_relations_validation_trigger ON agent_memory_relations;
CREATE TRIGGER agent_memory_relations_validation_trigger
BEFORE INSERT ON agent_memory_relations
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_relation();

CREATE OR REPLACE FUNCTION kasitek_memory_revision_relation_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.predecessor_revision_id IS NOT NULL AND NEW.transition_type IN ('correction', 'supersession') THEN
    INSERT INTO agent_memory_relations (
      organization_id, from_revision_id, to_revision_id, relation_type, metadata, created_by
    ) VALUES (
      NEW.organization_id,
      NEW.id,
      NEW.predecessor_revision_id,
      'supersedes',
      jsonb_build_object('transitionType', NEW.transition_type),
      NEW.created_by
    ) ON CONFLICT (from_revision_id, to_revision_id, relation_type) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_revision_relation_trigger ON agent_memory_revisions;
CREATE TRIGGER agent_memory_revision_relation_trigger
AFTER INSERT ON agent_memory_revisions
FOR EACH ROW EXECUTE FUNCTION kasitek_memory_revision_relation_on_insert();

-- Tenant RLS follows the existing memory policy: operator scope is explicit,
-- and normal runtime access must match both organization and agent ownership.
DROP POLICY IF EXISTS agent_memory_facts_agents_scope ON agent_memory_facts;
CREATE POLICY agent_memory_facts_agents_scope ON agent_memory_facts
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_definitions definition
        WHERE definition.id = agent_memory_facts.agent_definition_id
          AND (
            definition.organization_id = agent_memory_facts.organization_id
            OR (definition.owner_type = 'system' AND definition.protected = TRUE)
          )
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_definitions definition
        WHERE definition.id = agent_memory_facts.agent_definition_id
          AND (
            definition.organization_id = agent_memory_facts.organization_id
            OR (definition.owner_type = 'system' AND definition.protected = TRUE)
          )
      )
    )
  );
ALTER TABLE agent_memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_facts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_memory_revisions_agents_scope ON agent_memory_revisions;
CREATE POLICY agent_memory_revisions_agents_scope ON agent_memory_revisions
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_facts fact WHERE fact.id = agent_memory_revisions.fact_id AND fact.organization_id = agent_memory_revisions.organization_id)
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_facts fact WHERE fact.id = agent_memory_revisions.fact_id AND fact.organization_id = agent_memory_revisions.organization_id)
    )
  );
ALTER TABLE agent_memory_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_memory_revision_sources_agents_scope ON agent_memory_revision_sources;
CREATE POLICY agent_memory_revision_sources_agents_scope ON agent_memory_revision_sources
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_revisions revision WHERE revision.id = agent_memory_revision_sources.revision_id AND revision.organization_id = agent_memory_revision_sources.organization_id)
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_revisions revision WHERE revision.id = agent_memory_revision_sources.revision_id AND revision.organization_id = agent_memory_revision_sources.organization_id)
    )
  );
ALTER TABLE agent_memory_revision_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_revision_sources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_memory_relations_agents_scope ON agent_memory_relations;
CREATE POLICY agent_memory_relations_agents_scope ON agent_memory_relations
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_revisions revision WHERE revision.id = agent_memory_relations.from_revision_id AND revision.organization_id = agent_memory_relations.organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_revisions revision WHERE revision.id = agent_memory_relations.to_revision_id AND revision.organization_id = agent_memory_relations.organization_id)
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_revisions revision WHERE revision.id = agent_memory_relations.from_revision_id AND revision.organization_id = agent_memory_relations.organization_id)
      AND EXISTS (SELECT 1 FROM agent_memory_revisions revision WHERE revision.id = agent_memory_relations.to_revision_id AND revision.organization_id = agent_memory_relations.organization_id)
    )
  );
ALTER TABLE agent_memory_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_relations FORCE ROW LEVEL SECURITY;
