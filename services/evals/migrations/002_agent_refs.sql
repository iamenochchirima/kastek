CREATE TABLE evals.agent_refs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  workspace_ref_id uuid NOT NULL REFERENCES evals.workspace_refs(id) ON DELETE CASCADE,
  product_agent_id text NOT NULL CHECK (length(product_agent_id) BETWEEN 1 AND 200),
  product_version_id text NOT NULL CHECK (length(product_version_id) BETWEEN 1 AND 200),
  source_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_ids) = 'array'),
  composition_digest text NOT NULL CHECK (composition_digest ~ '^[a-f0-9]{64}$'),
  model_routes_digest text NOT NULL CHECK (model_routes_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sandbox_id, product_agent_id, product_version_id)
);

CREATE INDEX agent_refs_sandbox
  ON evals.agent_refs(sandbox_id, created_at DESC, id DESC);

CREATE INDEX agent_refs_workspace
  ON evals.agent_refs(workspace_ref_id, created_at DESC);
