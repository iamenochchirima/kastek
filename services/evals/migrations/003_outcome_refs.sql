CREATE TABLE evals.outcome_refs (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  workspace_ref_id uuid NOT NULL REFERENCES evals.workspace_refs(id) ON DELETE CASCADE,
  agent_ref_id uuid NOT NULL REFERENCES evals.agent_refs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('enquiry', 'booking', 'record')),
  product_outcome_id text NOT NULL CHECK (length(product_outcome_id) BETWEEN 1 AND 200),
  product_record_id text CHECK (product_record_id IS NULL OR length(product_record_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('submitted', 'completed', 'unknown')),
  task_id text CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  response_digest text NOT NULL CHECK (response_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sandbox_id, kind, product_outcome_id)
);

CREATE INDEX outcome_refs_sandbox
  ON evals.outcome_refs(sandbox_id, created_at DESC, id DESC);

CREATE INDEX outcome_refs_agent
  ON evals.outcome_refs(agent_ref_id, created_at DESC);
