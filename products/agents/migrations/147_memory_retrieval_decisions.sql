-- Durable, content-free retrieval decisions.  The query itself is never
-- persisted: operators get the planner inputs, selected revision IDs, bounded
-- rejection reasons, and timing needed to reproduce a decision without
-- copying sensitive user text into an observability table.
CREATE TABLE IF NOT EXISTS agent_memory_retrieval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  end_user_id TEXT,
  run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  turn_id TEXT NOT NULL CHECK (length(trim(turn_id)) BETWEEN 1 AND 240),
  attempt_id TEXT NOT NULL CHECK (length(trim(attempt_id)) BETWEEN 1 AND 240),
  source_boundary_digest TEXT NOT NULL CHECK (source_boundary_digest ~ '^[0-9a-f]{64}$'),
  query_digest TEXT NOT NULL CHECK (query_digest ~ '^[0-9a-f]{64}$'),
  query_length INTEGER NOT NULL CHECK (query_length >= 0 AND query_length <= 4000),
  planner_version TEXT NOT NULL CHECK (length(trim(planner_version)) BETWEEN 1 AND 120),
  decision TEXT NOT NULL CHECK (decision IN ('not_requested', 'requested', 'required')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 160),
  freshness TEXT NOT NULL CHECK (freshness IN ('current', 'historical', 'any')),
  memory_kinds TEXT[] NOT NULL DEFAULT '{}',
  selected_revision_ids TEXT[] NOT NULL DEFAULT '{}',
  rejected_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rejected_reasons) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('completed', 'blocked', 'failed')),
  measured_tokens INTEGER NOT NULL DEFAULT 0 CHECK (measured_tokens >= 0),
  max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_.-]{0,119}$'),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS agent_memory_retrieval_decisions_scope_idx
  ON agent_memory_retrieval_decisions (organization_id, workspace_id, installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_retrieval_decisions_run_idx
  ON agent_memory_retrieval_decisions (organization_id, run_id, turn_id, created_at DESC);

ALTER TABLE agent_memory_retrieval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_retrieval_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_memory_retrieval_decisions_scope ON agent_memory_retrieval_decisions;
CREATE POLICY agent_memory_retrieval_decisions_scope ON agent_memory_retrieval_decisions
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR organization_id = current_setting('kasitek.organization_id', true))
  WITH CHECK (kasitek_agents_operator_scope() OR organization_id = current_setting('kasitek.organization_id', true));

CREATE OR REPLACE FUNCTION kasitek_validate_memory_retrieval_decision_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  installation RECORD;
  version_exists BOOLEAN;
BEGIN
  SELECT organization_id, agent_definition_id, scope_id
  INTO installation
  FROM agent_installations
  WHERE id = NEW.installation_id;
  IF NOT FOUND OR installation.organization_id <> NEW.organization_id
    OR installation.agent_definition_id <> NEW.agent_definition_id
    OR installation.scope_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Memory retrieval decision is outside the installation scope';
  END IF;
  IF NEW.agent_version_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM agent_versions
      WHERE id = NEW.agent_version_id AND agent_definition_id = NEW.agent_definition_id
    ) INTO version_exists;
    IF NOT version_exists THEN
      RAISE EXCEPTION 'Memory retrieval decision version is outside the agent scope';
    END IF;
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_runs run
    WHERE run.id = NEW.run_id
      AND run.organization_id = NEW.organization_id
      AND run.installation_id = NEW.installation_id
      AND run.agent_definition_id = NEW.agent_definition_id
  ) THEN
    RAISE EXCEPTION 'Memory retrieval decision run is outside the installation scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_retrieval_decisions_scope_trigger ON agent_memory_retrieval_decisions;
CREATE TRIGGER agent_memory_retrieval_decisions_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, agent_definition_id, agent_version_id,
  installation_id, run_id
ON agent_memory_retrieval_decisions
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_retrieval_decision_scope();
