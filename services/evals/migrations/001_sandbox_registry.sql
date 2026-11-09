CREATE TABLE evals.sandboxes (
  id uuid PRIMARY KEY,
  product text NOT NULL CHECK (product IN ('agents', 'growth', 'agency')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evals.sandbox_versions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  code_revision text NOT NULL CHECK (length(code_revision) BETWEEN 1 AND 200),
  image_digest text NOT NULL CHECK (length(image_digest) BETWEEN 1 AND 200),
  schema_version text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 120),
  migration_checksum text NOT NULL CHECK (migration_checksum ~ '^[a-f0-9]{64}$'),
  config_digest text NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  runtime_version text NOT NULL CHECK (length(runtime_version) BETWEEN 1 AND 120),
  model_routes_digest text NOT NULL CHECK (model_routes_digest ~ '^[a-f0-9]{64}$'),
  adapter_versions jsonb NOT NULL CHECK (jsonb_typeof(adapter_versions) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE UNIQUE INDEX sandbox_versions_one_active
  ON evals.sandbox_versions(sandbox_id)
  WHERE retired_at IS NULL;
CREATE INDEX sandbox_versions_sandbox
  ON evals.sandbox_versions(sandbox_id, created_at DESC);

CREATE TABLE evals.workspace_refs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  product_workspace_id text NOT NULL CHECK (length(product_workspace_id) BETWEEN 1 AND 200),
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sandbox_id, product_workspace_id)
);

CREATE INDEX workspace_refs_sandbox
  ON evals.workspace_refs(sandbox_id, created_at);
