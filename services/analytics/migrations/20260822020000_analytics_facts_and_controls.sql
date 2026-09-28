-- A-06: immutable facts and observations, source state, cursors, quarantine,
-- manifests, reconciliation, quality, backfill, projection metadata, and audit.
--
-- Source facts are append-only. Current collection state and operational control records are
-- intentionally separate so retries, reconciliation, and projection rebuilds do not rewrite
-- historical business data.

CREATE OR REPLACE FUNCTION analytics.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION analytics.validate_scope_bound_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_root_scope_id BIGINT;
    scope_status TEXT;
    root_status TEXT;
BEGIN
    SELECT child.root_scope_id, child.status, root_scope.status
    INTO expected_root_scope_id, scope_status, root_status
    FROM analytics.reporting_scope AS child
    JOIN analytics.reporting_scope AS root_scope
      ON root_scope.scope_id = child.root_scope_id
    WHERE child.scope_id = NEW.reporting_scope_id;

    IF NOT FOUND OR scope_status = 'deleted' OR root_status = 'deleted' THEN
        RAISE EXCEPTION 'Reporting scope % is not available for analytics record', NEW.reporting_scope_id;
    END IF;

    IF NEW.root_scope_id <> expected_root_scope_id THEN
        RAISE EXCEPTION
            'Analytics record root scope % does not match reporting scope % root %',
            NEW.root_scope_id,
            NEW.reporting_scope_id,
            expected_root_scope_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION analytics.validate_source_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    record_category TEXT;
    expected_source_service TEXT;
    producer_active BOOLEAN;
    scope_kind TEXT;
    permitted_categories JSONB;
    permitted_scope_kinds JSONB;
BEGIN
    IF TG_NARGS > 0 THEN
        record_category := NULLIF(TG_ARGV[0], '');
    END IF;

    SELECT identity.source_service,
           producer.active,
           producer.permitted_record_categories,
           producer.permitted_scope_kinds
    INTO expected_source_service, producer_active, permitted_categories, permitted_scope_kinds
    FROM analytics.producer AS producer
    JOIN analytics.service_identity AS identity
      ON identity.service_identity_id = producer.service_identity_id
    WHERE producer.producer_id = NEW.producer_id
      AND identity.status = 'active';

    IF NOT FOUND OR NOT producer_active THEN
        RAISE EXCEPTION 'Analytics producer % is not active', NEW.producer_id;
    END IF;

    IF NEW.source_service <> expected_source_service THEN
        RAISE EXCEPTION
            'Producer % cannot publish as source service %',
            NEW.producer_id,
            NEW.source_service;
    END IF;

    IF NEW.reporting_scope_id IS NOT NULL THEN
        SELECT reporting_scope.scope_kind
        INTO scope_kind
        FROM analytics.reporting_scope
        WHERE reporting_scope.scope_id = NEW.reporting_scope_id;

        IF scope_kind IS NULL OR NOT (permitted_scope_kinds ? scope_kind) THEN
            RAISE EXCEPTION
                'Producer % is not permitted to publish scope kind %',
                NEW.producer_id,
                COALESCE(scope_kind, 'unknown');
        END IF;
    END IF;

    IF record_category IS NOT NULL AND NOT (permitted_categories ? record_category) THEN
        RAISE EXCEPTION
            'Producer % is not permitted to publish record category %',
            NEW.producer_id,
            record_category;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION analytics.prevent_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Analytics record % is immutable; append a correction or revision', TG_TABLE_NAME;
END;
$$;

CREATE TABLE IF NOT EXISTS analytics.analytics_event (
    storage_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 0),
    event_id TEXT NOT NULL CHECK (length(trim(event_id)) BETWEEN 1 AND 256),
    event_type TEXT NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]+@[0-9]+$'),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    subject_type TEXT NOT NULL CHECK (length(trim(subject_type)) BETWEEN 1 AND 128),
    subject_id TEXT NOT NULL CHECK (length(trim(subject_id)) BETWEEN 1 AND 512),
    occurred_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    origin TEXT NOT NULL CHECK (length(trim(origin)) BETWEEN 1 AND 512),
    source_record_id TEXT CHECK (source_record_id IS NULL OR length(trim(source_record_id)) BETWEEN 1 AND 512),
    actor_type TEXT CHECK (actor_type IS NULL OR length(trim(actor_type)) BETWEEN 1 AND 128),
    actor_id TEXT CHECK (actor_id IS NULL OR length(trim(actor_id)) BETWEEN 1 AND 512),
    correlation_id TEXT CHECK (correlation_id IS NULL OR length(trim(correlation_id)) BETWEEN 1 AND 512),
    causation_id TEXT CHECK (causation_id IS NULL OR length(trim(causation_id)) BETWEEN 1 AND 512),
    idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(trim(idempotency_key)) BETWEEN 1 AND 512),
    attributes JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(attributes) = 'object'),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    backfilled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (producer_id, event_id),
    UNIQUE (producer_id, source_stream_key, source_sequence)
);

CREATE INDEX IF NOT EXISTS analytics_event_scope_time_idx
    ON analytics.analytics_event (reporting_scope_id, occurred_at, storage_id);
CREATE INDEX IF NOT EXISTS analytics_event_root_time_idx
    ON analytics.analytics_event (root_scope_id, occurred_at, storage_id);
CREATE INDEX IF NOT EXISTS analytics_event_type_time_idx
    ON analytics.analytics_event (event_type, occurred_at, storage_id);
CREATE INDEX IF NOT EXISTS analytics_event_subject_idx
    ON analytics.analytics_event (subject_type, subject_id, occurred_at);
CREATE INDEX IF NOT EXISTS analytics_event_stream_sequence_idx
    ON analytics.analytics_event (producer_id, source_stream_key, source_sequence);
CREATE INDEX IF NOT EXISTS analytics_event_ingested_brin_idx
    ON analytics.analytics_event USING BRIN (ingested_at);

CREATE TRIGGER analytics_event_scope_validate_trigger
BEFORE INSERT ON analytics.analytics_event
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_event_source_validate_trigger
BEFORE INSERT ON analytics.analytics_event
FOR EACH ROW EXECUTE FUNCTION analytics.validate_source_record('event');

CREATE TRIGGER analytics_event_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_event
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

CREATE TABLE IF NOT EXISTS analytics.analytics_metric_observation (
    storage_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 0),
    observation_id TEXT NOT NULL CHECK (length(trim(observation_id)) BETWEEN 1 AND 256),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    provider TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 128),
    provider_account_ref TEXT CHECK (provider_account_ref IS NULL OR length(trim(provider_account_ref)) BETWEEN 1 AND 512),
    connection_ref TEXT CHECK (connection_ref IS NULL OR length(trim(connection_ref)) BETWEEN 1 AND 512),
    metric_key TEXT NOT NULL CHECK (metric_key ~ '^[a-z][a-z0-9_.-]+$'),
    numeric_value NUMERIC NOT NULL,
    unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 128),
    reporting_window_start TIMESTAMPTZ NOT NULL,
    reporting_window_end TIMESTAMPTZ NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synchronization_run_id TEXT NOT NULL CHECK (length(trim(synchronization_run_id)) BETWEEN 1 AND 256),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    subject_type TEXT CHECK (subject_type IS NULL OR length(trim(subject_type)) BETWEEN 1 AND 128),
    subject_id TEXT CHECK (subject_id IS NULL OR length(trim(subject_id)) BETWEEN 1 AND 512),
    dimensions JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(dimensions) = 'object'),
    source_evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(source_evidence) = 'object'),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    backfilled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (producer_id, observation_id),
    UNIQUE (producer_id, source_stream_key, source_sequence),
    CHECK (reporting_window_end > reporting_window_start),
    CHECK ((subject_type IS NULL) = (subject_id IS NULL))
);

CREATE INDEX IF NOT EXISTS analytics_metric_observation_scope_time_idx
    ON analytics.analytics_metric_observation (reporting_scope_id, observed_at, storage_id);
CREATE INDEX IF NOT EXISTS analytics_metric_observation_root_time_idx
    ON analytics.analytics_metric_observation (root_scope_id, observed_at, storage_id);
CREATE INDEX IF NOT EXISTS analytics_metric_observation_metric_window_idx
    ON analytics.analytics_metric_observation (metric_key, reporting_window_start, reporting_window_end);
CREATE INDEX IF NOT EXISTS analytics_metric_observation_provider_idx
    ON analytics.analytics_metric_observation (provider, connection_ref, metric_key, observed_at);
CREATE INDEX IF NOT EXISTS analytics_metric_observation_ingested_brin_idx
    ON analytics.analytics_metric_observation USING BRIN (ingested_at);

CREATE TRIGGER analytics_metric_observation_scope_validate_trigger
BEFORE INSERT ON analytics.analytics_metric_observation
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_metric_observation_source_validate_trigger
BEFORE INSERT ON analytics.analytics_metric_observation
FOR EACH ROW EXECUTE FUNCTION analytics.validate_source_record('observation');

CREATE TRIGGER analytics_metric_observation_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_metric_observation
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

CREATE TABLE IF NOT EXISTS analytics.analytics_source_state (
    state_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    provider TEXT NOT NULL DEFAULT '' CHECK (length(provider) <= 128),
    connection_ref TEXT NOT NULL DEFAULT '' CHECK (length(connection_ref) <= 512),
    metric_scope TEXT NOT NULL CHECK (length(trim(metric_scope)) BETWEEN 1 AND 256),
    availability_state TEXT NOT NULL CHECK (availability_state IN (
        'available', 'partial', 'stale', 'unsupported', 'not_instrumented',
        'not_applicable', 'backfilling', 'unavailable'
    )),
    reliable_coverage_start TIMESTAMPTZ,
    reliable_coverage_end TIMESTAMPTZ,
    latest_source_timestamp TIMESTAMPTZ,
    last_successful_sync_at TIMESTAMPTZ,
    expected_refresh_seconds BIGINT CHECK (expected_refresh_seconds IS NULL OR expected_refresh_seconds > 0),
    next_attempt_at TIMESTAMPTZ,
    safe_failure_code TEXT CHECK (safe_failure_code IS NULL OR safe_failure_code ~ '^[a-z][a-z0-9_.-]+$'),
    latest_source_sequence BIGINT CHECK (latest_source_sequence IS NULL OR latest_source_sequence >= 0),
    latest_manifest_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (producer_id, source_stream_key, reporting_scope_id, metric_scope),
    CHECK (reliable_coverage_end IS NULL OR reliable_coverage_start IS NULL OR reliable_coverage_end >= reliable_coverage_start)
);

CREATE INDEX IF NOT EXISTS analytics_source_state_availability_idx
    ON analytics.analytics_source_state (reporting_scope_id, availability_state, last_successful_sync_at);
CREATE INDEX IF NOT EXISTS analytics_source_state_next_attempt_idx
    ON analytics.analytics_source_state (availability_state, next_attempt_at);

CREATE TRIGGER analytics_source_state_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_source_state
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_source_state_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_source_state
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_source_cursor (
    cursor_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    highest_received_sequence BIGINT NOT NULL DEFAULT 0 CHECK (highest_received_sequence >= 0),
    highest_contiguous_sequence BIGINT NOT NULL DEFAULT 0 CHECK (highest_contiguous_sequence >= 0),
    known_gap_ranges JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(known_gap_ranges) = 'array'),
    latest_acceptance_at TIMESTAMPTZ,
    latest_reconciliation_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (producer_id, source_stream_key),
    CHECK (highest_contiguous_sequence <= highest_received_sequence)
);

CREATE INDEX IF NOT EXISTS analytics_source_cursor_gap_idx
    ON analytics.analytics_source_cursor (highest_contiguous_sequence, highest_received_sequence);

CREATE TRIGGER analytics_source_cursor_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_source_cursor
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_ingestion_failure (
    failure_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    source_sequence BIGINT CHECK (source_sequence IS NULL OR source_sequence >= 0),
    record_category TEXT NOT NULL CHECK (record_category IN ('event', 'observation', 'scope_definition', 'manifest')),
    record_identity TEXT NOT NULL CHECK (length(trim(record_identity)) BETWEEN 1 AND 512),
    reporting_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    schema_version INTEGER CHECK (schema_version IS NULL OR schema_version > 0),
    payload_hash TEXT CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
    failure_class TEXT NOT NULL CHECK (failure_class IN ('permanent', 'retryable', 'identity_conflict', 'privacy')),
    safe_error_code TEXT NOT NULL CHECK (safe_error_code ~ '^[a-z][a-z0-9_.-]+$'),
    safe_error_summary TEXT CHECK (safe_error_summary IS NULL OR length(safe_error_summary) <= 512),
    quarantine_status TEXT NOT NULL CHECK (quarantine_status IN ('quarantined', 'released', 'resolved', 'suppressed')),
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    repair_transform_version TEXT CHECK (repair_transform_version IS NULL OR length(trim(repair_transform_version)) BETWEEN 1 AND 128),
    resolution_actor_type TEXT CHECK (resolution_actor_type IS NULL OR length(trim(resolution_actor_type)) BETWEEN 1 AND 128),
    resolution_actor_id TEXT CHECK (resolution_actor_id IS NULL OR length(trim(resolution_actor_id)) BETWEEN 1 AND 512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (resolved_at IS NULL OR quarantine_status IN ('released', 'resolved', 'suppressed')),
    CHECK ((quarantine_status = 'released') = (repair_transform_version IS NOT NULL)),
    CHECK ((resolution_actor_type IS NULL) = (resolution_actor_id IS NULL))
);

CREATE INDEX IF NOT EXISTS analytics_ingestion_failure_claim_idx
    ON analytics.analytics_ingestion_failure (quarantine_status, last_seen_at, failure_id);
CREATE INDEX IF NOT EXISTS analytics_ingestion_failure_identity_idx
    ON analytics.analytics_ingestion_failure (producer_id, record_category, record_identity);
CREATE INDEX IF NOT EXISTS analytics_ingestion_failure_scope_idx
    ON analytics.analytics_ingestion_failure (reporting_scope_id, quarantine_status);

CREATE TRIGGER analytics_ingestion_failure_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_ingestion_failure
FOR EACH ROW WHEN (NEW.reporting_scope_id IS NOT NULL)
EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_ingestion_failure_source_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_ingestion_failure
FOR EACH ROW EXECUTE FUNCTION analytics.validate_source_record();

CREATE OR REPLACE FUNCTION analytics.protect_ingestion_failure_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.producer_id IS DISTINCT FROM OLD.producer_id
       OR NEW.source_service IS DISTINCT FROM OLD.source_service
       OR NEW.source_domain IS DISTINCT FROM OLD.source_domain
       OR NEW.source_stream_key IS DISTINCT FROM OLD.source_stream_key
       OR NEW.source_sequence IS DISTINCT FROM OLD.source_sequence
       OR NEW.record_category IS DISTINCT FROM OLD.record_category
       OR NEW.record_identity IS DISTINCT FROM OLD.record_identity
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN
        RAISE EXCEPTION 'Quarantine identity is immutable; append a new failure record';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER analytics_ingestion_failure_identity_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_ingestion_failure
FOR EACH ROW EXECUTE FUNCTION analytics.protect_ingestion_failure_identity();

CREATE TRIGGER analytics_ingestion_failure_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_ingestion_failure
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_source_manifest (
    manifest_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    manifest_key TEXT NOT NULL CHECK (length(trim(manifest_key)) BETWEEN 1 AND 512),
    manifest_version BIGINT NOT NULL CHECK (manifest_version > 0),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    provider TEXT NOT NULL DEFAULT '' CHECK (length(provider) <= 128),
    connection_ref TEXT NOT NULL DEFAULT '' CHECK (length(connection_ref) <= 512),
    supported_contracts TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    supported_observation_contracts TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    supported_metrics TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    supported_dimensions TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    expected_refresh_seconds BIGINT NOT NULL CHECK (expected_refresh_seconds > 0),
    reliable_coverage_start TIMESTAMPTZ,
    highest_authoritative_source_sequence BIGINT CHECK (
        highest_authoritative_source_sequence IS NULL OR highest_authoritative_source_sequence >= 0
    ),
    approved_checkpoint_count BIGINT CHECK (approved_checkpoint_count IS NULL OR approved_checkpoint_count >= 0),
    approved_checkpoint_hash TEXT CHECK (approved_checkpoint_hash IS NULL OR approved_checkpoint_hash ~ '^[0-9a-f]{64}$'),
    last_successful_collection_at TIMESTAMPTZ,
    last_attempted_collection_at TIMESTAMPTZ,
    safe_failure_code TEXT CHECK (safe_failure_code IS NULL OR safe_failure_code ~ '^[a-z][a-z0-9_.-]+$'),
    next_expected_at TIMESTAMPTZ,
    manifest_state TEXT NOT NULL CHECK (manifest_state IN (
        'active', 'disabled', 'unsupported', 'awaiting_instrumentation'
    )),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    generated_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (producer_id, manifest_key, manifest_version)
);

CREATE INDEX IF NOT EXISTS analytics_source_manifest_scope_time_idx
    ON analytics.analytics_source_manifest (reporting_scope_id, received_at, manifest_id);
CREATE INDEX IF NOT EXISTS analytics_source_manifest_stream_idx
    ON analytics.analytics_source_manifest (producer_id, source_stream_key, manifest_version);

CREATE TRIGGER analytics_source_manifest_scope_validate_trigger
BEFORE INSERT ON analytics.analytics_source_manifest
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_source_manifest_source_validate_trigger
BEFORE INSERT ON analytics.analytics_source_manifest
FOR EACH ROW EXECUTE FUNCTION analytics.validate_source_record();

CREATE TRIGGER analytics_source_manifest_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_source_manifest
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

CREATE TABLE IF NOT EXISTS analytics.analytics_coverage_checkpoint (
    coverage_checkpoint_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    coverage_layer TEXT NOT NULL CHECK (coverage_layer IN (
        'instrumentation', 'source', 'transport', 'temporal', 'projection', 'reconciliation', 'dimension'
    )),
    dimension_key TEXT CHECK (dimension_key IS NULL OR length(trim(dimension_key)) BETWEEN 1 AND 256),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    expected_count BIGINT CHECK (expected_count IS NULL OR expected_count >= 0),
    included_count BIGINT NOT NULL CHECK (included_count >= 0),
    excluded_count BIGINT NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
    coverage_state TEXT NOT NULL CHECK (coverage_state IN ('available', 'partial', 'unknown', 'stale', 'unavailable')),
    complete_through TIMESTAMPTZ,
    projection_version TEXT CHECK (projection_version IS NULL OR length(trim(projection_version)) BETWEEN 1 AND 128),
    source_manifest_id BIGINT REFERENCES analytics.analytics_source_manifest(manifest_id),
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (window_end > window_start),
    CHECK (expected_count IS NULL OR included_count + excluded_count <= expected_count)
);

CREATE INDEX IF NOT EXISTS analytics_coverage_checkpoint_scope_window_idx
    ON analytics.analytics_coverage_checkpoint (reporting_scope_id, window_start, window_end, coverage_layer);
CREATE INDEX IF NOT EXISTS analytics_coverage_checkpoint_root_window_idx
    ON analytics.analytics_coverage_checkpoint (root_scope_id, window_start, window_end, coverage_layer);

CREATE TRIGGER analytics_coverage_checkpoint_scope_validate_trigger
BEFORE INSERT ON analytics.analytics_coverage_checkpoint
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_coverage_checkpoint_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_coverage_checkpoint
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

CREATE TABLE IF NOT EXISTS analytics.analytics_reconciliation_run (
    reconciliation_run_id TEXT PRIMARY KEY CHECK (length(trim(reconciliation_run_id)) BETWEEN 1 AND 256),
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    reporting_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    source_highest_outbox_sequence BIGINT CHECK (source_highest_outbox_sequence IS NULL OR source_highest_outbox_sequence >= 0),
    source_highest_delivered_sequence BIGINT CHECK (source_highest_delivered_sequence IS NULL OR source_highest_delivered_sequence >= 0),
    analytics_highest_received_sequence BIGINT CHECK (analytics_highest_received_sequence IS NULL OR analytics_highest_received_sequence >= 0),
    analytics_highest_contiguous_sequence BIGINT CHECK (analytics_highest_contiguous_sequence IS NULL OR analytics_highest_contiguous_sequence >= 0),
    missing_sequence_ranges JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(missing_sequence_ranges) = 'array'),
    unresolved_quarantine_count BIGINT NOT NULL DEFAULT 0 CHECK (unresolved_quarantine_count >= 0),
    authoritative_count BIGINT CHECK (authoritative_count IS NULL OR authoritative_count >= 0),
    analytics_count BIGINT CHECK (analytics_count IS NULL OR analytics_count >= 0),
    authoritative_checksum TEXT CHECK (authoritative_checksum IS NULL OR authoritative_checksum ~ '^[0-9a-f]{64}$'),
    analytics_checksum TEXT CHECK (analytics_checksum IS NULL OR analytics_checksum ~ '^[0-9a-f]{64}$'),
    reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN ('running', 'complete', 'partial', 'mismatch', 'failed')),
    safe_failure_code TEXT CHECK (safe_failure_code IS NULL OR safe_failure_code ~ '^[a-z][a-z0-9_.-]+$'),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (completed_at IS NULL OR completed_at >= started_at),
    CHECK (analytics_highest_contiguous_sequence IS NULL OR analytics_highest_received_sequence IS NULL OR analytics_highest_contiguous_sequence <= analytics_highest_received_sequence)
);

CREATE INDEX IF NOT EXISTS analytics_reconciliation_run_source_idx
    ON analytics.analytics_reconciliation_run (producer_id, source_stream_key, started_at DESC);
CREATE INDEX IF NOT EXISTS analytics_reconciliation_run_scope_idx
    ON analytics.analytics_reconciliation_run (reporting_scope_id, started_at DESC);

CREATE TRIGGER analytics_reconciliation_run_scope_validate_trigger
BEFORE INSERT ON analytics.analytics_reconciliation_run
FOR EACH ROW WHEN (NEW.reporting_scope_id IS NOT NULL)
EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TABLE IF NOT EXISTS analytics.analytics_quality_issue (
    quality_issue_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_key TEXT NOT NULL CHECK (length(trim(issue_key)) BETWEEN 1 AND 512),
    issue_code TEXT NOT NULL CHECK (issue_code ~ '^[a-z][a-z0-9_.-]+$'),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    issue_status TEXT NOT NULL CHECK (issue_status IN ('open', 'acknowledged', 'resolved', 'suppressed')),
    producer_id TEXT REFERENCES analytics.producer(producer_id),
    source_service TEXT REFERENCES analytics.service_identity(source_service),
    source_domain TEXT CHECK (source_domain IS NULL OR length(trim(source_domain)) BETWEEN 1 AND 256),
    reporting_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    safe_summary TEXT NOT NULL CHECK (length(trim(safe_summary)) BETWEEN 1 AND 512),
    safe_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(safe_metadata) = 'object'),
    first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    suppression_reason TEXT CHECK (suppression_reason IS NULL OR length(trim(suppression_reason)) BETWEEN 1 AND 512),
    suppressed_until TIMESTAMPTZ,
    action_actor_type TEXT CHECK (action_actor_type IS NULL OR length(trim(action_actor_type)) BETWEEN 1 AND 128),
    action_actor_id TEXT CHECK (action_actor_id IS NULL OR length(trim(action_actor_id)) BETWEEN 1 AND 512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((issue_status = 'suppressed') = (suppression_reason IS NOT NULL AND suppressed_until IS NOT NULL)),
    CHECK ((action_actor_type IS NULL) = (action_actor_id IS NULL))
);

CREATE INDEX IF NOT EXISTS analytics_quality_issue_status_idx
    ON analytics.analytics_quality_issue (issue_status, severity, last_detected_at);
CREATE INDEX IF NOT EXISTS analytics_quality_issue_scope_idx
    ON analytics.analytics_quality_issue (reporting_scope_id, issue_status, severity);

CREATE TRIGGER analytics_quality_issue_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_quality_issue
FOR EACH ROW WHEN (NEW.reporting_scope_id IS NOT NULL)
EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_quality_issue_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_quality_issue
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_backfill_job (
    job_id TEXT PRIMARY KEY CHECK (length(trim(job_id)) BETWEEN 1 AND 256),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    requested_range_start TIMESTAMPTZ NOT NULL,
    requested_range_end TIMESTAMPTZ NOT NULL,
    contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) BETWEEN 1 AND 128),
    projection_version TEXT CHECK (projection_version IS NULL OR length(trim(projection_version)) BETWEEN 1 AND 128),
    method TEXT NOT NULL CHECK (method IN ('source_reconstruction', 'fact_replay', 'provider_history_import', 'projection_rebuild')),
    job_status TEXT NOT NULL CHECK (job_status IN ('queued', 'running', 'paused', 'failed', 'completed', 'cancelled')),
    checkpoint JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(checkpoint) = 'object'),
    scanned_count BIGINT NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
    accepted_count BIGINT NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    rejected_count BIGINT NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    remaining_count BIGINT CHECK (remaining_count IS NULL OR remaining_count >= 0),
    coverage_before JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(coverage_before) = 'object'),
    coverage_after JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(coverage_after) = 'object'),
    requesting_actor_type TEXT NOT NULL CHECK (length(trim(requesting_actor_type)) BETWEEN 1 AND 128),
    requesting_actor_id TEXT NOT NULL CHECK (length(trim(requesting_actor_id)) BETWEEN 1 AND 512),
    authorization_grant_id TEXT NOT NULL CHECK (length(trim(authorization_grant_id)) BETWEEN 1 AND 256),
    safe_failure_code TEXT CHECK (safe_failure_code IS NULL OR safe_failure_code ~ '^[a-z][a-z0-9_.-]+$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (requested_range_end > requested_range_start),
    CHECK (completed_at IS NULL OR started_at IS NOT NULL),
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS analytics_backfill_job_claim_idx
    ON analytics.analytics_backfill_job (job_status, updated_at, job_id);
CREATE INDEX IF NOT EXISTS analytics_backfill_job_scope_idx
    ON analytics.analytics_backfill_job (reporting_scope_id, requested_range_start, requested_range_end);

CREATE TRIGGER analytics_backfill_job_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_backfill_job
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_backfill_job_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_backfill_job
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_projection_generation (
    generation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    projection_name TEXT NOT NULL CHECK (length(trim(projection_name)) BETWEEN 1 AND 256),
    projection_version TEXT NOT NULL CHECK (length(trim(projection_version)) BETWEEN 1 AND 128),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    shard_key TEXT NOT NULL CHECK (length(trim(shard_key)) BETWEEN 1 AND 256),
    generation_number BIGINT NOT NULL CHECK (generation_number > 0),
    generation_status TEXT NOT NULL CHECK (generation_status IN ('building', 'validated', 'promoted', 'failed', 'cancelled')),
    source_high_watermark BIGINT CHECK (source_high_watermark IS NULL OR source_high_watermark >= 0),
    metric_registry_sha256 TEXT NOT NULL CHECK (metric_registry_sha256 ~ '^[0-9a-f]{64}$'),
    coverage_summary JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(coverage_summary) = 'object'),
    validation_summary JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(validation_summary) = 'object'),
    created_by_type TEXT NOT NULL CHECK (length(trim(created_by_type)) BETWEEN 1 AND 128),
    created_by_id TEXT NOT NULL CHECK (length(trim(created_by_id)) BETWEEN 1 AND 512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    validated_at TIMESTAMPTZ,
    promoted_at TIMESTAMPTZ,
    UNIQUE (projection_name, projection_version, reporting_scope_id, shard_key, generation_number),
    CHECK (promoted_at IS NULL OR generation_status = 'promoted'),
    CHECK (validated_at IS NULL OR generation_status IN ('validated', 'promoted'))
);

CREATE INDEX IF NOT EXISTS analytics_projection_generation_scope_idx
    ON analytics.analytics_projection_generation (reporting_scope_id, projection_name, generation_status, generation_number DESC);
CREATE INDEX IF NOT EXISTS analytics_projection_generation_promotion_idx
    ON analytics.analytics_projection_generation (projection_name, projection_version, generation_status, promoted_at DESC);

CREATE TRIGGER analytics_projection_generation_scope_validate_trigger
BEFORE INSERT ON analytics.analytics_projection_generation
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TABLE IF NOT EXISTS analytics.analytics_projection_checkpoint (
    checkpoint_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    projection_name TEXT NOT NULL CHECK (length(trim(projection_name)) BETWEEN 1 AND 256),
    projection_version TEXT NOT NULL CHECK (length(trim(projection_version)) BETWEEN 1 AND 128),
    reporting_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT NOT NULL REFERENCES analytics.reporting_scope(scope_id),
    shard_key TEXT NOT NULL CHECK (length(trim(shard_key)) BETWEEN 1 AND 256),
    generation_id BIGINT REFERENCES analytics.analytics_projection_generation(generation_id),
    last_processed_storage_id BIGINT NOT NULL DEFAULT 0 CHECK (last_processed_storage_id >= 0),
    processing_status TEXT NOT NULL CHECK (processing_status IN ('idle', 'running', 'paused', 'failed', 'rebuilding')),
    lease_owner TEXT CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 256),
    lease_expires_at TIMESTAMPTZ,
    rebuild_requested_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (projection_name, projection_version, reporting_scope_id, shard_key)
);

CREATE INDEX IF NOT EXISTS analytics_projection_checkpoint_claim_idx
    ON analytics.analytics_projection_checkpoint (processing_status, lease_expires_at, updated_at);
CREATE INDEX IF NOT EXISTS analytics_projection_checkpoint_scope_idx
    ON analytics.analytics_projection_checkpoint (reporting_scope_id, projection_name, projection_version);

CREATE TRIGGER analytics_projection_checkpoint_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_projection_checkpoint
FOR EACH ROW EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_projection_checkpoint_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_projection_checkpoint
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_audit_record (
    audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain_name TEXT NOT NULL CHECK (length(trim(chain_name)) BETWEEN 1 AND 128),
    chain_sequence BIGINT NOT NULL DEFAULT 0 CHECK (chain_sequence > 0),
    previous_record_hash TEXT CHECK (previous_record_hash IS NULL OR previous_record_hash ~ '^[0-9a-f]{64}$'),
    record_hash TEXT NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
    principal_type TEXT NOT NULL CHECK (length(trim(principal_type)) BETWEEN 1 AND 128),
    principal_id TEXT NOT NULL CHECK (length(trim(principal_id)) BETWEEN 1 AND 512),
    reporting_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    permission TEXT CHECK (permission IS NULL OR length(trim(permission)) BETWEEN 1 AND 256),
    operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 256),
    metric_keys TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    request_hash TEXT CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
    filter_hash TEXT CHECK (filter_hash IS NULL OR filter_hash ~ '^[0-9a-f]{64}$'),
    outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'accepted', 'rejected', 'failed')),
    correlation_id TEXT CHECK (correlation_id IS NULL OR length(trim(correlation_id)) BETWEEN 1 AND 512),
    policy_version TEXT CHECK (policy_version IS NULL OR length(trim(policy_version)) BETWEEN 1 AND 128),
    safe_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(safe_metadata) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_name, chain_sequence)
);

CREATE INDEX IF NOT EXISTS analytics_audit_record_scope_time_idx
    ON analytics.analytics_audit_record (reporting_scope_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_audit_record_chain_idx
    ON analytics.analytics_audit_record (chain_name, chain_sequence DESC);

CREATE OR REPLACE FUNCTION analytics.validate_audit_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    latest_sequence BIGINT;
    latest_hash TEXT;
BEGIN
    IF NEW.record_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Audit record hash must be a lowercase SHA-256 hex value';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.chain_name, 0));

    SELECT chain_sequence, record_hash
    INTO latest_sequence, latest_hash
    FROM analytics.analytics_audit_record
    WHERE chain_name = NEW.chain_name
    ORDER BY chain_sequence DESC
    LIMIT 1;

    IF FOUND THEN
        IF NEW.previous_record_hash IS DISTINCT FROM latest_hash THEN
            RAISE EXCEPTION 'Audit record does not continue the current chain %', NEW.chain_name;
        END IF;
        NEW.chain_sequence := latest_sequence + 1;
    ELSE
        IF NEW.previous_record_hash IS NOT NULL THEN
            RAISE EXCEPTION 'First audit record in chain % cannot reference a previous hash', NEW.chain_name;
        END IF;
        NEW.chain_sequence := 1;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER analytics_audit_record_chain_trigger
BEFORE INSERT ON analytics.analytics_audit_record
FOR EACH ROW EXECUTE FUNCTION analytics.validate_audit_chain();

CREATE TRIGGER analytics_audit_record_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_audit_record
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

CREATE TABLE IF NOT EXISTS analytics.analytics_audit_checkpoint (
    audit_checkpoint_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain_name TEXT NOT NULL CHECK (length(trim(chain_name)) BETWEEN 1 AND 128),
    through_sequence BIGINT NOT NULL CHECK (through_sequence > 0),
    last_record_hash TEXT NOT NULL CHECK (last_record_hash ~ '^[0-9a-f]{64}$'),
    signature_algorithm TEXT NOT NULL CHECK (signature_algorithm IN ('es256', 'pending')),
    signer_key_id TEXT CHECK (signer_key_id IS NULL OR length(trim(signer_key_id)) BETWEEN 1 AND 256),
    signature TEXT,
    checkpoint_status TEXT NOT NULL CHECK (checkpoint_status IN ('pending', 'signed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    signed_at TIMESTAMPTZ,
    CHECK ((checkpoint_status = 'signed') = (signature IS NOT NULL AND signer_key_id IS NOT NULL AND signed_at IS NOT NULL)),
    UNIQUE (chain_name, through_sequence)
);

CREATE OR REPLACE FUNCTION analytics.validate_audit_checkpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    actual_hash TEXT;
BEGIN
    SELECT record_hash
    INTO actual_hash
    FROM analytics.analytics_audit_record
    WHERE chain_name = NEW.chain_name
      AND chain_sequence = NEW.through_sequence;

    IF actual_hash IS NULL OR actual_hash <> NEW.last_record_hash THEN
        RAISE EXCEPTION 'Audit checkpoint does not match chain % at sequence %', NEW.chain_name, NEW.through_sequence;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER analytics_audit_checkpoint_validate_trigger
BEFORE INSERT ON analytics.analytics_audit_checkpoint
FOR EACH ROW EXECUTE FUNCTION analytics.validate_audit_checkpoint();

CREATE TRIGGER analytics_audit_checkpoint_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_audit_checkpoint
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

-- Scope-bearing facts and control records use the same transaction-local authorization context as
-- the A-05 control tables. Application authorization remains required before this context is set.
ALTER TABLE analytics.analytics_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_metric_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_source_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_ingestion_failure ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_source_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_coverage_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_reconciliation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_quality_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_backfill_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_projection_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_projection_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_audit_record ENABLE ROW LEVEL SECURITY;

CREATE POLICY analytics_event_authorized_read
ON analytics.analytics_event FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_metric_observation_authorized_read
ON analytics.analytics_metric_observation FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_source_state_authorized_read
ON analytics.analytics_source_state FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_ingestion_failure_authorized_read
ON analytics.analytics_ingestion_failure FOR SELECT
USING (reporting_scope_id IS NOT NULL AND analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_source_manifest_authorized_read
ON analytics.analytics_source_manifest FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_coverage_checkpoint_authorized_read
ON analytics.analytics_coverage_checkpoint FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_reconciliation_run_authorized_read
ON analytics.analytics_reconciliation_run FOR SELECT
USING (reporting_scope_id IS NOT NULL AND analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_quality_issue_authorized_read
ON analytics.analytics_quality_issue FOR SELECT
USING (reporting_scope_id IS NOT NULL AND analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_backfill_job_authorized_read
ON analytics.analytics_backfill_job FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_projection_generation_authorized_read
ON analytics.analytics_projection_generation FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_projection_checkpoint_authorized_read
ON analytics.analytics_projection_checkpoint FOR SELECT
USING (analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_audit_record_authorized_read
ON analytics.analytics_audit_record FOR SELECT
USING (reporting_scope_id IS NOT NULL AND analytics.scope_is_authorized(reporting_scope_id));

COMMENT ON TABLE analytics.analytics_event IS
    'Append-only normalized customer analytics facts; corrections are new events';
COMMENT ON TABLE analytics.analytics_metric_observation IS
    'Append-only provider measurements; revisions append newer observations for the same window';
COMMENT ON TABLE analytics.analytics_source_state IS
    'Current source availability and reliable-coverage summary; missing is not zero';
COMMENT ON TABLE analytics.analytics_source_cursor IS
    'Durable per-producer stream cursor with received, contiguous, and gap state';
COMMENT ON TABLE analytics.analytics_ingestion_failure IS
    'Privacy-safe quarantine lifecycle; raw payloads and credentials are never stored here';
COMMENT ON TABLE analytics.analytics_source_manifest IS
    'Historical source capability, heartbeat, cadence, coverage, and checkpoint manifests';
COMMENT ON TABLE analytics.analytics_projection_generation IS
    'Independent projection generations validated before promotion';
COMMENT ON TABLE analytics.analytics_audit_record IS
    'Append-only privacy-safe audit chain for customer analytics access and control operations';
