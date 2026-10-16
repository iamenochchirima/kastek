-- A journal cursor is the admission fence for memory evidence.  Do not allow
-- two different source events to occupy one run cursor: listAfter() relies on
-- the sequence being a lossless ordered boundary during replay and recovery.
CREATE UNIQUE INDEX IF NOT EXISTS memory_source_events_run_sequence_uidx
  ON memory_source_events (organization_id, run_id, event_sequence)
  WHERE run_id IS NOT NULL AND event_sequence IS NOT NULL;
