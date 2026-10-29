-- Minimal isolated status-notice test schema.
CREATE TABLE agents_platform.support_status_notices (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.support_status_executions(task_id),
  message_id uuid NOT NULL UNIQUE REFERENCES agents_platform.customer_messages(id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  ownership_generation bigint NOT NULL CHECK (ownership_generation > 0),
  body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION agents_platform.protect_support_status_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM agents_platform.tasks t WHERE t.id=OLD.task_id AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain')) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Support status receipt is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER immutable_support_status_notice BEFORE UPDATE OR DELETE ON agents_platform.support_status_notices
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_support_status_notice();
