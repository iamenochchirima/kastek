-- Installation credentials are machine credentials for external runtimes only.
-- Keep this invariant in the database as well as in repository and HTTP guards so
-- an out-of-band writer cannot attach a credential to KasiAi or a hosted agent.
CREATE OR REPLACE FUNCTION enforce_external_installation_credential_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  installation_mode TEXT;
BEGIN
  SELECT execution_mode
    INTO installation_mode
    FROM agent_installations
   WHERE id = NEW.installation_id
     AND organization_id = NEW.organization_id;

  IF installation_mode IS DISTINCT FROM 'external_connected' THEN
    RAISE EXCEPTION 'Installation credentials require an external_connected installation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS external_installation_credential_mode_guard
  ON agent_installation_credentials;

CREATE TRIGGER external_installation_credential_mode_guard
BEFORE INSERT OR UPDATE OF installation_id, organization_id
ON agent_installation_credentials
FOR EACH ROW
EXECUTE FUNCTION enforce_external_installation_credential_mode();

COMMENT ON FUNCTION enforce_external_installation_credential_mode() IS
  'Prevents installation credentials from being attached to system_hosted or kasitek_hosted installations.';
