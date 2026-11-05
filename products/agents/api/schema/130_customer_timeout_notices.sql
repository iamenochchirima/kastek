-- Platform-owned channel notice for an expired customer turn, separate from model output.
CREATE TABLE agents_platform.customer_timeout_notices (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id) ON DELETE CASCADE,
  input_message_id uuid NOT NULL REFERENCES agents_platform.customer_messages(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES agents_platform.customer_messages(id) ON DELETE CASCADE,
  ownership_generation bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
