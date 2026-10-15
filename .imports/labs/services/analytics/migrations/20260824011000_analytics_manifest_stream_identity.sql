-- A manifest key is reusable across customer scopes. Its immutable identity is scoped to the
-- producer stream, key, and version rather than the producer alone.

ALTER TABLE analytics.analytics_source_manifest
    DROP CONSTRAINT IF EXISTS analytics_source_manifest_producer_id_manifest_key_manifest_version_key;

ALTER TABLE analytics.analytics_source_manifest
    ADD CONSTRAINT analytics_source_manifest_stream_manifest_version_key
    UNIQUE (producer_id, source_stream_key, manifest_key, manifest_version);
