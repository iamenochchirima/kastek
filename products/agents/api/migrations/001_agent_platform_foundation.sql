CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agent_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'organization' CHECK (owner_type IN ('organization', 'system')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  protected BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  instructions TEXT NOT NULL,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  checksum TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  UNIQUE (agent_definition_id, version_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_published_agent_version
  ON agent_versions (agent_definition_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS agent_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  organization_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'user', 'business')),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_installations_scope_idx
  ON agent_installations (organization_id, scope_type, scope_id, status);

CREATE TABLE IF NOT EXISTS agent_principals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL UNIQUE REFERENCES agent_installations(id),
  organization_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'kasitek-core',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  organization_id TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'platform',
  channel_key TEXT NOT NULL DEFAULT 'platform',
  external_conversation_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_identity_idx
  ON conversations (installation_id, channel_type, channel_key, external_conversation_id)
  WHERE external_conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  organization_id TEXT NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('user', 'customer', 'staff', 'agent', 'system')),
  external_id TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, participant_type, external_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  organization_id TEXT NOT NULL,
  participant_id UUID REFERENCES participants(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
  message_type TEXT NOT NULL DEFAULT 'text',
  content JSONB NOT NULL,
  provider TEXT,
  provider_message_id TEXT,
  sequence_number BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_identity_idx
  ON messages (provider, provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID REFERENCES conversations(id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('message', 'schedule', 'webhook', 'manual')),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
    'received', 'queued', 'running', 'awaiting_approval', 'awaiting_human',
    'awaiting_external_event', 'completed', 'failed', 'cancelled', 'expired'
  )),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error JSONB,
  correlation_id UUID NOT NULL,
  causation_id UUID,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_scope_status_idx
  ON agent_runs (organization_id, installation_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  organization_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  step_type TEXT NOT NULL CHECK (step_type IN ('context', 'retrieval', 'model', 'policy', 'approval', 'tool', 'delivery', 'system')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'skipped')),
  input JSONB,
  output JSONB,
  error JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (run_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  run_id UUID REFERENCES agent_runs(id),
  installation_id UUID REFERENCES agent_installations(id),
  event_type TEXT NOT NULL,
  sequence_number BIGSERIAL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_events_run_idx ON agent_events (run_id, sequence_number);
CREATE INDEX IF NOT EXISTS agent_events_org_idx ON agent_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  correlation_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_records_resource_idx
  ON audit_records (resource_type, resource_id, created_at DESC);
