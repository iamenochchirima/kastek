-- A-10 correction: retain the previous promoted generation as a superseded rollback candidate.

ALTER TABLE analytics.analytics_projection_generation
    DROP CONSTRAINT IF EXISTS analytics_projection_generation_generation_status_check,
    DROP CONSTRAINT IF EXISTS analytics_projection_generation_check,
    DROP CONSTRAINT IF EXISTS analytics_projection_generation_check1;

ALTER TABLE analytics.analytics_projection_generation
    ADD CONSTRAINT analytics_projection_generation_generation_status_check
        CHECK (generation_status IN ('building', 'validated', 'promoted', 'superseded', 'failed', 'cancelled')),
    ADD CONSTRAINT analytics_projection_generation_check
        CHECK (promoted_at IS NULL OR generation_status IN ('promoted', 'superseded')),
    ADD CONSTRAINT analytics_projection_generation_check1
        CHECK (validated_at IS NULL OR generation_status IN ('validated', 'promoted', 'superseded'));
