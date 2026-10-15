-- System agents are owned by KasiTek but may be installed into a workspace.
-- Organization-owned agents must still keep the definition and installation
-- in the same organization. The original invariant only allowed the latter,
-- which made every development restart fail while rolling out KasiAi.
CREATE OR REPLACE FUNCTION kasitek_validate_agent_installation_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agent_versions av
    JOIN agent_definitions ad ON ad.id = av.agent_definition_id
    WHERE av.id = NEW.agent_version_id
      AND av.agent_definition_id = NEW.agent_definition_id
      AND (
        ad.organization_id = NEW.organization_id
        OR (ad.owner_type = 'system' AND ad.protected = TRUE)
      )
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
