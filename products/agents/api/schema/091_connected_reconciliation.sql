-- Staff-only read reconciliation of an already uncertain effect.
CREATE TABLE agents_platform.connected_reconciliation_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  operation_id text NOT NULL REFERENCES agents_platform.connected_uncertain_escalations(operation_id),
  requested_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  request_key uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  source_claim_digest text NOT NULL CHECK(source_claim_digest ~ '^[a-f0-9]{64}$'),
  connection_policy_revision integer NOT NULL CHECK(connection_policy_revision>0),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed','found','inconclusive','unavailable')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  observed_at timestamptz,
  provider_response_digest text CHECK(provider_response_digest ~ '^[a-f0-9]{64}$'),
  reason text CHECK(reason IN ('matching_record_observed','not_observed','mismatch','ambiguous','provider_unavailable','authority_changed','deadline_expired')),
  FOREIGN KEY(organization_id,conversation_id) REFERENCES agents_platform.customer_conversations(organization_id,id),
  UNIQUE(organization_id,requested_by,request_key),
  CHECK(deadline_at>created_at AND deadline_at<=created_at+interval '30 seconds'),
  CHECK((state='queued' AND lease_token IS NULL AND lease_until IS NULL AND observed_at IS NULL AND provider_response_digest IS NULL AND reason IS NULL)
    OR (state='claimed' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND lease_until<=deadline_at AND observed_at IS NULL AND provider_response_digest IS NULL AND reason IS NULL)
    OR (state='found' AND lease_token IS NULL AND lease_until IS NULL AND observed_at IS NOT NULL AND provider_response_digest IS NOT NULL AND reason='matching_record_observed')
    OR (state='inconclusive' AND lease_token IS NULL AND lease_until IS NULL AND observed_at IS NOT NULL AND reason IN ('not_observed','mismatch','ambiguous'))
    OR (state='unavailable' AND lease_token IS NULL AND lease_until IS NULL AND observed_at IS NOT NULL AND reason IN ('provider_unavailable','authority_changed','deadline_expired')))
);
CREATE UNIQUE INDEX connected_reconciliation_single_active ON agents_platform.connected_reconciliation_attempts(operation_id) WHERE state IN ('queued','claimed');

CREATE FUNCTION agents_platform.protect_connected_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM agents_platform.connected_uncertain_escalations e
      WHERE e.operation_id=NEW.operation_id AND e.organization_id=NEW.organization_id AND e.conversation_id=NEW.conversation_id
        AND e.claim_digest=NEW.source_claim_digest) THEN
      RAISE EXCEPTION 'Reconciliation source does not match' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.state IN ('found','inconclusive','unavailable')
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.request_key IS DISTINCT FROM OLD.request_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.source_claim_digest IS DISTINCT FROM OLD.source_claim_digest
    OR NEW.connection_policy_revision IS DISTINCT FROM OLD.connection_policy_revision
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
    OR (OLD.state='queued' AND NEW.state NOT IN ('queued','claimed','unavailable'))
    OR (OLD.state='claimed' AND NEW.state NOT IN ('claimed','found','inconclusive','unavailable'))
    OR (OLD.state='claimed' AND NEW.state='claimed' AND NEW.lease_token IS DISTINCT FROM OLD.lease_token)
    OR (NEW.state IN ('found','inconclusive') AND (OLD.state<>'claimed' OR OLD.lease_until<=clock_timestamp() OR OLD.deadline_at<=clock_timestamp()))
  THEN RAISE EXCEPTION 'Reconciliation receipt is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_connected_reconciliation BEFORE INSERT OR UPDATE OR DELETE ON agents_platform.connected_reconciliation_attempts
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_connected_reconciliation();
