-- Runs created for a protected system agent use the workspace installation's
-- organization, while the definition itself remains owned by KasiTek.
-- Keep the run invariant aligned with the system-installation invariant.
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
      AND (
        ad.organization_id = NEW.organization_id
        OR (ad.owner_type = 'system' AND ad.protected = TRUE)
      )
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
