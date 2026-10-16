-- Make workspace ownership explicit on canonical facts. Installation scope is
-- retained as the authorization anchor, but a fact must carry the workspace
-- identity it was created for so scope cannot drift when installation settings
-- change later.

ALTER TABLE agent_memory_facts
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

UPDATE agent_memory_facts fact
SET workspace_id = installation.scope_id
FROM agent_installations installation
WHERE installation.id = fact.installation_id
  AND fact.workspace_id IS NULL;

ALTER TABLE agent_memory_facts
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE agent_memory_facts
  DROP CONSTRAINT IF EXISTS agent_memory_facts_workspace_id_check;
ALTER TABLE agent_memory_facts
  ADD CONSTRAINT agent_memory_facts_workspace_id_check
  CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240);

DROP INDEX IF EXISTS agent_memory_facts_identity_idx;
CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_facts_identity_idx
  ON agent_memory_facts (
    organization_id,
    workspace_id,
    installation_id,
    namespace,
    memory_type,
    fact_key,
    COALESCE(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(end_user_id, '')
  );

CREATE INDEX IF NOT EXISTS agent_memory_facts_workspace_scope_idx
  ON agent_memory_facts (organization_id, workspace_id, agent_definition_id, installation_id, namespace, memory_type, created_at DESC);

CREATE OR REPLACE FUNCTION kasitek_validate_memory_fact_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  definition RECORD;
  installation RECORD;
  version_exists BOOLEAN;
  conversation_exists BOOLEAN;
BEGIN
  SELECT organization_id, owner_type, protected
  INTO definition
  FROM agent_definitions
  WHERE id = NEW.agent_definition_id;
  IF NOT FOUND OR (
    definition.organization_id <> NEW.organization_id
    AND NOT (definition.owner_type = 'system' AND definition.protected = TRUE)
  ) THEN
    RAISE EXCEPTION 'Memory fact agent is outside the tenant scope';
  END IF;

  SELECT agent_definition_id, organization_id, scope_id
  INTO installation
  FROM agent_installations
  WHERE id = NEW.installation_id;
  IF NOT FOUND OR installation.organization_id <> NEW.organization_id OR installation.agent_definition_id <> NEW.agent_definition_id THEN
    RAISE EXCEPTION 'Memory fact installation is outside the agent scope';
  END IF;
  IF installation.scope_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Memory fact workspace is outside the installation scope';
  END IF;

  IF NEW.agent_version_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM agent_versions
      WHERE id = NEW.agent_version_id AND agent_definition_id = NEW.agent_definition_id
    ) INTO version_exists;
    IF NOT version_exists THEN
      RAISE EXCEPTION 'Memory fact version is outside the agent scope';
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
      RAISE EXCEPTION 'Memory fact conversation is outside the installation scope';
    END IF;
  END IF;
  IF NEW.namespace = 'conversation' AND NEW.conversation_id IS NULL THEN
    RAISE EXCEPTION 'Conversation memory requires conversation scope';
  END IF;
  IF NEW.namespace = 'end_user_private' AND NULLIF(trim(NEW.end_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'End-user memory requires end-user scope';
  END IF;
  IF NEW.namespace <> 'conversation' AND NEW.conversation_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only conversation memory may carry conversation scope';
  END IF;
  IF NEW.namespace <> 'end_user_private' AND NEW.end_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only end-user memory may carry end-user scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_facts_workspace_scope_trigger ON agent_memory_facts;
CREATE TRIGGER agent_memory_facts_workspace_scope_trigger
BEFORE INSERT OR UPDATE OF workspace_id, installation_id, organization_id, agent_definition_id
ON agent_memory_facts
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_fact_scope();
