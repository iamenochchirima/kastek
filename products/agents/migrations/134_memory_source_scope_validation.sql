-- Enforce the source/checkpoint scope at the database boundary as well as in
-- the application adapter. These rows are the durable evidence boundary, so
-- a mismatched workspace, installation, run, or conversation must be rejected
-- before it can become extraction input.

UPDATE memory_source_events source
SET agent_version_id = installation.agent_version_id
FROM agent_installations installation
WHERE installation.id = source.installation_id
  AND source.agent_version_id IS NULL;

UPDATE memory_checkpoints checkpoint
SET agent_version_id = run.agent_version_id
FROM agent_runs run
WHERE run.id = checkpoint.run_id
  AND checkpoint.agent_version_id IS NULL;

ALTER TABLE memory_source_events
  ALTER COLUMN agent_version_id SET NOT NULL;

ALTER TABLE memory_checkpoints
  ALTER COLUMN agent_version_id SET NOT NULL;

CREATE OR REPLACE FUNCTION kasitek_validate_memory_source_event_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  installation RECORD;
  version_exists BOOLEAN;
  conversation_exists BOOLEAN;
  run_scope RECORD;
BEGIN
  SELECT organization_id, agent_definition_id, agent_version_id, scope_id
  INTO installation
  FROM agent_installations
  WHERE id = NEW.installation_id;
  IF NOT FOUND
    OR installation.organization_id <> NEW.organization_id
    OR installation.agent_definition_id <> NEW.agent_definition_id
    OR installation.scope_id <> NEW.workspace_id
  THEN
    RAISE EXCEPTION 'Memory source event installation is outside the workspace scope';
  END IF;

  IF NEW.agent_version_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM agent_versions
      WHERE id = NEW.agent_version_id
        AND agent_definition_id = NEW.agent_definition_id
    ) INTO version_exists;
    IF NOT version_exists THEN
      RAISE EXCEPTION 'Memory source event version is outside the agent scope';
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
      RAISE EXCEPTION 'Memory source event conversation is outside the installation scope';
    END IF;
  END IF;

  IF NEW.run_id IS NOT NULL THEN
    SELECT organization_id, installation_id, agent_definition_id, agent_version_id, conversation_id
    INTO run_scope
    FROM agent_runs
    WHERE id = NEW.run_id;
    IF NOT FOUND
      OR run_scope.organization_id <> NEW.organization_id
      OR run_scope.installation_id <> NEW.installation_id
      OR run_scope.agent_definition_id <> NEW.agent_definition_id
      OR run_scope.agent_version_id IS DISTINCT FROM NEW.agent_version_id
      OR run_scope.conversation_id IS DISTINCT FROM NEW.conversation_id
    THEN
      RAISE EXCEPTION 'Memory source event run is outside the event scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_source_events_scope_trigger ON memory_source_events;
CREATE TRIGGER memory_source_events_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, conversation_id, run_id
ON memory_source_events
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_source_event_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_memory_checkpoint_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_scope RECORD;
  run_scope RECORD;
BEGIN
  SELECT organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, conversation_id
  INTO source_scope
  FROM memory_source_events
  WHERE id = NEW.source_event_id;
  IF NOT FOUND
    OR source_scope.organization_id <> NEW.organization_id
    OR source_scope.workspace_id <> NEW.workspace_id
    OR source_scope.agent_definition_id <> NEW.agent_definition_id
    OR source_scope.agent_version_id IS DISTINCT FROM NEW.agent_version_id
    OR source_scope.installation_id <> NEW.installation_id
    OR source_scope.conversation_id IS DISTINCT FROM NEW.conversation_id
  THEN
    RAISE EXCEPTION 'Memory checkpoint source event is outside the checkpoint scope';
  END IF;

  SELECT organization_id, installation_id, agent_definition_id, agent_version_id, conversation_id
  INTO run_scope
  FROM agent_runs
  WHERE id = NEW.run_id;
  IF NOT FOUND
    OR run_scope.organization_id <> NEW.organization_id
    OR run_scope.installation_id <> NEW.installation_id
    OR run_scope.agent_definition_id <> NEW.agent_definition_id
    OR run_scope.agent_version_id IS DISTINCT FROM NEW.agent_version_id
    OR run_scope.conversation_id IS DISTINCT FROM NEW.conversation_id
  THEN
    RAISE EXCEPTION 'Memory checkpoint run is outside the checkpoint scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_checkpoints_scope_trigger ON memory_checkpoints;
CREATE TRIGGER memory_checkpoints_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id,
  agent_version_id, installation_id, conversation_id, run_id, source_event_id
ON memory_checkpoints
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_checkpoint_scope();

CREATE INDEX IF NOT EXISTS memory_source_events_workspace_idx
  ON memory_source_events (organization_id, workspace_id, installation_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS memory_checkpoints_workspace_idx
  ON memory_checkpoints (organization_id, workspace_id, installation_id, status, updated_at DESC);
