-- One durable identity and recovery boundary for provider operations.
-- Payloads are bounded receipts/evidence, not prompts, credentials, or raw tool output.
CREATE TABLE IF NOT EXISTS agent_durable_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID REFERENCES agent_installations(id) ON DELETE CASCADE,
  run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
  session_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'native_tool', 'mcp', 'plugin', 'child', 'approval', 'delivery', 'context', 'session')),
  operation_key TEXT NOT NULL CHECK (length(btrim(operation_key)) BETWEEN 1 AND 240),
  request_fingerprint TEXT NOT NULL CHECK (length(btrim(request_fingerprint)) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'running', 'completed', 'failed', 'interrupted', 'unknown')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  provider_request_id TEXT,
  response_receipt JSONB,
  error JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (organization_id, operation_key)
);

CREATE INDEX IF NOT EXISTS agent_durable_operations_run_idx
  ON agent_durable_operations (organization_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS agent_durable_operations_reconciliation_idx
  ON agent_durable_operations (organization_id, status, updated_at);

GRANT SELECT, INSERT, UPDATE ON agent_durable_operations TO kasitek_agents_runtime;

ALTER TABLE agent_durable_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_durable_operations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_durable_operations_agents_scope ON agent_durable_operations;
CREATE POLICY agent_durable_operations_agents_scope ON agent_durable_operations
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR kasitek_agents_current_org_scope(organization_id)
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR kasitek_agents_current_org_scope(organization_id)
  );
