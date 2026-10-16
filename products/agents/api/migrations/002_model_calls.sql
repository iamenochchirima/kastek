CREATE TABLE IF NOT EXISTS model_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  run_id UUID REFERENCES agent_runs(id),
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'gemini')),
  model TEXT NOT NULL,
  funding_source TEXT NOT NULL CHECK (funding_source IN ('kasitek', 'user')),
  credential_reference TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(18, 8),
  latency_ms INTEGER,
  finish_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS model_calls_scope_idx
  ON model_calls (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS model_calls_run_idx
  ON model_calls (run_id, created_at DESC);
