-- A handoff episode has one durable acknowledgement winner.
CREATE TABLE agents_platform.pending_handoff_receipts (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  ownership_generation bigint NOT NULL CHECK (ownership_generation > 0),
  delay_ms integer NOT NULL CHECK (delay_ms > 0),
  feedback_request_digest text CHECK (feedback_request_digest ~ '^[a-f0-9]{64}$'),
  evidence_manifest jsonb,
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  outcome text CHECK (outcome IN ('model', 'fallback', 'suppressed')),
  message_id uuid UNIQUE REFERENCES agents_platform.customer_messages(id),
  settled_at timestamptz,
  UNIQUE (conversation_id, ownership_generation),
  CHECK (deadline > created_at),
  CHECK ((feedback_request_digest IS NULL AND evidence_manifest IS NULL) OR (feedback_request_digest IS NOT NULL AND evidence_manifest IS NOT NULL AND jsonb_typeof(evidence_manifest)='object')),
  CHECK ((outcome IS NULL AND message_id IS NULL AND settled_at IS NULL)
    OR (outcome IN ('model', 'fallback') AND message_id IS NOT NULL AND settled_at IS NOT NULL)
    OR (outcome = 'suppressed' AND message_id IS NULL AND settled_at IS NOT NULL))
);
CREATE INDEX pending_handoff_receipt_dispatch ON agents_platform.pending_handoff_receipts(created_at,task_id)
  WHERE dispatched_at IS NULL AND outcome IS NULL;
CREATE FUNCTION agents_platform.protect_pending_handoff_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.ownership_generation IS DISTINCT FROM OLD.ownership_generation OR NEW.delay_ms IS DISTINCT FROM OLD.delay_ms
    OR NEW.feedback_request_digest IS DISTINCT FROM OLD.feedback_request_digest OR NEW.evidence_manifest IS DISTINCT FROM OLD.evidence_manifest
    OR NEW.deadline IS DISTINCT FROM OLD.deadline OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.settled_at IS DISTINCT FROM OLD.settled_at))
  THEN RAISE EXCEPTION 'Handoff receipt is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_pending_handoff_receipt BEFORE UPDATE ON agents_platform.pending_handoff_receipts
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_pending_handoff_receipt();
