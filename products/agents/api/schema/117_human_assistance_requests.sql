CREATE TABLE IF NOT EXISTS agents_platform.human_assistance_requests (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
 task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
 input_message_id uuid NOT NULL REFERENCES agents_platform.customer_messages(id),
 ownership_generation bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('requested','human_owned','completed','withdrawn')),
 brief jsonb NOT NULL,
 support_facts jsonb NOT NULL,
 notice_message_id uuid REFERENCES agents_platform.customer_messages(id),
 notice_body text NOT NULL,
 contact jsonb,
 human_only boolean NOT NULL DEFAULT false,
 requested_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS human_assistance_active_conversation ON agents_platform.human_assistance_requests(conversation_id) WHERE status IN ('requested','human_owned');
CREATE INDEX IF NOT EXISTS human_assistance_organization_queue ON agents_platform.human_assistance_requests(organization_id,requested_at DESC) WHERE status IN ('requested','human_owned');
CREATE TABLE IF NOT EXISTS agents_platform.human_assistance_commands (
 task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
 operation_id text NOT NULL,
 request_digest text NOT NULL,
 customer_choice_message_id uuid REFERENCES agents_platform.customer_messages(id),
 disposition text CHECK(disposition IN ('human_only','withdrawn','self_service','declined')),
 request_id uuid NOT NULL REFERENCES agents_platform.human_assistance_requests(id),
 result jsonb NOT NULL,
 PRIMARY KEY(task_id,operation_id)
);
