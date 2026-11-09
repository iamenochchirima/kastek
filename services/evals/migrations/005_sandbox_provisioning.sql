ALTER TABLE evals.sandboxes
  DROP CONSTRAINT IF EXISTS sandboxes_status_check;

ALTER TABLE evals.sandboxes
  ADD CONSTRAINT sandboxes_status_check
  CHECK (status IN ('provisioning', 'ready', 'failed', 'active', 'retired'));

ALTER TABLE evals.sandboxes
  ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS provisioning_error text,
  ADD COLUMN IF NOT EXISTS provisioning_steps jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(provisioning_steps) = 'array'),
  ADD COLUMN IF NOT EXISTS provisioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS runtime jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(runtime) = 'object');
