CREATE TABLE IF NOT EXISTS agent_effect_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  provider_tool_call_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'executing', 'succeeded', 'failed', 'unknown', 'reconciled')),
  provider_receipt JSONB,
  error JSONB,
  reconciliation_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (run_id, provider_tool_call_id)
);

CREATE INDEX IF NOT EXISTS agent_effect_receipts_reconciliation_idx
  ON agent_effect_receipts (organization_id, reconciliation_required, updated_at);
