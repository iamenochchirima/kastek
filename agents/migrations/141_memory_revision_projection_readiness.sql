-- Canonical revisions remain append-only, while provider/index readiness is a
-- mutable projection of an immutable revision. Restrict the immutability
-- trigger to domain fields so workers can advance indexed_at/visible_at.

DROP TRIGGER IF EXISTS agent_memory_revisions_immutable_trigger ON agent_memory_revisions;
CREATE TRIGGER agent_memory_revisions_immutable_trigger
BEFORE UPDATE OF fact_id, organization_id, revision_number, transition_type,
  lifecycle_state, canonical_text, typed_value, event_time, event_summary,
  participants, outcome, valid_from, valid_to, observed_at, recorded_at,
  confidence, source_trust, sensitivity, provenance, evidence_digest,
  extraction_version, predecessor_revision_id, idempotency_key,
  operation_fingerprint, accepted_at, committed_at, created_by, created_at
ON agent_memory_revisions
FOR EACH ROW EXECUTE FUNCTION kasitek_reject_memory_revision_update();
