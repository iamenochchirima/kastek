-- Canonical typed execution facts are stored separately from the legacy
-- operator/event projection. A run row lock allocates a monotonic cursor per
-- run in the repository so concurrent activity attempts cannot duplicate it.

CREATE TABLE IF NOT EXISTS agent_execution_journal_events (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  operation_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  sequence_number BIGINT NOT NULL,
  event_kind TEXT NOT NULL,
  event JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, run_id, sequence_number),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS agent_execution_journal_scope_idx
  ON agent_execution_journal_events (organization_id, run_id, sequence_number);

CREATE INDEX IF NOT EXISTS agent_execution_journal_operation_idx
  ON agent_execution_journal_events (organization_id, run_id, operation_id, sequence_number);

-- The runtime now serializes same-session runs in Temporal. The old partial
-- unique index represented the former reject-active-run policy and would make
-- a durable queue impossible.
DROP INDEX IF EXISTS agent_runs_one_active_conversation_uidx;

GRANT SELECT, INSERT ON agent_execution_journal_events TO kasitek_agents_runtime;

ALTER TABLE agent_execution_journal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_execution_journal_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_execution_journal_events_agents_scope ON agent_execution_journal_events;
CREATE POLICY agent_execution_journal_events_agents_scope ON agent_execution_journal_events
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id));
