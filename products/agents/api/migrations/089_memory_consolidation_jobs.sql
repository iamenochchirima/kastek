CREATE TABLE IF NOT EXISTS memory_consolidation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  trigger_run_id UUID NOT NULL REFERENCES agent_runs(id),
  extraction_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  source_message_count INTEGER NOT NULL DEFAULT 0 CHECK (source_message_count >= 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (trigger_run_id, extraction_version)
);

CREATE INDEX IF NOT EXISTS memory_consolidation_jobs_due_idx
  ON memory_consolidation_jobs (status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS memory_consolidation_jobs_scope_idx
  ON memory_consolidation_jobs (organization_id, agent_definition_id, installation_id, conversation_id, created_at DESC);

CREATE OR REPLACE FUNCTION kasitek_enqueue_memory_consolidation_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction <> 'inbound' OR NEW.run_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO memory_consolidation_jobs (
    organization_id,
    agent_definition_id,
    agent_version_id,
    installation_id,
    conversation_id,
    trigger_run_id,
    extraction_version
  )
  SELECT
    ar.organization_id,
    ar.agent_definition_id,
    ar.agent_version_id,
    ar.installation_id,
    ar.conversation_id,
    ar.id,
    'deterministic-v1'
  FROM agent_runs ar
  WHERE ar.id = NEW.run_id
    AND ar.organization_id = NEW.organization_id
    AND ar.conversation_id = NEW.conversation_id
  ON CONFLICT (trigger_run_id, extraction_version) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_memory_consolidation_enqueue_trigger ON messages;
CREATE TRIGGER messages_memory_consolidation_enqueue_trigger
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION kasitek_enqueue_memory_consolidation_job();
