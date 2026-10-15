CREATE TABLE IF NOT EXISTS agent_approval_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  provider_tool_call_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  resource_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview_revision TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  UNIQUE (run_id, provider_tool_call_id)
);

CREATE INDEX IF NOT EXISTS agent_approval_records_pending_idx
  ON agent_approval_records (organization_id, status, expires_at);
