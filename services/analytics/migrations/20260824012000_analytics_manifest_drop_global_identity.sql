-- PostgreSQL truncates the original generated constraint name at 63 bytes. Remove that legacy
-- producer-wide uniqueness after the stream-scoped replacement is in place.

ALTER TABLE analytics.analytics_source_manifest
    DROP CONSTRAINT IF EXISTS analytics_source_manifest_producer_id_manifest_key_manifest_ver;
