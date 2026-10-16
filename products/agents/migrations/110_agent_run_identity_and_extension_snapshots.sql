-- Pin the extension bundle used by a version and by every run admitted from it.
-- The bundle itself is resolved by a later runtime chunk; this migration only
-- makes the reference durable and prevents a run from silently changing pins.
ALTER TABLE agent_versions
  ADD COLUMN IF NOT EXISTS extension_snapshot_id UUID;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS extension_snapshot_id UUID;

COMMENT ON COLUMN agent_versions.extension_snapshot_id IS
  'Immutable reference to the resolved extension/plugin snapshot for this version.';

COMMENT ON COLUMN agent_runs.extension_snapshot_id IS
  'Immutable extension/plugin snapshot reference captured at run admission.';

CREATE OR REPLACE FUNCTION prevent_agent_run_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.agent_definition_id IS DISTINCT FROM OLD.agent_definition_id
     OR NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id
     OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.extension_snapshot_id IS DISTINCT FROM OLD.extension_snapshot_id THEN
    RAISE EXCEPTION 'Agent run identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_runs_identity_immutable ON agent_runs;
CREATE TRIGGER agent_runs_identity_immutable
BEFORE UPDATE ON agent_runs
FOR EACH ROW EXECUTE FUNCTION prevent_agent_run_identity_update();
