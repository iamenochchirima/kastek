-- Tenant and workspace boundary enforcement for memory quality tables.

CREATE OR REPLACE FUNCTION kasitek_validate_memory_retention_rule_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fact_scope RECORD;
BEGIN
  IF NEW.scope_type = 'organization' AND NEW.scope_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Memory retention organization rule scope is invalid';
  END IF;
  IF NEW.scope_type = 'record' THEN
    SELECT organization_id, workspace_id INTO fact_scope
    FROM agent_memory_facts WHERE id = NEW.fact_id;
    IF NOT FOUND OR fact_scope.organization_id <> NEW.organization_id OR NEW.scope_id <> NEW.fact_id::text THEN
      RAISE EXCEPTION 'Memory retention record rule is outside the tenant scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_retention_rules_scope_trigger ON agent_memory_retention_rules;
CREATE TRIGGER agent_memory_retention_rules_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, scope_type, scope_id, fact_id
ON agent_memory_retention_rules
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_retention_rule_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_memory_quality_event_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  installation_valid BOOLEAN;
  fact_valid BOOLEAN;
  revision_valid BOOLEAN;
  run_valid BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM agent_installations
    WHERE id = NEW.installation_id
      AND organization_id = NEW.organization_id
      AND scope_id = NEW.workspace_id
      AND agent_definition_id = NEW.agent_definition_id
  ) INTO installation_valid;
  IF NOT installation_valid THEN
    RAISE EXCEPTION 'Memory quality event installation is outside the workspace scope';
  END IF;
  IF NEW.fact_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM agent_memory_facts
      WHERE id = NEW.fact_id
        AND organization_id = NEW.organization_id
        AND workspace_id = NEW.workspace_id
        AND agent_definition_id = NEW.agent_definition_id
        AND installation_id = NEW.installation_id
        AND conversation_id IS NOT DISTINCT FROM NEW.conversation_id
        AND end_user_id IS NOT DISTINCT FROM NEW.end_user_id
    ) INTO fact_valid;
    IF NOT fact_valid THEN
      RAISE EXCEPTION 'Memory quality event fact is outside the event scope';
    END IF;
  END IF;
  IF NEW.revision_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM agent_memory_revisions revision
      JOIN agent_memory_facts fact ON fact.id = revision.fact_id
      WHERE revision.id = NEW.revision_id
        AND (NEW.fact_id IS NULL OR revision.fact_id = NEW.fact_id)
        AND fact.organization_id = NEW.organization_id
        AND fact.workspace_id = NEW.workspace_id
        AND fact.agent_definition_id = NEW.agent_definition_id
        AND fact.installation_id = NEW.installation_id
        AND fact.conversation_id IS NOT DISTINCT FROM NEW.conversation_id
        AND fact.end_user_id IS NOT DISTINCT FROM NEW.end_user_id
    ) INTO revision_valid;
    IF NOT revision_valid THEN
      RAISE EXCEPTION 'Memory quality event revision is outside the event scope';
    END IF;
  END IF;
  IF NEW.source_run_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM agent_runs
      WHERE id = NEW.source_run_id
        AND organization_id = NEW.organization_id
        AND installation_id = NEW.installation_id
        AND agent_definition_id = NEW.agent_definition_id
        AND conversation_id IS NOT DISTINCT FROM NEW.conversation_id
    ) INTO run_valid;
    IF NOT run_valid THEN
      RAISE EXCEPTION 'Memory quality event run is outside the event scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_quality_events_scope_trigger ON agent_memory_quality_events;
CREATE TRIGGER agent_memory_quality_events_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  installation_id, conversation_id, end_user_id, fact_id, revision_id
ON agent_memory_quality_events
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_quality_event_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_memory_revalidation_job_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  installation_valid BOOLEAN;
  fact_valid BOOLEAN;
  revision_valid BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM agent_installations
    WHERE id = NEW.installation_id
      AND organization_id = NEW.organization_id
      AND scope_id = NEW.workspace_id
      AND agent_definition_id = NEW.agent_definition_id
  ) INTO installation_valid;
  SELECT EXISTS (
    SELECT 1 FROM agent_memory_facts
    WHERE id = NEW.fact_id
      AND organization_id = NEW.organization_id
      AND workspace_id = NEW.workspace_id
      AND agent_definition_id = NEW.agent_definition_id
      AND installation_id = NEW.installation_id
  ) INTO fact_valid;
  SELECT EXISTS (
    SELECT 1 FROM agent_memory_revisions
    WHERE id = NEW.revision_id AND fact_id = NEW.fact_id
  ) INTO revision_valid;
  IF NOT installation_valid OR NOT fact_valid OR NOT revision_valid THEN
    RAISE EXCEPTION 'Memory revalidation job is outside the tenant scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_revalidation_jobs_scope_trigger ON agent_memory_revalidation_jobs;
CREATE TRIGGER agent_memory_revalidation_jobs_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  installation_id, fact_id, revision_id
ON agent_memory_revalidation_jobs
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_revalidation_job_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_memory_conflict_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  left_valid BOOLEAN;
  right_valid BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM agent_memory_revisions revision
    JOIN agent_memory_facts fact ON fact.id = revision.fact_id
    WHERE revision.id = NEW.left_revision_id
      AND fact.organization_id = NEW.organization_id
      AND fact.workspace_id = NEW.workspace_id
      AND fact.agent_definition_id = NEW.agent_definition_id
      AND fact.installation_id = NEW.installation_id
  ) INTO left_valid;
  SELECT EXISTS (
    SELECT 1 FROM agent_memory_revisions revision
    JOIN agent_memory_facts fact ON fact.id = revision.fact_id
    WHERE revision.id = NEW.right_revision_id
      AND fact.organization_id = NEW.organization_id
      AND fact.workspace_id = NEW.workspace_id
      AND fact.agent_definition_id = NEW.agent_definition_id
      AND fact.installation_id = NEW.installation_id
  ) INTO right_valid;
  IF NOT left_valid OR NOT right_valid THEN
    RAISE EXCEPTION 'Memory conflict is outside the tenant scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_conflicts_scope_trigger ON agent_memory_conflicts;
CREATE TRIGGER agent_memory_conflicts_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  installation_id, left_revision_id, right_revision_id
ON agent_memory_conflicts
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_conflict_scope();

-- Quality events are evidence, not mutable counters. The only permitted
-- removal is the explicit operator-scoped erasure path, which is required for
-- tenant deletion and legal-forgetting requests; ordinary runtime roles must
-- append a new event instead.
CREATE OR REPLACE FUNCTION kasitek_prevent_memory_quality_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF kasitek_agents_operator_scope() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Memory quality events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_quality_events_immutable_trigger ON agent_memory_quality_events;
CREATE TRIGGER agent_memory_quality_events_immutable_trigger
BEFORE UPDATE OR DELETE ON agent_memory_quality_events
FOR EACH ROW EXECUTE FUNCTION kasitek_prevent_memory_quality_event_mutation();

-- Every maintenance job is scoped to a workspace. A workspace is anchored to
-- an installation when the job claims facts; the worker repeats this check in
-- SQL predicates before touching any revision.
CREATE INDEX IF NOT EXISTS agent_memory_maintenance_jobs_due_idx
  ON agent_memory_maintenance_jobs (status, next_run_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS agent_memory_maintenance_jobs_scope_idx
  ON agent_memory_maintenance_jobs (organization_id, workspace_id, job_type);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'agent_memory_retention_rules',
    'agent_memory_quality_events',
    'agent_memory_revalidation_jobs',
    'agent_memory_conflicts',
    'agent_memory_maintenance_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_agents_scope', table_name);
    EXECUTE format($policy$
      CREATE POLICY %1$I ON %2$I
      FOR ALL TO kasitek_agents_runtime
      USING (kasitek_agents_operator_scope() OR organization_id = current_setting('kasitek.organization_id', true))
      WITH CHECK (kasitek_agents_operator_scope() OR organization_id = current_setting('kasitek.organization_id', true))
    $policy$, table_name || '_agents_scope', table_name);
  END LOOP;
END $$;
