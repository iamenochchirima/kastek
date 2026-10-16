-- Relations are canonical lineage, not a mutable cache row.  Keep both ends
-- inside the same workspace/agent/installation/version and never permit a
-- relation update to smuggle data across a scope boundary.

CREATE OR REPLACE FUNCTION kasitek_validate_memory_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  from_fact RECORD;
  to_fact RECORD;
BEGIN
  SELECT fact.organization_id, fact.workspace_id, fact.agent_definition_id,
         fact.installation_id, fact.agent_version_id, fact.end_user_id
  INTO from_fact
  FROM agent_memory_revisions revision
  JOIN agent_memory_facts fact ON fact.id = revision.fact_id
  WHERE revision.id = NEW.from_revision_id;

  SELECT fact.organization_id, fact.workspace_id, fact.agent_definition_id,
         fact.installation_id, fact.agent_version_id, fact.end_user_id
  INTO to_fact
  FROM agent_memory_revisions revision
  JOIN agent_memory_facts fact ON fact.id = revision.fact_id
  WHERE revision.id = NEW.to_revision_id;

  IF NOT FOUND
    OR from_fact.organization_id IS DISTINCT FROM NEW.organization_id
    OR to_fact.organization_id IS DISTINCT FROM NEW.organization_id
    OR from_fact.workspace_id IS DISTINCT FROM to_fact.workspace_id
    OR from_fact.agent_definition_id IS DISTINCT FROM to_fact.agent_definition_id
    OR from_fact.installation_id IS DISTINCT FROM to_fact.installation_id
    OR from_fact.agent_version_id IS DISTINCT FROM to_fact.agent_version_id
    OR from_fact.end_user_id IS DISTINCT FROM to_fact.end_user_id
  THEN
    RAISE EXCEPTION 'Memory relation is outside the canonical scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_relations_validation_trigger ON agent_memory_relations;
CREATE TRIGGER agent_memory_relations_validation_trigger
BEFORE INSERT OR UPDATE ON agent_memory_relations
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_relation();

CREATE OR REPLACE FUNCTION kasitek_reject_memory_relation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Memory relations are immutable; append a new relation instead';
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_relations_immutable_trigger ON agent_memory_relations;
CREATE TRIGGER agent_memory_relations_immutable_trigger
BEFORE UPDATE ON agent_memory_relations
FOR EACH ROW EXECUTE FUNCTION kasitek_reject_memory_relation_update();

COMMENT ON FUNCTION kasitek_validate_memory_relation() IS
  'Requires both relation endpoints to share organization, workspace, agent, installation, version, and end-user scope.';
COMMENT ON FUNCTION kasitek_reject_memory_relation_update() IS
  'Relations are append-only lineage; duplicate inserts are idempotent and metadata is not mutable.';
