-- Keep each definition on one runtime mode. A definition is the identity that
-- owns versions and installations; mixing hosted and external execution under
-- that identity makes credentials, channels, and audit attribution ambiguous.
CREATE OR REPLACE FUNCTION kasitek_validate_agent_installation_mode() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  definition_owner_type TEXT;
  definition_protected BOOLEAN;
  definition_slug TEXT;
BEGIN
  SELECT owner_type, protected, slug
    INTO definition_owner_type, definition_protected, definition_slug
  FROM agent_definitions
  WHERE id = NEW.agent_definition_id;

  IF definition_owner_type IS NULL THEN
    RAISE EXCEPTION 'Installation definition does not exist';
  END IF;

  IF NEW.execution_mode = 'system_hosted'
     AND NOT (definition_owner_type = 'system' AND definition_protected = TRUE) THEN
    RAISE EXCEPTION 'Only protected system definitions may use system_hosted mode';
  END IF;

  IF definition_owner_type = 'system' AND definition_protected = TRUE
     AND NEW.execution_mode <> 'system_hosted' THEN
    RAISE EXCEPTION 'Protected system definitions must use system_hosted mode';
  END IF;

  IF definition_owner_type = 'system' AND definition_protected = TRUE
     AND definition_slug = 'kasiai' AND NEW.execution_mode <> 'system_hosted' THEN
    RAISE EXCEPTION 'The protected KasiAi identity must use system_hosted mode';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_installations
    WHERE agent_definition_id = NEW.agent_definition_id
      AND id <> NEW.id
      AND execution_mode IS DISTINCT FROM NEW.execution_mode
  ) THEN
    RAISE EXCEPTION 'An agent definition cannot mix execution modes';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_installations_execution_mode_guard ON agent_installations;
CREATE TRIGGER agent_installations_execution_mode_guard
BEFORE INSERT OR UPDATE OF agent_definition_id, execution_mode ON agent_installations
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_agent_installation_mode();

-- The authenticated platform sidebar belongs only to KasiAi. User agents have
-- their own test/conversation surfaces and must not replace or impersonate the
-- protected workspace assistant connection.
CREATE OR REPLACE FUNCTION kasitek_validate_sidebar_connection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  installation_mode TEXT;
  definition_owner_type TEXT;
  definition_protected BOOLEAN;
  definition_slug TEXT;
BEGIN
  SELECT ai.execution_mode, ad.owner_type, ad.protected, ad.slug
    INTO installation_mode, definition_owner_type, definition_protected, definition_slug
  FROM agent_installations ai
  JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
  WHERE ai.id = NEW.installation_id
    AND ai.organization_id = NEW.organization_id;

  IF installation_mode IS NULL THEN
    RAISE EXCEPTION 'Channel connection installation does not belong to its organization';
  END IF;

  IF NEW.channel_type = 'platform' AND NEW.channel_key = 'sidebar'
     AND NOT (
       installation_mode = 'system_hosted'
       AND definition_owner_type = 'system'
       AND definition_protected = TRUE
       AND definition_slug = 'kasiai'
     ) THEN
    RAISE EXCEPTION 'The protected KasiAi installation owns the platform sidebar';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_connections_sidebar_guard ON channel_connections;
CREATE TRIGGER channel_connections_sidebar_guard
BEFORE INSERT OR UPDATE OF organization_id, installation_id, channel_type, channel_key ON channel_connections
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_sidebar_connection();
