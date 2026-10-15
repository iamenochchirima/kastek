-- A-09: retain reconciliation evidence as a first-class coverage checkpoint.
--
-- A checkpoint may be linked to either source-manifest evidence or a reconciliation run. The
-- reconciliation link makes retries and reporting provenance explicit without overloading a
-- dimension key with an operational identifier.

ALTER TABLE analytics.analytics_coverage_checkpoint
    ADD COLUMN IF NOT EXISTS reconciliation_run_id TEXT
    REFERENCES analytics.analytics_reconciliation_run(reconciliation_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_coverage_checkpoint_reconciliation_uidx
    ON analytics.analytics_coverage_checkpoint (reconciliation_run_id)
    WHERE reconciliation_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS analytics_coverage_checkpoint_reconciliation_idx
    ON analytics.analytics_coverage_checkpoint (reconciliation_run_id)
    WHERE reconciliation_run_id IS NOT NULL;
