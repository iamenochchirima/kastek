ALTER TABLE agent_events
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

UPDATE agent_events AS event
SET correlation_id = run.correlation_id
FROM agent_runs AS run
WHERE event.run_id = run.id
  AND event.correlation_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_events_correlation_idx
  ON agent_events (organization_id, correlation_id, created_at DESC);
