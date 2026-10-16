-- A-09: immutable receipts for scope-definition records.
-- Reporting scopes are mutable read models, so the original source identity and payload must be
-- retained separately for duplicate detection, reconciliation, and controlled replay.

CREATE TABLE IF NOT EXISTS analytics.analytics_scope_definition_receipt (
    storage_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 0),
    record_id TEXT NOT NULL CHECK (length(trim(record_id)) BETWEEN 1 AND 512),
    contract_name TEXT NOT NULL CHECK (contract_name ~ '^[a-z][a-z0-9_.-]+@[0-9]+$'),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    scope_kind TEXT NOT NULL REFERENCES analytics.scope_kind_registry(scope_kind),
    scope_external_id TEXT NOT NULL CHECK (length(trim(scope_external_id)) BETWEEN 1 AND 512),
    source_version BIGINT NOT NULL CHECK (source_version > 0),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (producer_id, record_id),
    UNIQUE (producer_id, source_stream_key, source_sequence)
);

CREATE INDEX IF NOT EXISTS analytics_scope_definition_receipt_scope_idx
    ON analytics.analytics_scope_definition_receipt (scope_kind, scope_external_id, source_version DESC);

CREATE INDEX IF NOT EXISTS analytics_scope_definition_receipt_stream_idx
    ON analytics.analytics_scope_definition_receipt (producer_id, source_stream_key, source_sequence);

CREATE TRIGGER analytics_scope_definition_receipt_source_validate_trigger
BEFORE INSERT ON analytics.analytics_scope_definition_receipt
FOR EACH ROW EXECUTE FUNCTION analytics.validate_source_record('scope_definition');

CREATE TRIGGER analytics_scope_definition_receipt_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_scope_definition_receipt
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

COMMENT ON TABLE analytics.analytics_scope_definition_receipt IS
    'Immutable source receipt for reporting-scope definitions; reporting_scope is the current read model';
