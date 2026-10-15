-- Memory architecture v2: durable source evidence and pre-compaction checkpoints.
-- This is intentionally separate from the legacy memory_records table. The
-- source envelope is lossless with respect to its redacted evidence boundary;
-- summaries and future revisions are projections of it.

CREATE TABLE IF NOT EXISTS memory_source_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  agent_version_id UUID REFERENCES agent_versions(id),
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID REFERENCES conversations(id),
  end_user_id TEXT,
  run_id UUID REFERENCES agent_runs(id),
  turn_id TEXT,
  source_boundary TEXT NOT NULL,
  external_event_ids TEXT[] NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL,
  evidence_digest TEXT NOT NULL,
  redaction TEXT NOT NULL CHECK (redaction IN ('content_present', 'content_redacted')),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, evidence_digest, source_boundary)
);

CREATE INDEX IF NOT EXISTS memory_source_events_scope_idx
  ON memory_source_events (organization_id, workspace_id, installation_id, agent_definition_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memory_source_events_run_idx
  ON memory_source_events (organization_id, run_id, turn_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS memory_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  agent_version_id UUID REFERENCES agent_versions(id),
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID REFERENCES conversations(id),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  turn_id TEXT NOT NULL,
  compaction_generation INTEGER NOT NULL CHECK (compaction_generation >= 0),
  source_boundary TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_event_id UUID NOT NULL REFERENCES memory_source_events(id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'committed', 'blocked', 'failed')),
  error_code TEXT,
  error_digest TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS memory_checkpoints_run_idx
  ON memory_checkpoints (organization_id, run_id, turn_id, compaction_generation DESC);
CREATE INDEX IF NOT EXISTS memory_checkpoints_status_idx
  ON memory_checkpoints (organization_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION kasitek_memory_checkpoint_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_checkpoints_updated_at_trigger ON memory_checkpoints;
CREATE TRIGGER memory_checkpoints_updated_at_trigger
BEFORE UPDATE ON memory_checkpoints
FOR EACH ROW EXECUTE FUNCTION kasitek_memory_checkpoint_touch_updated_at();

DROP POLICY IF EXISTS memory_source_events_agents_scope ON memory_source_events;
CREATE POLICY memory_source_events_agents_scope ON memory_source_events
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR organization_id = current_setting('kasitek.organization_id', true)
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR organization_id = current_setting('kasitek.organization_id', true)
  );
ALTER TABLE memory_source_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_source_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_checkpoints_agents_scope ON memory_checkpoints;
CREATE POLICY memory_checkpoints_agents_scope ON memory_checkpoints
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR organization_id = current_setting('kasitek.organization_id', true)
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR organization_id = current_setting('kasitek.organization_id', true)
  );
ALTER TABLE memory_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_checkpoints FORCE ROW LEVEL SECURITY;
