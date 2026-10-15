-- Identical evidence can belong to independent runs or turns. Retain replay
-- deduplication inside its owning installation/run/turn rather than across
-- every run in an organization. Scope validators and RLS remain unchanged.
DO $$
DECLARE existing_constraint record;
BEGIN
  FOR existing_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'memory_source_events'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (organization_id, evidence_digest, source_boundary)'
  LOOP
    EXECUTE format('ALTER TABLE memory_source_events DROP CONSTRAINT %I', existing_constraint.conname);
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX memory_source_events_owned_evidence_idx
  ON memory_source_events (organization_id, installation_id, run_id, turn_id, evidence_digest, source_boundary)
  NULLS NOT DISTINCT;
