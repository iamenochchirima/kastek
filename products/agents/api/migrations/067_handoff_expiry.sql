-- Make handoff expiry explicit so queue workers and operators share one deadline.
ALTER TABLE agent_handoff_requests
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE agent_handoff_requests
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

ALTER TABLE agent_handoff_requests
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS agent_handoff_requests_expiry_idx
  ON agent_handoff_requests (organization_id, status, expires_at)
  WHERE status = 'pending';
