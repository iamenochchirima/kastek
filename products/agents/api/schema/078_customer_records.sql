CREATE TABLE agents_platform.customer_contacts (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 name text CHECK(length(name)<=200), email text CHECK(length(email)<=320), phone text CHECK(length(phone)<=80),
 participant_key text, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,participant_key)
);
CREATE INDEX customer_contacts_page ON agents_platform.customer_contacts(organization_id,created_at DESC,id DESC);
CREATE TABLE agents_platform.customer_record_enquiries (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 source_enquiry_id uuid UNIQUE, source_task_id uuid REFERENCES agents_platform.tasks(id),
 agent_id uuid, conversation_id uuid, customer_conversation_id uuid,
 channel text, contact_id uuid, original_fields jsonb NOT NULL, fields jsonb NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','waiting_on_customer','closed')),
 assignee_account_id uuid REFERENCES agents_platform.accounts(id), due_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,source_enquiry_id) REFERENCES agents_platform.enquiries(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES agents_platform.conversations(organization_id,id),
 FOREIGN KEY(organization_id,customer_conversation_id) REFERENCES agents_platform.customer_conversations(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES agents_platform.customer_contacts(organization_id,id),
 UNIQUE(organization_id,id),
 CHECK(jsonb_typeof(fields)='object' AND octet_length(fields::text)<=8192),
 CHECK(jsonb_typeof(original_fields)='object' AND octet_length(original_fields::text)<=8192)
);
CREATE INDEX customer_record_enquiries_page ON agents_platform.customer_record_enquiries(organization_id,created_at DESC,id DESC);
CREATE INDEX customer_record_enquiries_assignment ON agents_platform.customer_record_enquiries(organization_id,assignee_account_id,status,due_at);
CREATE INDEX customer_record_enquiries_contact ON agents_platform.customer_record_enquiries(organization_id,contact_id,created_at DESC,id DESC);
CREATE TABLE agents_platform.customer_record_activity (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, enquiry_id uuid NOT NULL, kind text NOT NULL,
 actor_account_id uuid REFERENCES agents_platform.accounts(id), body text CHECK(length(body)<=4000),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,enquiry_id) REFERENCES agents_platform.customer_record_enquiries(organization_id,id)
);
CREATE INDEX customer_record_activity_page ON agents_platform.customer_record_activity(organization_id,enquiry_id,created_at DESC,id DESC);
CREATE TABLE agents_platform.customer_record_commands (
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id), command_id uuid NOT NULL,
 actor_account_id uuid NOT NULL REFERENCES agents_platform.accounts(id), request_digest text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,command_id)
);
CREATE FUNCTION agents_platform.protect_customer_record_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.organization_id,NEW.id,NEW.source_enquiry_id,NEW.source_task_id,NEW.agent_id,NEW.conversation_id,NEW.customer_conversation_id,NEW.channel,NEW.original_fields,NEW.created_at)
 IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.source_enquiry_id,OLD.source_task_id,OLD.agent_id,OLD.conversation_id,OLD.customer_conversation_id,OLD.channel,OLD.original_fields,OLD.created_at)
 THEN RAISE EXCEPTION 'Customer record origin is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_customer_record_origin BEFORE UPDATE ON agents_platform.customer_record_enquiries FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_customer_record_origin();

CREATE TABLE agents_platform.customer_record_submissions (
 organization_id uuid NOT NULL, source_enquiry_id uuid PRIMARY KEY, record_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,source_enquiry_id) REFERENCES agents_platform.enquiries(organization_id,id),
 FOREIGN KEY(organization_id,record_id) REFERENCES agents_platform.customer_record_enquiries(organization_id,id)
);
