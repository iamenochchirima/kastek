-- Protected system definitions belong to the platform organization, while the
-- context created for an installation belongs to the customer organization.
-- Preserve the same-organization rule for customer-owned definitions and keep
-- the installation ownership check as the customer isolation boundary.
CREATE OR REPLACE FUNCTION kasitek_validate_agent_context_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_definition_id IS NULL THEN
    RAISE EXCEPTION 'Agent context records require an agent definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM agent_definitions ad
    WHERE ad.id = NEW.agent_definition_id
      AND (
        ad.organization_id = NEW.organization_id
        OR (ad.owner_type = 'system' AND ad.protected = TRUE)
      )
  ) THEN
    RAISE EXCEPTION 'Agent context organization does not match its definition';
  END IF;

  IF NEW.installation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM agent_installations ai
    WHERE ai.id = NEW.installation_id
      AND ai.organization_id = NEW.organization_id
      AND ai.agent_definition_id = NEW.agent_definition_id
  ) THEN
    RAISE EXCEPTION 'Agent context installation does not belong to its definition';
  END IF;

  RETURN NEW;
END;
$$;
