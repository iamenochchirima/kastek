-- A-09: durable worker orchestration for reconciliation, quarantine repair, and backfills.
--
-- These queues coordinate work; they do not make Analytics authoritative for producer data and
-- they never store rejected raw payloads. Producers remain responsible for supplying summaries and
-- corrected records through authenticated boundaries.

CREATE TABLE IF NOT EXISTS analytics.analytics_reconciliation_work (
    work_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    reporting_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    root_scope_id BIGINT REFERENCES analytics.reporting_scope(scope_id),
    schedule_key TEXT NOT NULL CHECK (length(trim(schedule_key)) BETWEEN 1 AND 512),
    reason TEXT NOT NULL CHECK (reason IN ('scheduled', 'sequence_gap', 'quarantine', 'manual')),
    priority SMALLINT NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
    work_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (work_status IN ('pending', 'leased', 'waiting_for_source', 'completed', 'failed', 'cancelled')),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 256),
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(trim(last_error_code)) BETWEEN 1 AND 128),
    last_error_message TEXT CHECK (last_error_message IS NULL OR length(trim(last_error_message)) <= 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (schedule_key),
    CHECK ((work_status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (completed_at IS NULL OR work_status = 'completed')
);

CREATE INDEX IF NOT EXISTS analytics_reconciliation_work_claim_idx
    ON analytics.analytics_reconciliation_work (work_status, available_at, priority, work_id);
CREATE INDEX IF NOT EXISTS analytics_reconciliation_work_source_idx
    ON analytics.analytics_reconciliation_work (producer_id, source_stream_key, created_at DESC);

CREATE TRIGGER analytics_reconciliation_work_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_reconciliation_work
FOR EACH ROW WHEN (NEW.reporting_scope_id IS NOT NULL)
EXECUTE FUNCTION analytics.validate_scope_bound_record();

CREATE TRIGGER analytics_reconciliation_work_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_reconciliation_work
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

CREATE TABLE IF NOT EXISTS analytics.analytics_quarantine_release_work (
    work_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    failure_id BIGINT NOT NULL UNIQUE REFERENCES analytics.analytics_ingestion_failure(failure_id),
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_service TEXT NOT NULL REFERENCES analytics.service_identity(source_service),
    source_domain TEXT NOT NULL CHECK (length(trim(source_domain)) BETWEEN 1 AND 256),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    source_sequence BIGINT CHECK (source_sequence IS NULL OR source_sequence >= 0),
    record_category TEXT CHECK (record_category IS NULL OR record_category IN ('event', 'observation', 'scope_definition', 'manifest')),
    schema_version INTEGER CHECK (schema_version IS NULL OR schema_version > 0),
    record_identity TEXT NOT NULL CHECK (length(trim(record_identity)) BETWEEN 1 AND 512),
    payload_hash TEXT CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
    work_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (work_status IN ('pending', 'leased', 'waiting_for_repair', 'released', 'failed', 'cancelled')),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 256),
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    repair_transform_version TEXT CHECK (repair_transform_version IS NULL OR length(trim(repair_transform_version)) BETWEEN 1 AND 128),
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(trim(last_error_code)) BETWEEN 1 AND 128),
    last_error_message TEXT CHECK (last_error_message IS NULL OR length(trim(last_error_message)) <= 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CHECK ((work_status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK ((work_status = 'released') = (repair_transform_version IS NOT NULL)),
    CHECK (completed_at IS NULL OR work_status = 'released')
);

CREATE INDEX IF NOT EXISTS analytics_quarantine_release_work_claim_idx
    ON analytics.analytics_quarantine_release_work (work_status, available_at, work_id);
CREATE INDEX IF NOT EXISTS analytics_quarantine_release_work_producer_idx
    ON analytics.analytics_quarantine_release_work (producer_id, work_status, created_at);

CREATE INDEX IF NOT EXISTS analytics_quarantine_release_work_identity_idx
    ON analytics.analytics_quarantine_release_work (producer_id, source_stream_key, record_identity);

CREATE TRIGGER analytics_quarantine_release_work_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_quarantine_release_work
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

ALTER TABLE analytics.analytics_reconciliation_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_quarantine_release_work ENABLE ROW LEVEL SECURITY;

CREATE POLICY analytics_reconciliation_work_authorized_read
ON analytics.analytics_reconciliation_work FOR SELECT
USING (reporting_scope_id IS NULL OR analytics.scope_is_authorized(reporting_scope_id));

CREATE POLICY analytics_quarantine_release_work_authorized_read
ON analytics.analytics_quarantine_release_work FOR SELECT
USING (EXISTS (
    SELECT 1
    FROM analytics.analytics_ingestion_failure AS failure
    WHERE failure.failure_id = analytics_quarantine_release_work.failure_id
      AND (failure.reporting_scope_id IS NULL OR analytics.scope_is_authorized(failure.reporting_scope_id))
));

ALTER TABLE analytics.analytics_backfill_job
    ADD COLUMN IF NOT EXISTS lease_owner TEXT
        CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 256),
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS last_error_message TEXT
        CHECK (last_error_message IS NULL OR length(trim(last_error_message)) <= 2000);

CREATE INDEX IF NOT EXISTS analytics_backfill_job_lease_idx
    ON analytics.analytics_backfill_job (job_status, next_attempt_at, lease_expires_at, updated_at);
