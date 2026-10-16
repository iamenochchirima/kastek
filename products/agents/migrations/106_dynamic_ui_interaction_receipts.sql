CREATE TABLE IF NOT EXISTS agent_ui_interaction_receipts (
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID NOT NULL,
  block_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  "values" JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (organization_id, installation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS agent_ui_interaction_receipts_run_idx
  ON agent_ui_interaction_receipts (organization_id, run_id)
  WHERE run_id IS NOT NULL;
