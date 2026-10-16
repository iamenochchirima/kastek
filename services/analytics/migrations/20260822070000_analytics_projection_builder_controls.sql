-- A-10: typed builder metadata, exact deduplication keys, and reconciliation repair reasons.
--
-- These fields remain disposable projection metadata. Immutable source facts and source identity
-- stay in the ingestion tables; a rebuild can always recreate this derived state.

ALTER TABLE analytics.analytics_projection_work
    ADD COLUMN IF NOT EXISTS repair_reason TEXT
        CHECK (repair_reason IS NULL OR repair_reason IN ('late_fact', 'reconciliation_mismatch', 'manual'));

ALTER TABLE analytics.analytics_projection_contribution
    DROP CONSTRAINT IF EXISTS analytics_projection_contribution_check2;

ALTER TABLE analytics.analytics_projection_rollup
    DROP CONSTRAINT IF EXISTS analytics_projection_rollup_check2;

ALTER TABLE analytics.analytics_projection_contribution
    ADD COLUMN IF NOT EXISTS deduplication_key TEXT
        CHECK (deduplication_key IS NULL OR length(trim(deduplication_key)) BETWEEN 1 AND 512),
    ADD COLUMN IF NOT EXISTS builder_name TEXT NOT NULL DEFAULT 'generic'
        CHECK (length(trim(builder_name)) BETWEEN 1 AND 128);

CREATE INDEX IF NOT EXISTS analytics_projection_work_repair_idx
    ON analytics.analytics_projection_work (repair_reason, work_status, available_at)
    WHERE repair_reason IS NOT NULL;

CREATE INDEX IF NOT EXISTS analytics_projection_contribution_dedup_idx
    ON analytics.analytics_projection_contribution (
        generation_id, metric_key, target_scope_id, bucket_start, deduplication_key
    )
    WHERE deduplication_key IS NOT NULL;

COMMENT ON COLUMN analytics.analytics_projection_work.repair_reason IS
    'Safe reason for a derived-window requeue; never a source payload or operator-edited fact';
COMMENT ON COLUMN analytics.analytics_projection_contribution.deduplication_key IS
    'Typed domain identity used for exact distinct aggregation within a reporting bucket';
COMMENT ON COLUMN analytics.analytics_projection_contribution.builder_name IS
    'Versioned domain builder family that produced this contribution';
