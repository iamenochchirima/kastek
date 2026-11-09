CREATE TABLE evals.interactive_sessions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES evals.sandboxes(id) ON DELETE CASCADE,
  workspace_ref_id uuid NOT NULL REFERENCES evals.workspace_refs(id) ON DELETE CASCADE,
  agent_ref_id uuid NOT NULL REFERENCES evals.agent_refs(id) ON DELETE CASCADE,
  product_conversation_id text NOT NULL CHECK (length(product_conversation_id) BETWEEN 1 AND 200),
  first_task_id text NOT NULL CHECK (length(first_task_id) BETWEEN 1 AND 200),
  latest_task_id text NOT NULL CHECK (length(latest_task_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('active', 'waiting_review', 'completed', 'failed', 'cancelled')),
  turn_count integer NOT NULL DEFAULT 1 CHECK (turn_count > 0),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sandbox_id, product_conversation_id)
);

CREATE INDEX interactive_sessions_sandbox
  ON evals.interactive_sessions(sandbox_id, last_activity_at DESC, id DESC);

CREATE INDEX interactive_sessions_agent
  ON evals.interactive_sessions(agent_ref_id, last_activity_at DESC);

CREATE TABLE evals.interactive_turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES evals.interactive_sessions(id) ON DELETE CASCADE,
  product_task_id text NOT NULL CHECK (length(product_task_id) BETWEEN 1 AND 200),
  sequence integer NOT NULL CHECK (sequence > 0),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  output_digest text CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'waiting_review', 'completed', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, product_task_id),
  UNIQUE (session_id, sequence)
);

CREATE INDEX interactive_turns_session
  ON evals.interactive_turns(session_id, sequence);
