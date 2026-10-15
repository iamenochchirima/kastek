-- A-09: retain temporal coverage evidence for completed source-history backfills.
--
-- Projection rebuilds and fact replays do not establish source completeness. Only source
-- reconstruction and approved provider-history imports may create temporal checkpoints here.

ALTER TABLE analytics.analytics_coverage_checkpoint
    ADD COLUMN IF NOT EXISTS backfill_job_id TEXT
    REFERENCES analytics.analytics_backfill_job(job_id);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_coverage_checkpoint_backfill_uidx
    ON analytics.analytics_coverage_checkpoint (backfill_job_id)
    WHERE backfill_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS analytics_coverage_checkpoint_backfill_idx
    ON analytics.analytics_coverage_checkpoint (backfill_job_id)
    WHERE backfill_job_id IS NOT NULL;
