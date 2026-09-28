-- Persist the last bounded reachability result for reviewed remote MCP providers.
-- Health is an invocation gate, not an approval decision: a human still has to
-- publish a discovered revision before an agent version can pin it.
ALTER TABLE agent_mcp_providers
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS health_last_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS health_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS health_failure_code TEXT,
  ADD COLUMN IF NOT EXISTS health_consecutive_failures INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_mcp_providers_health_status_check'
      AND conrelid = 'agent_mcp_providers'::regclass
  ) THEN
    ALTER TABLE agent_mcp_providers
      ADD CONSTRAINT agent_mcp_providers_health_status_check
      CHECK (health_status IN ('unknown', 'healthy', 'unhealthy'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_mcp_providers_health_latency_check'
      AND conrelid = 'agent_mcp_providers'::regclass
  ) THEN
    ALTER TABLE agent_mcp_providers
      ADD CONSTRAINT agent_mcp_providers_health_latency_check
      CHECK (health_latency_ms IS NULL OR health_latency_ms BETWEEN 0 AND 120000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_mcp_providers_health_failures_check'
      AND conrelid = 'agent_mcp_providers'::regclass
  ) THEN
    ALTER TABLE agent_mcp_providers
      ADD CONSTRAINT agent_mcp_providers_health_failures_check
      CHECK (health_consecutive_failures >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_mcp_providers_health_idx
  ON agent_mcp_providers (organization_id, health_status, health_checked_at DESC);
