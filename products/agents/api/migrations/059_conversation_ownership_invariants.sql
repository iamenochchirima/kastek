-- Conversations are installation-local agent transcripts. Foreign keys protect
-- row existence, while these triggers protect the organization and installation
-- ownership carried redundantly on each aggregate.
CREATE OR REPLACE FUNCTION kasitek_validate_conversation_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  installation_organization TEXT;
BEGIN
  SELECT organization_id INTO installation_organization
  FROM agent_installations
  WHERE id = NEW.installation_id;
  IF installation_organization IS NULL OR installation_organization <> NEW.organization_id THEN
    RAISE EXCEPTION 'Conversation installation does not belong to its organization';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_ownership_trigger ON conversations;
CREATE TRIGGER conversations_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, installation_id ON conversations
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_conversation_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_conversation_child_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conversation_organization TEXT;
BEGIN
  SELECT organization_id INTO conversation_organization
  FROM conversations
  WHERE id = NEW.conversation_id;
  IF conversation_organization IS NULL OR conversation_organization <> NEW.organization_id THEN
    RAISE EXCEPTION 'Conversation child does not belong to its conversation organization';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS participants_conversation_scope_trigger ON participants;
CREATE TRIGGER participants_conversation_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, conversation_id ON participants
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_conversation_child_scope();

DROP TRIGGER IF EXISTS messages_conversation_scope_trigger ON messages;
CREATE TRIGGER messages_conversation_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, conversation_id ON messages
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_conversation_child_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_run_conversation_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversations
    WHERE id = NEW.conversation_id
      AND organization_id = NEW.organization_id
      AND installation_id = NEW.installation_id
  ) THEN
    RAISE EXCEPTION 'Run conversation does not belong to its installation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_runs_conversation_scope_trigger ON agent_runs;
CREATE TRIGGER agent_runs_conversation_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, installation_id, conversation_id ON agent_runs
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_conversation_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_run_child_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_organization TEXT;
BEGIN
  IF NEW.run_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT organization_id INTO run_organization
  FROM agent_runs
  WHERE id = NEW.run_id;
  IF run_organization IS NULL OR run_organization <> NEW.organization_id THEN
    RAISE EXCEPTION 'Run child does not belong to its run organization';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS run_steps_ownership_trigger ON run_steps;
CREATE TRIGGER run_steps_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON run_steps
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();

DROP TRIGGER IF EXISTS agent_events_ownership_trigger ON agent_events;
CREATE TRIGGER agent_events_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON agent_events
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();
