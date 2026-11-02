CREATE TABLE agents_platform.support_waiting (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  ownership_generation bigint NOT NULL CHECK (ownership_generation > 0),
  policy_version text NOT NULL DEFAULT 'support-waiting-v1',
  requested_at timestamptz NOT NULL DEFAULT now(),
  next_action_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  customer_stage integer NOT NULL DEFAULT 0 CHECK (customer_stage BETWEEN 0 AND 2),
  staff_stage integer NOT NULL DEFAULT 0 CHECK (staff_stage BETWEEN 0 AND 2),
  dispatched_at timestamptz,
  completed_at timestamptz,
  stopped_reason text,
  UNIQUE (conversation_id,ownership_generation),
  UNIQUE (task_id,conversation_id)
);
CREATE INDEX support_waiting_dispatch ON agents_platform.support_waiting(requested_at,task_id)
  WHERE dispatched_at IS NULL AND completed_at IS NULL;

CREATE TABLE agents_platform.support_waiting_notices (
  task_id uuid NOT NULL REFERENCES agents_platform.support_waiting(task_id),
  stage integer NOT NULL CHECK (stage BETWEEN 1 AND 2),
  message_id uuid UNIQUE REFERENCES agents_platform.customer_messages(id),
  ownership_generation bigint NOT NULL CHECK (ownership_generation > 0),
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 4096),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','published','suppressed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,stage),
  CHECK ((state='published' AND message_id IS NOT NULL) OR (state<>'published' AND message_id IS NULL))
);
CREATE FUNCTION agents_platform.protect_support_waiting_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.stage IS DISTINCT FROM OLD.stage
    OR NEW.body IS DISTINCT FROM OLD.body OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Published support notice receipts are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_support_waiting_notice BEFORE UPDATE ON agents_platform.support_waiting_notices
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_support_waiting_notice();

CREATE TABLE agents_platform.support_staff_alerts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  task_id uuid NOT NULL REFERENCES agents_platform.support_waiting(task_id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  stage integer NOT NULL CHECK (stage BETWEEN 0 AND 2),
  kind text NOT NULL CHECK (kind IN ('handoff_requested','unassigned','awaiting_human_reply')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE(task_id,account_id,stage),
  FOREIGN KEY(organization_id,conversation_id) REFERENCES agents_platform.customer_conversations(organization_id,id),
  FOREIGN KEY(task_id,conversation_id) REFERENCES agents_platform.support_waiting(task_id,conversation_id)
);
CREATE INDEX support_staff_alerts_unread ON agents_platform.support_staff_alerts(organization_id,account_id,created_at DESC)
  WHERE acknowledged_at IS NULL;
