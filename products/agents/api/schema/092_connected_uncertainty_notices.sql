-- Operation-bound customer updates for uncertain reviewed contact saves.
CREATE TABLE agents_platform.connected_uncertainty_notices (
  operation_id text PRIMARY KEY REFERENCES agents_platform.connected_uncertain_escalations(operation_id),
  organization_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  command_id uuid NOT NULL,
  message_id uuid NOT NULL UNIQUE REFERENCES agents_platform.customer_messages(id),
  ownership_generation bigint NOT NULL CHECK (ownership_generation>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,conversation_id) REFERENCES agents_platform.customer_conversations(organization_id,id),
  FOREIGN KEY(conversation_id,command_id) REFERENCES agents_platform.customer_commands(conversation_id,command_id)
);
CREATE FUNCTION agents_platform.protect_connected_uncertainty_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Connected uncertainty notice is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER immutable_connected_uncertainty_notice BEFORE UPDATE OR DELETE ON agents_platform.connected_uncertainty_notices
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_connected_uncertainty_notice();
