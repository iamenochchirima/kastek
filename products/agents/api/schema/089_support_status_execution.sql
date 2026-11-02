ALTER TABLE agents_platform.tasks ADD COLUMN execution_purpose text NOT NULL DEFAULT 'business_v1'
  CHECK (execution_purpose IN ('business_v1','support_status_v1'));
CREATE FUNCTION agents_platform.protect_task_execution_purpose() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_purpose IS DISTINCT FROM OLD.execution_purpose THEN
    RAISE EXCEPTION 'Task execution purpose is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_task_execution_purpose BEFORE UPDATE ON agents_platform.tasks
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_task_execution_purpose();
CREATE TABLE agents_platform.support_status_executions (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  organization_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  input_message_id uuid NOT NULL UNIQUE REFERENCES agents_platform.customer_messages(id),
  episode_command_id uuid NOT NULL,
  ownership_generation bigint NOT NULL CHECK (ownership_generation > 0),
  FOREIGN KEY (organization_id,conversation_id) REFERENCES agents_platform.customer_conversations(organization_id,id),
  FOREIGN KEY (conversation_id,episode_command_id) REFERENCES agents_platform.customer_commands(conversation_id,command_id)
);
CREATE FUNCTION agents_platform.protect_support_status_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Support status execution is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM agents_platform.tasks t WHERE t.id=OLD.task_id AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')) THEN
      RAISE EXCEPTION 'Active support status execution cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agents_platform.tasks t WHERE t.id=NEW.task_id AND t.organization_id=NEW.organization_id
    AND t.execution_purpose='support_status_v1' AND t.root_task_id=t.id AND t.parent_task_id IS NULL AND t.state='accepted') THEN
    RAISE EXCEPTION 'Invalid support status task' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_support_status_execution BEFORE INSERT OR UPDATE OR DELETE ON agents_platform.support_status_executions
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_support_status_execution();
-- Proof-backed status replies are scoped to their triggering message.
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
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM agents_platform.tasks t WHERE t.id=OLD.task_id AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')) THEN
      RAISE EXCEPTION 'Active support status receipt cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Support status receipt is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER immutable_support_status_notice BEFORE UPDATE OR DELETE ON agents_platform.support_status_notices
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_support_status_notice();
