-- Preserve graph executor counters across activity retries. The existing JSON
-- state remains the product state; these columns keep execution bookkeeping
-- separate so retries cannot reset graph limits or iteration accounting.
ALTER TABLE run_workflow_checkpoints
  ADD COLUMN IF NOT EXISTS edge_iterations JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS node_iterations JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0);
