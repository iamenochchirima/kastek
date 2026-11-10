CREATE TABLE evals.agent_profiles (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  workspace_ref_id uuid NOT NULL REFERENCES evals.workspace_refs(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  target_type text NOT NULL CHECK (target_type IN ('platform_assistant', 'business_agent')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sandbox_id, workspace_ref_id, name)
);

CREATE INDEX agent_profiles_sandbox
  ON evals.agent_profiles(sandbox_id, created_at DESC);

CREATE TABLE evals.agent_profile_versions (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES evals.agent_profiles(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  spec_digest text NOT NULL CHECK (spec_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, version)
);

CREATE INDEX agent_profile_versions_profile
  ON evals.agent_profile_versions(profile_id, version DESC);

CREATE TABLE evals.agent_setup_runs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  profile_version_id uuid NOT NULL REFERENCES evals.agent_profile_versions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_version_id, idempotency_key)
);

CREATE INDEX agent_setup_runs_sandbox
  ON evals.agent_setup_runs(sandbox_id, created_at DESC);

CREATE TABLE evals.sandbox_updates (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  previous_version_id uuid REFERENCES evals.sandbox_versions(id) ON DELETE SET NULL,
  target_code_revision text NOT NULL CHECK (length(target_code_revision) BETWEEN 1 AND 200),
  target_schema_version text NOT NULL CHECK (length(target_schema_version) BETWEEN 1 AND 120),
  target_migration_checksum text NOT NULL CHECK (target_migration_checksum ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sandbox_updates_sandbox
  ON evals.sandbox_updates(sandbox_id, created_at DESC);
