-- Memory v2 quality and retention domain.
--
-- Retention is evaluated against canonical revisions. It expires a revision by
-- appending an immutable expiration revision; physical deletion remains the
-- separate, legal-hold-aware deletion workflow. Quality events contain only
-- redacted identifiers and bounded numeric feedback, never memory content.

CREATE TABLE IF NOT EXISTS agent_memory_retention_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'workspace', 'namespace', 'memory_type', 'record')),
  scope_id TEXT NOT NULL CHECK (length(trim(scope_id)) BETWEEN 1 AND 240),
  namespace TEXT CHECK (namespace IS NULL OR namespace IN ('conversation', 'end_user_private', 'workspace_shared', 'agent_private', 'procedural', 'knowledge')),
  memory_type TEXT CHECK (memory_type IS NULL OR memory_type IN ('semantic', 'episodic')),
  fact_id UUID REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  revalidate_after_days INTEGER NOT NULL CHECK (revalidate_after_days BETWEEN 1 AND 3650),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (scope_type = 'organization' AND scope_id = organization_id AND namespace IS NULL AND memory_type IS NULL AND fact_id IS NULL)
    OR (scope_type = 'workspace' AND namespace IS NULL AND memory_type IS NULL AND fact_id IS NULL)
    OR (scope_type = 'namespace' AND namespace IS NOT NULL AND memory_type IS NULL AND fact_id IS NULL)
    OR (scope_type = 'memory_type' AND namespace IS NULL AND memory_type IS NOT NULL AND fact_id IS NULL)
    OR (scope_type = 'record' AND fact_id IS NOT NULL AND namespace IS NULL AND memory_type IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_retention_rules_scope_idx
  ON agent_memory_retention_rules (organization_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS agent_memory_retention_rules_fact_idx
  ON agent_memory_retention_rules (organization_id, fact_id, active);

CREATE TABLE IF NOT EXISTS agent_memory_quality_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  end_user_id TEXT,
  fact_id UUID REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  revision_id UUID REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('usage', 'confirmation', 'correction', 'rejection', 'helpfulness', 'revalidation_requested', 'revalidation_completed')),
  helpfulness SMALLINT CHECK (helpfulness IS NULL OR helpfulness BETWEEN -1 AND 1),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('end_user', 'agent', 'operator', 'system')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 240),
  source_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  source_digest TEXT NOT NULL CHECK (length(trim(source_digest)) BETWEEN 1 AND 128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (fact_id IS NOT NULL OR revision_id IS NOT NULL),
  CHECK ((event_type = 'helpfulness' AND helpfulness IS NOT NULL) OR event_type <> 'helpfulness')
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_quality_events_idempotency_idx
  ON agent_memory_quality_events (organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS agent_memory_quality_events_revision_idx
  ON agent_memory_quality_events (organization_id, workspace_id, revision_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_quality_events_fact_idx
  ON agent_memory_quality_events (organization_id, workspace_id, fact_id, event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS agent_memory_revalidation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES agent_memory_facts(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('stale', 'low_confidence', 'conflict', 'policy')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  due_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  outcome TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_revalidation_jobs_idempotency_idx
  ON agent_memory_revalidation_jobs (organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS agent_memory_revalidation_jobs_due_idx
  ON agent_memory_revalidation_jobs (status, due_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS agent_memory_revalidation_jobs_scope_idx
  ON agent_memory_revalidation_jobs (organization_id, workspace_id, fact_id, status);

CREATE TABLE IF NOT EXISTS agent_memory_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  left_revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  right_revision_id UUID NOT NULL REFERENCES agent_memory_revisions(id) ON DELETE CASCADE,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('fact_key', 'entity_overlap', 'validity_overlap', 'explicit_correction')),
  conflict_key TEXT NOT NULL CHECK (length(trim(conflict_key)) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CHECK (left_revision_id <> right_revision_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_conflicts_identity_idx
  ON agent_memory_conflicts (organization_id, conflict_key);
CREATE INDEX IF NOT EXISTS agent_memory_conflicts_open_idx
  ON agent_memory_conflicts (organization_id, workspace_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS agent_memory_conflicts_revision_idx
  ON agent_memory_conflicts (organization_id, left_revision_id, right_revision_id, status);

CREATE TABLE IF NOT EXISTS agent_memory_maintenance_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) BETWEEN 1 AND 240),
  job_type TEXT NOT NULL CHECK (job_type IN ('retention', 'revalidation', 'conflict')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'failed')),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, job_type)
);
