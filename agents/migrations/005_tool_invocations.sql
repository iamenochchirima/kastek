CREATE TABLE IF NOT EXISTS tool_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  organization_id TEXT NOT NULL,
  provider_tool_call_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  risk_class TEXT NOT NULL CHECK (risk_class IN ('read', 'draft', 'controlled-write', 'external-effect', 'privileged')),
  arguments_hash TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'awaiting_approval', 'approved', 'rejected', 'executing', 'completed', 'failed')),
  approval JSONB,
  output JSONB,
  error JSONB,
  latency_ms INTEGER,
  effect_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (run_id, provider_tool_call_id)
);

CREATE INDEX IF NOT EXISTS tool_invocations_run_idx
  ON tool_invocations (organization_id, run_id, sequence_number);
