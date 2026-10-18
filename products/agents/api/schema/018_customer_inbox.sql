CREATE TABLE agents_platform.customer_conversations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES agents_platform.website_sessions(id),
  execution_conversation_id uuid REFERENCES agents_platform.conversations(id),
  state text NOT NULL DEFAULT 'automation_active' CHECK (state IN ('automation_active','handoff_pending','human_owned','resolved')),
  assignee_account_id uuid REFERENCES agents_platform.accounts(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  ownership_generation bigint NOT NULL DEFAULT 1 CHECK (ownership_generation>0),
  next_sequence bigint NOT NULL DEFAULT 1,
  return_watermark bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,deployment_id) REFERENCES agents_platform.website_deployments(organization_id,id),
  FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
  FOREIGN KEY(organization_id,version_id) REFERENCES agents_platform.agent_versions(organization_id,id),
  UNIQUE(deployment_id,session_id), UNIQUE(organization_id,id)
);
CREATE INDEX customer_inbox_page ON agents_platform.customer_conversations(organization_id,updated_at DESC,id DESC);
CREATE INDEX customer_inbox_assignment ON agents_platform.customer_conversations(organization_id,assignee_account_id,state);

CREATE TABLE agents_platform.customer_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  sequence bigint NOT NULL,
  author_kind text NOT NULL CHECK(author_kind IN ('visitor','human','assistant')),
  author_account_id uuid REFERENCES agents_platform.accounts(id),
  body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 32768),
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL,
  task_id uuid REFERENCES agents_platform.tasks(id),
  ownership_generation bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,sequence), UNIQUE(conversation_id,request_key), UNIQUE(task_id,author_kind)
);
CREATE TABLE agents_platform.customer_deliveries (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  task_id uuid UNIQUE REFERENCES agents_platform.tasks(id),
  message_id uuid UNIQUE REFERENCES agents_platform.customer_messages(id),
  ownership_generation bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('published','suppressed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((state='published' AND message_id IS NOT NULL) OR (state='suppressed' AND message_id IS NULL))
);
CREATE TABLE agents_platform.customer_commands (
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  command_id uuid NOT NULL,
  actor_account_id uuid REFERENCES agents_platform.accounts(id),
  action text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,command_id)
);
CREATE TABLE agents_platform.customer_task_links (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  input_message_id uuid UNIQUE NOT NULL REFERENCES agents_platform.customer_messages(id),
  ownership_generation bigint NOT NULL
);
CREATE INDEX customer_task_roots ON agents_platform.customer_task_links(conversation_id,ownership_generation);
CREATE TABLE agents_platform.customer_cancellations (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION agents_platform.protect_customer_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.author_kind IS DISTINCT FROM OLD.author_kind
    OR NEW.author_account_id IS DISTINCT FROM OLD.author_account_id OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.ownership_generation IS DISTINCT FROM OLD.ownership_generation OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.task_id IS DISTINCT FROM OLD.task_id AND NOT (OLD.author_kind='visitor' AND OLD.task_id IS NULL AND NEW.task_id IS NOT NULL))
  THEN RAISE EXCEPTION 'Canonical customer messages are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_customer_message BEFORE UPDATE ON agents_platform.customer_messages
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_customer_message();

CREATE FUNCTION agents_platform.protect_customer_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.version_id IS DISTINCT FROM OLD.version_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR (NEW.execution_conversation_id IS DISTINCT FROM OLD.execution_conversation_id AND OLD.execution_conversation_id IS NOT NULL)
  THEN RAISE EXCEPTION 'Customer conversation binding is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_customer_binding BEFORE UPDATE ON agents_platform.customer_conversations
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_customer_binding();
