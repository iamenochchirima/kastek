-- Durable, operation-keyed recovery for uncertain customer contact writes.
CREATE TABLE agents_platform.connected_uncertain_escalations (
  operation_id text PRIMARY KEY REFERENCES agents_platform.connected_reads(operation_id),
  organization_id uuid NOT NULL,
  task_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  input_message_id uuid NOT NULL REFERENCES agents_platform.customer_messages(id),
  ownership_generation bigint NOT NULL CHECK (ownership_generation > 0),
  claim_digest text NOT NULL CHECK (claim_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','recorded','ownership_changed')),
  command_id uuid,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code='authority_unavailable'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
  FOREIGN KEY (organization_id,conversation_id) REFERENCES agents_platform.customer_conversations(organization_id,id),
  FOREIGN KEY (conversation_id,command_id) REFERENCES agents_platform.customer_commands(conversation_id,command_id),
  CHECK ((state='recorded' AND command_id IS NOT NULL) OR (state<>'recorded' AND command_id IS NULL))
);
CREATE INDEX connected_uncertain_escalations_pending ON agents_platform.connected_uncertain_escalations(next_attempt_at,operation_id) WHERE state='pending' AND next_attempt_at IS NOT NULL;
CREATE FUNCTION agents_platform.protect_connected_uncertain_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.input_message_id IS DISTINCT FROM OLD.input_message_id OR NEW.ownership_generation IS DISTINCT FROM OLD.ownership_generation
    OR NEW.claim_digest IS DISTINCT FROM OLD.claim_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Uncertain escalation is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_connected_uncertain_escalation BEFORE UPDATE OR DELETE ON agents_platform.connected_uncertain_escalations
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_connected_uncertain_escalation();
