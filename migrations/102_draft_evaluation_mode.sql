ALTER TABLE evaluation_runs
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'observed'
    CHECK (execution_mode IN ('observed', 'draft'));

ALTER TABLE evaluation_runs
  ADD CONSTRAINT evaluation_runs_draft_no_live_run
  CHECK (execution_mode <> 'draft' OR run_id IS NULL);

CREATE INDEX IF NOT EXISTS evaluation_runs_draft_scope_idx
  ON evaluation_runs (organization_id, execution_mode, started_at DESC);
