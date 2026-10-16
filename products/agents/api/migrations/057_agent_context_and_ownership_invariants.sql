-- Keep agent context records owned by one agent definition. Existing legacy
-- rows are left for an explicit migration/review, while NOT VALID constraints
-- enforce the boundary for all new writes immediately.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_records_agent_scope_required'
  ) THEN
    ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_agent_scope_required
      CHECK (agent_definition_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_sources_agent_scope_required'
  ) THEN
    ALTER TABLE knowledge_sources
      ADD CONSTRAINT knowledge_sources_agent_scope_required
      CHECK (agent_definition_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_chunks_agent_scope_required'
  ) THEN
    ALTER TABLE knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_agent_scope_required
      CHECK (agent_definition_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kasitek_validate_agent_context_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_definition_id IS NULL THEN
    RAISE EXCEPTION 'Agent context records require an agent definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM agent_definitions
    WHERE id = NEW.agent_definition_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Agent context organization does not match its definition';
  END IF;

  IF NEW.installation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_installations
    WHERE id = NEW.installation_id
      AND organization_id = NEW.organization_id
      AND agent_definition_id = NEW.agent_definition_id
  ) THEN
    RAISE EXCEPTION 'Agent context installation does not belong to its definition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_records_agent_context_scope_trigger ON memory_records;
CREATE TRIGGER memory_records_agent_context_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, agent_definition_id, installation_id ON memory_records
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_agent_context_scope();

DROP TRIGGER IF EXISTS knowledge_sources_agent_context_scope_trigger ON knowledge_sources;
CREATE TRIGGER knowledge_sources_agent_context_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, agent_definition_id, installation_id ON knowledge_sources
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_agent_context_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_knowledge_chunk_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM knowledge_sources
    WHERE id = NEW.source_id
      AND organization_id = NEW.organization_id
      AND agent_definition_id = NEW.agent_definition_id
      AND installation_id IS NOT DISTINCT FROM NEW.installation_id
  ) THEN
    RAISE EXCEPTION 'Knowledge chunk scope does not match its source';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_chunks_agent_context_scope_trigger ON knowledge_chunks;
CREATE TRIGGER knowledge_chunks_agent_context_scope_trigger
BEFORE INSERT OR UPDATE OF source_id, organization_id, agent_definition_id, installation_id ON knowledge_chunks
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_knowledge_chunk_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_agent_installation_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agent_versions av
    JOIN agent_definitions ad ON ad.id = av.agent_definition_id
    WHERE av.id = NEW.agent_version_id
      AND av.agent_definition_id = NEW.agent_definition_id
      AND ad.id = NEW.agent_definition_id
      AND ad.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Installation definition, version, and organization do not match';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_installations_ownership_trigger ON agent_installations;
CREATE TRIGGER agent_installations_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, agent_definition_id, agent_version_id ON agent_installations
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_agent_installation_ownership();

CREATE OR REPLACE FUNCTION kasitek_validate_agent_run_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agent_installations ai
    JOIN agent_versions av ON av.id = ai.agent_version_id
    JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
    WHERE ai.id = NEW.installation_id
      AND ai.organization_id = NEW.organization_id
      AND ai.agent_definition_id = NEW.agent_definition_id
      AND ai.agent_version_id = NEW.agent_version_id
      AND av.agent_definition_id = NEW.agent_definition_id
      AND ad.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Run definition, version, installation, and organization do not match';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_runs_ownership_trigger ON agent_runs;
CREATE TRIGGER agent_runs_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, agent_definition_id, agent_version_id, installation_id ON agent_runs
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_agent_run_ownership();
