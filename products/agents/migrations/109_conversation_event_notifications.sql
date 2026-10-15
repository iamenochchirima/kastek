CREATE OR REPLACE FUNCTION notify_agent_conversation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  notification JSON;
BEGIN
  IF TG_TABLE_NAME = 'agent_events' THEN
    IF NEW.subject IS NULL OR NEW.subject NOT LIKE 'conversation:%' THEN
      RETURN NEW;
    END IF;
    notification := json_build_object(
      'organizationId', NEW.organization_id,
      'subject', NEW.subject,
      'eventType', NEW.event_type
    );
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = NEW.conversation_id
        AND c.organization_id = NEW.organization_id
        AND c.conversation_kind = 'customer'
    ) THEN
      RETURN NEW;
    END IF;
    notification := json_build_object(
      'organizationId', NEW.organization_id,
      'subject', 'conversation:' || NEW.conversation_id,
      'eventType', 'conversation.message.changed'
    );
  END IF;

  PERFORM pg_notify('agent_conversation_events', notification::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_events_conversation_notify ON agent_events;
CREATE TRIGGER agent_events_conversation_notify
AFTER INSERT ON agent_events
FOR EACH ROW EXECUTE FUNCTION notify_agent_conversation_change();

DROP TRIGGER IF EXISTS messages_conversation_notify ON messages;
CREATE TRIGGER messages_conversation_notify
AFTER INSERT OR UPDATE OF delivery_status ON messages
FOR EACH ROW EXECUTE FUNCTION notify_agent_conversation_change();
