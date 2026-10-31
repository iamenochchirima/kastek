ALTER TABLE agents_platform.delegations
  ADD COLUMN prior_task_id uuid REFERENCES agents_platform.tasks(id);

CREATE TABLE agents_platform.orchestration_progress (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents_platform.orchestration_instructions (
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  request_key text NOT NULL,
  instruction text NOT NULL,
  sequence bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,request_key)
);

CREATE TABLE agents_platform.orchestration_progress_updates (
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  operation_id text NOT NULL,
  request_digest text NOT NULL,
  output jsonb NOT NULL,
  PRIMARY KEY(task_id,operation_id)
);
