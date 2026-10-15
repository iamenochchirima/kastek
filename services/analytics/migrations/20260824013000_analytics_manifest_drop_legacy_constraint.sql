-- The database may have generated a different truncated name for the original unique
-- constraint. Keep the cleanup explicit for databases created from the original migration.

ALTER TABLE analytics.analytics_source_manifest
    DROP CONSTRAINT IF EXISTS analytics_source_manifest_producer_id_manifest_key_manifest_key;
