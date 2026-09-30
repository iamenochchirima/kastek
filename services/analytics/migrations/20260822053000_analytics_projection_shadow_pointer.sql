-- A-10 correction: keep the active reporting pointer separate from a shadow rebuild.

ALTER TABLE analytics.analytics_projection_checkpoint
    ADD COLUMN IF NOT EXISTS rebuild_generation_id BIGINT
        REFERENCES analytics.analytics_projection_generation(generation_id);

CREATE INDEX IF NOT EXISTS analytics_projection_checkpoint_rebuild_idx
    ON analytics.analytics_projection_checkpoint (rebuild_generation_id)
    WHERE rebuild_generation_id IS NOT NULL;
