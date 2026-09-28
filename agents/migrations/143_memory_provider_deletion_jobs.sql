-- Provider deletion is a separate durable phase.  Canonical rows may be
-- purged immediately, but provider record identifiers must survive long
-- enough for an adapter to acknowledge the remote delete.
ALTER TABLE memory_deletion_jobs
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_status_check;

ALTER TABLE memory_deletion_jobs
  ADD CONSTRAINT memory_deletion_jobs_status_check
  CHECK (status IN ('queued', 'running', 'held', 'provider_pending', 'completed', 'failed'));

ALTER TABLE memory_deletion_jobs
  ADD COLUMN IF NOT EXISTS provider_deletion_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_confirmed_at TIMESTAMPTZ;

ALTER TABLE memory_deletion_jobs
  DROP CONSTRAINT IF EXISTS memory_deletion_jobs_provider_deletion_count_check;

ALTER TABLE memory_deletion_jobs
  ADD CONSTRAINT memory_deletion_jobs_provider_deletion_count_check CHECK (provider_deletion_count >= 0);

CREATE TABLE IF NOT EXISTS agent_memory_provider_deletion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deletion_job_id UUID REFERENCES memory_deletion_jobs(id) ON DELETE SET NULL,
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  provider_name TEXT NOT NULL CHECK (length(trim(provider_name)) BETWEEN 1 AND 160),
  provider_record_id TEXT NOT NULL CHECK (length(trim(provider_record_id)) BETWEEN 1 AND 512),
  content_digest TEXT NOT NULL CHECK (length(trim(content_digest)) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 240),
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,119}$'),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_name, provider_record_id, content_digest),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR status IN ('completed', 'dead_letter'))
);

CREATE INDEX IF NOT EXISTS agent_memory_provider_deletion_jobs_due_idx
  ON agent_memory_provider_deletion_jobs (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS agent_memory_provider_deletion_jobs_scope_idx
  ON agent_memory_provider_deletion_jobs (organization_id, workspace_id, installation_id, provider_name, status, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_provider_deletion_jobs_parent_idx
  ON agent_memory_provider_deletion_jobs (deletion_job_id, status);

CREATE OR REPLACE FUNCTION kasitek_touch_memory_provider_deletion_job_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kasitek_validate_memory_provider_deletion_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected RECORD;
BEGIN
  SELECT installation.organization_id, installation.scope_id
  INTO expected
  FROM agent_installations installation
  WHERE installation.id = NEW.installation_id;
  IF NOT FOUND
    OR expected.organization_id <> NEW.organization_id
    OR expected.scope_id <> NEW.workspace_id
  THEN
    RAISE EXCEPTION 'Memory provider deletion is outside installation scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_provider_deletion_jobs_scope_trigger ON agent_memory_provider_deletion_jobs;
CREATE TRIGGER agent_memory_provider_deletion_jobs_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, installation_id
ON agent_memory_provider_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_provider_deletion_scope();

DROP TRIGGER IF EXISTS agent_memory_provider_deletion_jobs_updated_at_trigger ON agent_memory_provider_deletion_jobs;
CREATE TRIGGER agent_memory_provider_deletion_jobs_updated_at_trigger
BEFORE UPDATE ON agent_memory_provider_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION kasitek_touch_memory_provider_deletion_job_updated_at();

ALTER TABLE agent_memory_provider_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_provider_deletion_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_memory_provider_deletion_jobs_agents_scope ON agent_memory_provider_deletion_jobs;
CREATE POLICY agent_memory_provider_deletion_jobs_agents_scope
  ON agent_memory_provider_deletion_jobs
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id));
