-- Count source-backfill records once per job when a producer restarts from page one.
CREATE TABLE analytics.analytics_backfill_record_receipt (
    job_id TEXT NOT NULL REFERENCES analytics.analytics_backfill_job(job_id),
    producer_id TEXT NOT NULL REFERENCES analytics.producer(producer_id),
    source_stream_key TEXT NOT NULL CHECK (length(trim(source_stream_key)) BETWEEN 1 AND 512),
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 0),
    record_category TEXT NOT NULL CHECK (record_category IN ('event', 'observation', 'scope_definition', 'manifest')),
    record_id TEXT NOT NULL CHECK (length(trim(record_id)) BETWEEN 1 AND 512),
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, producer_id, source_stream_key, source_sequence, record_category, record_id)
);

CREATE TRIGGER analytics_backfill_record_receipt_immutable_trigger
BEFORE UPDATE OR DELETE ON analytics.analytics_backfill_record_receipt
FOR EACH ROW EXECUTE FUNCTION analytics.prevent_immutable_mutation();

COMMENT ON TABLE analytics.analytics_backfill_record_receipt IS
    'Immutable per-job ingestion outcomes prevent restart retries from decrementing remaining_count twice';
