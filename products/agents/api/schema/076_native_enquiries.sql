CREATE TABLE agents_platform.enquiries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  conversation_id uuid NOT NULL,
  customer_conversation_id uuid REFERENCES agents_platform.customer_conversations(id),
  principal jsonb NOT NULL,
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 256),
  request_digest text NOT NULL,
  fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='object' AND octet_length(fields::text)<=8192),
  state text NOT NULL CHECK(state IN ('pending','approved','submitted','rejected','expired')),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
  FOREIGN KEY(organization_id,conversation_id) REFERENCES agents_platform.conversations(organization_id,id),
  UNIQUE(task_id,operation_id), UNIQUE(organization_id,id)
);
CREATE INDEX enquiries_staff_page ON agents_platform.enquiries(organization_id,created_at DESC,id DESC) WHERE state='submitted';
CREATE INDEX enquiries_customer_conversation ON agents_platform.enquiries(organization_id,customer_conversation_id,created_at DESC) WHERE state='submitted';

-- A task may publish exact review prompts before its single final assistant message.
ALTER TABLE agents_platform.customer_messages DROP CONSTRAINT customer_messages_task_id_author_kind_key;
CREATE UNIQUE INDEX customer_message_task_output ON agents_platform.customer_messages(task_id,author_kind)
  WHERE request_key NOT LIKE 'tool-review:%' AND request_key NOT LIKE 'enquiry-review:%';
