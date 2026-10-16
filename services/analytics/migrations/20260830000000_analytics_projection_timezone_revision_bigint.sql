-- Projection timezone revisions mirror reporting_scope.source_version, which is BIGINT.
-- Existing production scope versions can be millisecond timestamps and exceed INTEGER.

ALTER TABLE analytics.analytics_projection_contribution
    ALTER COLUMN timezone_revision TYPE BIGINT
    USING timezone_revision::BIGINT;

ALTER TABLE analytics.analytics_projection_rollup
    ALTER COLUMN timezone_revision TYPE BIGINT
    USING timezone_revision::BIGINT;
