-- A-10: durable projection work, generation-scoped contributions, and rollups.
--
-- Immutable facts remain the replay source. Everything in this migration is disposable derived
-- state: work can be retried, rows can be rebuilt into a shadow generation, and the checkpoint's
-- generation pointer remains the reporting hand-off boundary.

ALTER TABLE analytics.analytics_projection_checkpoint
    ADD COLUMN IF NOT EXISTS last_processed_work_id BIGINT NOT NULL DEFAULT 0
        CHECK (last_processed_work_id >= 0);

CREATE TABLE IF NOT EXISTS analytics.analytics_projection_work (
    work_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    projection_name TEXT NOT NULL CHECK (length(trim(projection_name)) BETWEEN 1 AND 256),
    projection_version TEXT NOT NULL CHECK (length(trim(projection_version)) BETWEEN 1 AND 128),
    fact_kind TEXT NOT NULL CHECK (fact_kind IN ('event', 'observation')),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    source_window_start TIMESTAMPTZ NOT NULL,
    source_window_end TIMESTAMPTZ NOT NULL,
    min_source_storage_id BIGINT NOT NULL CHECK (min_source_storage_id > 0),
    max_source_storage_id BIGINT NOT NULL CHECK (max_source_storage_id >= min_source_storage_id),
    generation_id BIGINT REFERENCES analytics.analytics_projection_generation(generation_id),
    priority SMALLINT NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
    work_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (work_status IN ('pending', 'leased', 'completed', 'failed', 'cancelled')),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 256),
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(trim(last_error_code)) BETWEEN 1 AND 128),
    last_error_message TEXT CHECK (last_error_message IS NULL OR length(trim(last_error_message)) <= 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (
        projection_name,
        projection_version,
        fact_kind,
        reporting_scope_id,
        source_window_start,
        source_window_end,
        generation_id
    ),
    CHECK (source_window_end > source_window_start),
    CHECK ((work_status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (completed_at IS NULL OR work_status = 'completed')
);

CREATE INDEX IF NOT EXISTS analytics_projection_work_claim_idx
    ON analytics.analytics_projection_work (work_status, available_at, priority, work_id);
CREATE INDEX IF NOT EXISTS analytics_projection_work_lease_idx
    ON analytics.analytics_projection_work (lease_expires_at, work_status);
CREATE INDEX IF NOT EXISTS analytics_projection_work_scope_idx
    ON analytics.analytics_projection_work (
        reporting_scope_id,
        projection_name,
        projection_version,
        source_window_start
    );
CREATE UNIQUE INDEX IF NOT EXISTS analytics_projection_work_unassigned_window_uidx
    ON analytics.analytics_projection_work (
        projection_name,
        projection_version,
        fact_kind,
        reporting_scope_id,
        source_window_start,
        source_window_end
    )
    WHERE generation_id IS NULL;

CREATE TRIGGER analytics_projection_work_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_projection_work
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_projection_work_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_projection_work
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_projection_contribution (
    contribution_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generation_id BIGINT NOT NULL REFERENCES analytics.analytics_projection_generation(generation_id),
    projection_name TEXT NOT NULL CHECK (length(trim(projection_name)) BETWEEN 1 AND 256),
    projection_version TEXT NOT NULL CHECK (length(trim(projection_version)) BETWEEN 1 AND 128),
    metric_key TEXT NOT NULL CHECK (metric_key ~ '^[a-z][a-z0-9_.-]+$'),
    metric_version INTEGER NOT NULL CHECK (metric_version > 0),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('event', 'observation')),
    source_storage_id BIGINT NOT NULL CHECK (source_storage_id > 0),
    target_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    source_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    bucket_start TIMESTAMPTZ NOT NULL,
    bucket_end TIMESTAMPTZ NOT NULL,
    timezone_name TEXT NOT NULL DEFAULT 'UTC' CHECK (length(trim(timezone_name)) BETWEEN 1 AND 128),
    timezone_revision INTEGER NOT NULL DEFAULT 1 CHECK (timezone_revision > 0),
    dimensions JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(dimensions) = 'object'),
    value_count NUMERIC NOT NULL DEFAULT 0,
    value_sum NUMERIC NOT NULL DEFAULT 0,
    value_min NUMERIC,
    value_max NUMERIC,
    numerator NUMERIC,
    denominator NUMERIC,
    source_high_watermark BIGINT NOT NULL CHECK (source_high_watermark > 0),
    coverage JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(coverage) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (
        generation_id,
        source_kind,
        source_storage_id,
        metric_key,
        metric_version,
        target_scope_id,
        bucket_start,
        bucket_end,
        dimensions
    ),
    CHECK (bucket_end > bucket_start),
    CHECK (value_min IS NULL OR value_min <= value_max),
    CHECK (numerator IS NULL OR denominator IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS analytics_projection_contribution_scope_bucket_idx
    ON analytics.analytics_projection_contribution (
        target_scope_id,
        metric_key,
        bucket_start,
        bucket_end,
        generation_id
    );
CREATE INDEX IF NOT EXISTS analytics_projection_contribution_source_idx
    ON analytics.analytics_projection_contribution (source_scope_id, source_kind, source_storage_id);

CREATE TRIGGER analytics_projection_contribution_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_projection_contribution
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_projection_contribution_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_projection_contribution
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_projection_rollup (
    rollup_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generation_id BIGINT NOT NULL REFERENCES analytics.analytics_projection_generation(generation_id),
    projection_name TEXT NOT NULL CHECK (length(trim(projection_name)) BETWEEN 1 AND 256),
    projection_version TEXT NOT NULL CHECK (length(trim(projection_version)) BETWEEN 1 AND 128),
    metric_key TEXT NOT NULL CHECK (metric_key ~ '^[a-z][a-z0-9_.-]+$'),
    metric_version INTEGER NOT NULL CHECK (metric_version > 0),
    target_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    source_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    interval TEXT NOT NULL CHECK (interval IN ('hour', 'day', 'month')),
    bucket_start TIMESTAMPTZ NOT NULL,
    bucket_end TIMESTAMPTZ NOT NULL,
    timezone_name TEXT NOT NULL DEFAULT 'UTC' CHECK (length(trim(timezone_name)) BETWEEN 1 AND 128),
    timezone_revision INTEGER NOT NULL DEFAULT 1 CHECK (timezone_revision > 0),
    dimensions JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(dimensions) = 'object'),
    value_count NUMERIC NOT NULL DEFAULT 0,
    value_sum NUMERIC NOT NULL DEFAULT 0,
    value_min NUMERIC,
    value_max NUMERIC,
    numerator NUMERIC,
    denominator NUMERIC,
    source_high_watermark BIGINT NOT NULL CHECK (source_high_watermark >= 0),
    coverage JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(coverage) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (
        generation_id,
        metric_key,
        metric_version,
        target_scope_id,
        source_scope_id,
        interval,
        bucket_start,
        bucket_end,
        dimensions
    ),
    CHECK (bucket_end > bucket_start),
    CHECK (value_min IS NULL OR value_min <= value_max),
    CHECK (numerator IS NULL OR denominator IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS analytics_projection_rollup_scope_bucket_idx
    ON analytics.analytics_projection_rollup (
        target_scope_id,
        metric_key,
        interval,
        bucket_start,
        generation_id
    );
CREATE INDEX IF NOT EXISTS analytics_projection_rollup_source_idx
    ON analytics.analytics_projection_rollup (source_scope_id, metric_key, bucket_start, generation_id);

CREATE TRIGGER analytics_projection_rollup_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_projection_rollup
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

ALTER TABLE analytics.analytics_projection_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_projection_contribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_projection_rollup ENABLE ROW LEVEL SECURITY;

CREATE POLICY analytics_projection_work_authorized_read
ON analytics.analytics_projection_work FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_projection_contribution_authorized_read
ON analytics.analytics_projection_contribution FOR SELECT
USING (analytics.scope_is_authorized(target_scope_id));

CREATE POLICY analytics_projection_rollup_authorized_read
ON analytics.analytics_projection_rollup FOR SELECT
USING (analytics.scope_is_authorized(target_scope_id));

COMMENT ON TABLE analytics.analytics_projection_work IS
    'Coalesced, leased dirty windows for deterministic analytics projection processing';
COMMENT ON TABLE analytics.analytics_projection_contribution IS
    'Generation-scoped narrowest-scope mergeable source contributions; safe to rebuild';
COMMENT ON TABLE analytics.analytics_projection_rollup IS
    'Generation-scoped aggregate buckets derived from contributions; never the source of truth';
