CREATE TABLE evals.sandbox_pairs (
  id uuid PRIMARY KEY,
  growth_sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  agents_sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (growth_sandbox_id),
  UNIQUE (agents_sandbox_id),
  CHECK (growth_sandbox_id <> agents_sandbox_id)
);

CREATE INDEX sandbox_pairs_agents
  ON evals.sandbox_pairs(agents_sandbox_id);
