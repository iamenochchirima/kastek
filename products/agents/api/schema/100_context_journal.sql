CREATE TABLE agents_platform.context_compaction_jobs (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.conversations(id),
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  mode text NOT NULL DEFAULT 'foreground' CHECK(mode IN ('foreground','background')),
  snapshot_id text REFERENCES agents_platform.context_snapshots(id),
  previous_summary text,
  base_revision bigint NOT NULL CHECK(base_revision>=0),
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  source_groups jsonb NOT NULL CHECK(jsonb_typeof(source_groups)='array'),
  covered_history_ids uuid[] NOT NULL DEFAULT '{}',
  source_manifest jsonb,
  memory_scope_id uuid,
  memory_generation bigint,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','adopted','superseded','rejected','failed','uncertain')),
  error_code text,
  candidate_digest text,
  candidate text,
  checkpoint_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE TABLE agents_platform.context_continuity_checkpoints (
  id text PRIMARY KEY REFERENCES agents_platform.context_compaction_jobs(id),
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.conversations(id),
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  revision bigint NOT NULL CHECK(revision>0),
  summary text NOT NULL,
  summary_digest text NOT NULL CHECK(summary_digest ~ '^[a-f0-9]{64}$'),
  covered_history_ids uuid[] NOT NULL DEFAULT '{}',
  source_manifest jsonb,
  memory_scope_id uuid,
  memory_generation bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,revision)
);
CREATE TRIGGER immutable_context_continuity_checkpoint BEFORE UPDATE OR DELETE
  ON agents_platform.context_continuity_checkpoints
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

CREATE TABLE agents_platform.context_continuity_heads (
  conversation_id uuid PRIMARY KEY REFERENCES agents_platform.conversations(id),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  checkpoint_id text REFERENCES agents_platform.context_continuity_checkpoints(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agents_platform.private_model_continuations ADD COLUMN response_guard jsonb;

CREATE TABLE agents_platform.model_request_manifests (
  operation_id text PRIMARY KEY REFERENCES agents_platform.operations(id),
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  snapshot_id text REFERENCES agents_platform.context_snapshots(id),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_model_request_manifest BEFORE UPDATE OR DELETE
  ON agents_platform.model_request_manifests
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

CREATE INDEX context_compaction_branch_jobs ON agents_platform.context_compaction_jobs(conversation_id,created_at);
CREATE UNIQUE INDEX context_compaction_one_background ON agents_platform.context_compaction_jobs(conversation_id)
  WHERE mode='background' AND state='prepared';

CREATE FUNCTION agents_platform.protect_context_compaction_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'prepared' OR NEW.state='prepared' OR
    NEW.id IS DISTINCT FROM OLD.id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR
    NEW.mode IS DISTINCT FROM OLD.mode OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.previous_summary IS DISTINCT FROM OLD.previous_summary OR
    NEW.base_revision IS DISTINCT FROM OLD.base_revision OR NEW.input_digest IS DISTINCT FROM OLD.input_digest OR
    NEW.source_groups IS DISTINCT FROM OLD.source_groups OR NEW.covered_history_ids IS DISTINCT FROM OLD.covered_history_ids OR
    NEW.source_manifest IS DISTINCT FROM OLD.source_manifest OR NEW.memory_scope_id IS DISTINCT FROM OLD.memory_scope_id OR
    NEW.memory_generation IS DISTINCT FROM OLD.memory_generation THEN
    RAISE EXCEPTION 'Compaction identity, frozen prefix and terminal state are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_context_compaction_job BEFORE UPDATE ON agents_platform.context_compaction_jobs
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_context_compaction_job();
