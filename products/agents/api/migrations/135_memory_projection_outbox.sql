-- Rebuildable memory projections and their durable work queue.
--
-- Canonical facts/revisions remain the source of truth.  These tables are
-- intentionally disposable: a projection can be dropped and rebuilt from
-- agent_memory_revisions without changing memory semantics.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_memory_projection_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('fts', 'vector', 'temporal', 'provider')),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'revalidate')),
  projection_version TEXT NOT NULL DEFAULT 'v1' CHECK (length(trim(projection_version)) BETWEEN 1 AND 80),
  provider_name TEXT NOT NULL DEFAULT 'internal' CHECK (length(trim(provider_name)) BETWEEN 1 AND 160),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 512),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 240),
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,119}$'),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  UNIQUE (revision_id, projection_kind, operation, projection_version, provider_name),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR status IN ('completed', 'dead_letter'))
);

CREATE INDEX IF NOT EXISTS agent_memory_projection_outbox_due_idx
  ON agent_memory_projection_outbox (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS agent_memory_projection_outbox_scope_idx
  ON agent_memory_projection_outbox (organization_id, workspace_id, installation_id, projection_kind, status, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_projection_outbox_revision_idx
  ON agent_memory_projection_outbox (organization_id, revision_id, projection_kind, provider_name);

CREATE TABLE IF NOT EXISTS agent_memory_projection_readiness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('fts', 'vector', 'temporal', 'provider')),
  provider_name TEXT NOT NULL DEFAULT 'internal' CHECK (length(trim(provider_name)) BETWEEN 1 AND 160),
  readiness_state TEXT NOT NULL DEFAULT 'accepted' CHECK (readiness_state IN ('accepted', 'indexing', 'indexed', 'visible', 'failed', 'blocked', 'deleted')),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at TIMESTAMPTZ,
  visible_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,119}$'),
  last_error_at TIMESTAMPTZ,
  source_outbox_id UUID REFERENCES agent_memory_projection_outbox(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (revision_id, projection_kind, provider_name),
  CHECK (indexed_at IS NULL OR indexed_at >= accepted_at),
  CHECK (visible_at IS NULL OR indexed_at IS NOT NULL),
  CHECK (deleted_at IS NULL OR readiness_state = 'deleted')
);

CREATE INDEX IF NOT EXISTS agent_memory_projection_readiness_scope_idx
  ON agent_memory_projection_readiness (organization_id, workspace_id, installation_id, readiness_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_projection_readiness_revision_idx
  ON agent_memory_projection_readiness (organization_id, revision_id, projection_kind, provider_name);

-- FTS, temporal, and vector rows are projections only.  Keep all ownership
-- columns on each row so a projection query never has to infer tenant scope
-- from an untrusted join.
CREATE TABLE IF NOT EXISTS agent_memory_fts_projections (
  revision_id UUID PRIMARY KEY REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  lifecycle_state TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive', 'restricted')),
  canonical_text TEXT NOT NULL CHECK (length(trim(canonical_text)) BETWEEN 1 AND 16000),
  search_vector TSVECTOR NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(trim(content_digest)) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_fts_projections_search_idx
  ON agent_memory_fts_projections USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS agent_memory_fts_projections_scope_idx
  ON agent_memory_fts_projections (organization_id, workspace_id, installation_id, lifecycle_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_memory_temporal_projections (
  revision_id UUID PRIMARY KEY REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('semantic', 'episodic')),
  lifecycle_state TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  event_time TIMESTAMPTZ,
  event_summary TEXT,
  source_event_ids TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS agent_memory_temporal_projections_scope_idx
  ON agent_memory_temporal_projections (organization_id, workspace_id, installation_id, valid_from DESC, valid_to DESC NULLS FIRST);
CREATE INDEX IF NOT EXISTS agent_memory_temporal_projections_event_idx
  ON agent_memory_temporal_projections (organization_id, event_time DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS agent_memory_vector_projections (
  revision_id UUID PRIMARY KEY REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL CHECK (length(trim(embedding_model)) BETWEEN 1 AND 160),
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions = 1536),
  embedding_vector vector(1536) NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(trim(content_digest)) BETWEEN 1 AND 256),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_vector_projections_hnsw_idx
  ON agent_memory_vector_projections USING hnsw (embedding_vector vector_cosine_ops);
CREATE INDEX IF NOT EXISTS agent_memory_vector_projections_scope_idx
  ON agent_memory_vector_projections (organization_id, workspace_id, installation_id, updated_at DESC);

CREATE OR REPLACE FUNCTION kasitek_validate_memory_projection_scope() RETURNS trigger
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
    RAISE EXCEPTION 'Memory projection is outside the canonical revision scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kasitek_touch_memory_projection_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kasitek_validate_memory_projection_readiness_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.readiness_state IS DISTINCT FROM OLD.readiness_state THEN
    IF NOT (
      (OLD.readiness_state = 'accepted' AND NEW.readiness_state IN ('indexing', 'failed', 'blocked', 'deleted')) OR
      (OLD.readiness_state = 'indexing' AND NEW.readiness_state IN ('accepted', 'indexed', 'visible', 'failed', 'blocked', 'deleted')) OR
      (OLD.readiness_state = 'indexed' AND NEW.readiness_state IN ('visible', 'failed', 'deleted')) OR
      (OLD.readiness_state = 'visible' AND NEW.readiness_state = 'deleted') OR
      (OLD.readiness_state = 'failed' AND NEW.readiness_state IN ('indexing', 'blocked', 'deleted')) OR
      (OLD.readiness_state = 'blocked' AND NEW.readiness_state IN ('indexing', 'deleted'))
    ) THEN
      RAISE EXCEPTION 'Invalid memory projection readiness transition: % -> %', OLD.readiness_state, NEW.readiness_state;
    END IF;
  END IF;
  IF NEW.readiness_state IN ('indexed', 'visible') AND NEW.indexed_at IS NULL THEN
    RAISE EXCEPTION 'Indexed memory projection readiness requires indexed_at';
  END IF;
  IF NEW.readiness_state = 'visible' AND NEW.visible_at IS NULL THEN
    RAISE EXCEPTION 'Visible memory projection readiness requires visible_at';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kasitek_validate_memory_projection_outbox_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.agent_definition_id IS DISTINCT FROM OLD.agent_definition_id OR
    NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id OR
    NEW.installation_id IS DISTINCT FROM OLD.installation_id OR
    NEW.fact_id IS DISTINCT FROM OLD.fact_id OR
    NEW.revision_id IS DISTINCT FROM OLD.revision_id OR
    NEW.projection_kind IS DISTINCT FROM OLD.projection_kind OR
    NEW.operation IS DISTINCT FROM OLD.operation OR
    NEW.projection_version IS DISTINCT FROM OLD.projection_version OR
    NEW.provider_name IS DISTINCT FROM OLD.provider_name OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.payload IS DISTINCT FROM OLD.payload OR
    NEW.payload_digest IS DISTINCT FROM OLD.payload_digest OR
    NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
  ) THEN
    RAISE EXCEPTION 'Memory projection outbox content is immutable';
  END IF;
  IF NEW.status <> 'running' AND (NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Only running memory projection work may hold a lease';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_projection_outbox_scope_trigger ON agent_memory_projection_outbox;
CREATE TRIGGER agent_memory_projection_outbox_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, fact_id, revision_id
ON agent_memory_projection_outbox
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_projection_scope();

DROP TRIGGER IF EXISTS agent_memory_projection_outbox_update_trigger ON agent_memory_projection_outbox;
CREATE TRIGGER agent_memory_projection_outbox_update_trigger
BEFORE UPDATE ON agent_memory_projection_outbox
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_projection_outbox_update();

DROP TRIGGER IF EXISTS agent_memory_projection_readiness_scope_trigger ON agent_memory_projection_readiness;
CREATE TRIGGER agent_memory_projection_readiness_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, fact_id, revision_id
ON agent_memory_projection_readiness
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_projection_scope();

DROP TRIGGER IF EXISTS agent_memory_projection_readiness_transition_trigger ON agent_memory_projection_readiness;
CREATE TRIGGER agent_memory_projection_readiness_transition_trigger
BEFORE INSERT OR UPDATE ON agent_memory_projection_readiness
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_projection_readiness_transition();

DROP TRIGGER IF EXISTS agent_memory_projection_readiness_updated_at_trigger ON agent_memory_projection_readiness;
CREATE TRIGGER agent_memory_projection_readiness_updated_at_trigger
BEFORE UPDATE ON agent_memory_projection_readiness
FOR EACH ROW EXECUTE FUNCTION kasitek_touch_memory_projection_updated_at();

DROP TRIGGER IF EXISTS agent_memory_fts_projection_scope_trigger ON agent_memory_fts_projections;
CREATE TRIGGER agent_memory_fts_projection_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, fact_id, revision_id
ON agent_memory_fts_projections
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_projection_scope();

DROP TRIGGER IF EXISTS agent_memory_fts_projection_updated_at_trigger ON agent_memory_fts_projections;
CREATE TRIGGER agent_memory_fts_projection_updated_at_trigger
BEFORE UPDATE ON agent_memory_fts_projections
FOR EACH ROW EXECUTE FUNCTION kasitek_touch_memory_projection_updated_at();

DROP TRIGGER IF EXISTS agent_memory_temporal_projection_scope_trigger ON agent_memory_temporal_projections;
CREATE TRIGGER agent_memory_temporal_projection_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, fact_id, revision_id
ON agent_memory_temporal_projections
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_projection_scope();

DROP TRIGGER IF EXISTS agent_memory_temporal_projection_updated_at_trigger ON agent_memory_temporal_projections;
CREATE TRIGGER agent_memory_temporal_projection_updated_at_trigger
BEFORE UPDATE ON agent_memory_temporal_projections
FOR EACH ROW EXECUTE FUNCTION kasitek_touch_memory_projection_updated_at();

DROP TRIGGER IF EXISTS agent_memory_vector_projection_scope_trigger ON agent_memory_vector_projections;
CREATE TRIGGER agent_memory_vector_projection_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, fact_id, revision_id
ON agent_memory_vector_projections
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_projection_scope();

DROP TRIGGER IF EXISTS agent_memory_vector_projection_updated_at_trigger ON agent_memory_vector_projections;
CREATE TRIGGER agent_memory_vector_projection_updated_at_trigger
BEFORE UPDATE ON agent_memory_vector_projections
FOR EACH ROW EXECUTE FUNCTION kasitek_touch_memory_projection_updated_at();

-- Every canonical revision produces local projection work in the same
-- transaction.  A worker may fail or lag; the revision itself is never lost.
CREATE OR REPLACE FUNCTION kasitek_enqueue_memory_projection_work() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fact RECORD;
  kind TEXT;
  outbox_id UUID;
  key TEXT;
BEGIN
  SELECT * INTO fact FROM agent_memory_facts WHERE id = NEW.fact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory projection revision fact is missing';
  END IF;

  FOREACH kind IN ARRAY ARRAY['fts', 'vector', 'temporal'] LOOP
    key := format('memory-projection:%s:%s:%s:%s', NEW.id, kind, 'upsert', 'v1');
    INSERT INTO agent_memory_projection_outbox (
      organization_id, workspace_id, agent_definition_id, agent_version_id,
      installation_id, fact_id, revision_id, projection_kind, operation,
      projection_version, provider_name, idempotency_key, payload, payload_digest
    ) VALUES (
      fact.organization_id, fact.workspace_id, fact.agent_definition_id, fact.agent_version_id,
      fact.installation_id, fact.id, NEW.id, kind, 'upsert', 'v1', 'internal', key,
      '{}'::jsonb, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO outbox_id;

    IF outbox_id IS NOT NULL THEN
      INSERT INTO agent_memory_projection_readiness (
        organization_id, workspace_id, agent_definition_id, agent_version_id,
        installation_id, fact_id, revision_id, projection_kind, provider_name,
        readiness_state, source_outbox_id
      ) VALUES (
        fact.organization_id, fact.workspace_id, fact.agent_definition_id, fact.agent_version_id,
        fact.installation_id, fact.id, NEW.id, kind, 'internal', 'accepted', outbox_id
      ) ON CONFLICT (revision_id, projection_kind, provider_name) DO NOTHING;
    END IF;
    outbox_id := NULL;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_revision_projection_enqueue_trigger ON agent_memory_revisions;
CREATE TRIGGER agent_memory_revision_projection_enqueue_trigger
AFTER INSERT ON agent_memory_revisions
FOR EACH ROW EXECUTE FUNCTION kasitek_enqueue_memory_projection_work();

-- Tenant isolation is repeated on every projection and queue table.  The
-- canonical tables remain the authorization anchor, while the explicit
-- workspace/install columns make accidental broad reads impossible.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'agent_memory_projection_outbox',
    'agent_memory_projection_readiness',
    'agent_memory_fts_projections',
    'agent_memory_temporal_projections',
    'agent_memory_vector_projections'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_agents_scope', table_name);
    EXECUTE format($policy$
      CREATE POLICY %I ON %I
      FOR ALL TO kasitek_agents_runtime
      USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
      WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
    $policy$, table_name || '_agents_scope', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;
