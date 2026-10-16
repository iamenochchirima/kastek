\set ON_ERROR_STOP on

-- Run this against a disposable loopback database after A-05 and A-06 migrations.
-- The transaction is rolled back so the fixture does not become application data.
BEGIN;

INSERT INTO analytics.reporting_scope (
    scope_kind, owning_source_service, external_source_id, status, reporting_timezone
) VALUES ('tenant_workspace', 'tenant-platform', 'a06-workspace', 'active', 'UTC')
RETURNING scope_id AS root_scope_id \gset a06_

INSERT INTO analytics.reporting_scope (
    scope_kind, owning_source_service, external_source_id, parent_scope_id,
    status, reporting_timezone
) VALUES ('tenant_client', 'tenant-platform', 'a06-client-one', :a06_root_scope_id, 'active', 'UTC')
RETURNING scope_id AS client_one_scope_id \gset a06_

INSERT INTO analytics.reporting_scope (
    scope_kind, owning_source_service, external_source_id, parent_scope_id,
    status, reporting_timezone
) VALUES ('tenant_client', 'tenant-platform', 'a06-client-two', :a06_root_scope_id, 'active', 'UTC')
RETURNING scope_id AS client_two_scope_id \gset a06_

INSERT INTO analytics.analytics_event (
    producer_id, source_service, source_domain, source_stream_key, source_sequence,
    event_id, event_type, schema_version, reporting_scope_id, root_scope_id,
    subject_type, subject_id, occurred_at, origin, attributes, payload_hash
) VALUES
    ('tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', 'tenant:client-one', 100,
     'a06-event-client-one', 'campaign.recipient.sent@1', 1, :a06_client_one_scope_id, :a06_root_scope_id,
     'recipient', 'recipient-one', NOW(), 'a06-test', '{"channel":"whatsapp"}', repeat('a', 64)),
    ('tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', 'tenant:client-two', 100,
     'a06-event-client-two', 'campaign.recipient.sent@1', 1, :a06_client_two_scope_id, :a06_root_scope_id,
     'recipient', 'recipient-two', NOW(), 'a06-test', '{"channel":"whatsapp"}', repeat('b', 64));

INSERT INTO analytics.analytics_metric_observation (
    producer_id, source_service, source_domain, source_stream_key, source_sequence,
    observation_id, schema_version, reporting_scope_id, root_scope_id, provider,
    metric_key, numeric_value, unit, reporting_window_start, reporting_window_end,
    observed_at, synchronization_run_id, dimensions, source_evidence, payload_hash
) VALUES (
    'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', 'tenant:client-one', 101,
    'a06-observation-client-one', 1, :a06_client_one_scope_id, :a06_root_scope_id, 'meta', 'campaign.delivery_rate',
    0.75, 'ratio', NOW() - INTERVAL '1 hour', NOW(), NOW(), 'a06-sync-1',
    '{"channel":"whatsapp"}', '{"source":"a06-test"}', repeat('c', 64)
);

INSERT INTO analytics.analytics_source_state (
    producer_id, source_service, source_domain, source_stream_key, reporting_scope_id, root_scope_id,
    metric_scope, availability_state, expected_refresh_seconds, latest_source_sequence
) VALUES (
    'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', 'tenant:client-one', :a06_client_one_scope_id, :a06_root_scope_id,
    'campaign.delivery_rate', 'available', 900, 101
);

INSERT INTO analytics.analytics_source_cursor (
    producer_id, source_service, source_domain, source_stream_key,
    highest_received_sequence, highest_contiguous_sequence, known_gap_ranges
) VALUES (
    'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', 'tenant:client-one', 101, 101, '[]'
);

INSERT INTO analytics.analytics_ingestion_failure (
    producer_id, source_service, source_domain, source_stream_key, source_sequence,
    record_category, record_identity, reporting_scope_id, root_scope_id,
    schema_version, payload_hash, failure_class, safe_error_code, safe_error_summary,
    quarantine_status
) VALUES (
    'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', 'tenant:client-one', 102,
    'event', 'a06-quarantined-event', :a06_client_one_scope_id, :a06_root_scope_id, 1, repeat('d', 64), 'permanent',
    'contract.invalid', 'Contract validation failed', 'quarantined'
) RETURNING failure_id \gset

UPDATE analytics.analytics_ingestion_failure
SET quarantine_status = 'released', repair_transform_version = 'events.campaign.v1',
    resolution_actor_type = 'service_identity', resolution_actor_id = 'analytics-operator'
WHERE failure_id = :failure_id;

INSERT INTO analytics.analytics_source_manifest (
    producer_id, source_service, source_domain, source_stream_key, manifest_key, manifest_version,
    reporting_scope_id, root_scope_id, supported_contracts, supported_observation_contracts,
    supported_metrics, supported_dimensions, expected_refresh_seconds, reliable_coverage_start,
    highest_authoritative_source_sequence, last_successful_collection_at, last_attempted_collection_at,
    manifest_state, payload_hash, generated_at
) VALUES (
    'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', 'tenant:client-one',
    'tenant:client-one:campaigns', 1, :a06_client_one_scope_id, :a06_root_scope_id,
    ARRAY['campaign.recipient.sent@1'], ARRAY['campaign.delivery_rate@1'],
    ARRAY['campaign.delivery_rate'], ARRAY['channel'], 900, NOW() - INTERVAL '30 days', 101,
    NOW(), NOW(), 'active', repeat('e', 64), NOW()
) RETURNING manifest_id \gset

INSERT INTO analytics.analytics_coverage_checkpoint (
    producer_id, source_service, source_domain, reporting_scope_id, root_scope_id,
    coverage_layer, dimension_key, window_start, window_end, expected_count, included_count,
    excluded_count, coverage_state, complete_through, projection_version, source_manifest_id, observed_at
) VALUES (
    'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', :a06_client_one_scope_id, :a06_root_scope_id,
    'source', 'channel', NOW() - INTERVAL '1 hour', NOW(), 1, 1, 0, 'available', NOW(),
    'campaigns.v1', :manifest_id, NOW()
);

INSERT INTO analytics.analytics_reconciliation_run (
    reconciliation_run_id, producer_id, source_service, source_domain, source_stream_key,
    reporting_scope_id, root_scope_id, source_highest_outbox_sequence, source_highest_delivered_sequence,
    analytics_highest_received_sequence, analytics_highest_contiguous_sequence,
    missing_sequence_ranges, reconciliation_status, started_at, completed_at
) VALUES (
    'a06-reconciliation-1', 'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns',
    'tenant:client-one', :a06_client_one_scope_id, :a06_root_scope_id, 101, 101, 101, 101, '[]', 'complete', NOW() - INTERVAL '1 minute', NOW()
);

INSERT INTO analytics.analytics_quality_issue (
    issue_key, issue_code, severity, issue_status, producer_id, source_service, source_domain,
    reporting_scope_id, root_scope_id, safe_summary
) VALUES (
    'a06:client-one:campaigns:contract', 'contract.invalid', 'warning', 'open',
    'tenant-platform-customer-analytics', 'tenant-platform', 'campaigns', :a06_client_one_scope_id, :a06_root_scope_id,
    'A safe contract quality issue'
);

INSERT INTO analytics.analytics_backfill_job (
    job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
    requested_range_start, requested_range_end, contract_version, projection_version, method,
    job_status, requesting_actor_type, requesting_actor_id, authorization_grant_id
) VALUES (
    'a06-backfill-1', 'tenant-platform', 'campaigns', :a06_client_one_scope_id, :a06_root_scope_id, NOW() - INTERVAL '1 day', NOW(),
    'campaigns.v1', 'campaigns.projection.v1', 'fact_replay', 'queued',
    'service_identity', 'analytics-operator', 'a05-grant'
);

INSERT INTO analytics.analytics_projection_generation (
    projection_name, projection_version, reporting_scope_id, root_scope_id, shard_key,
    generation_number, generation_status, metric_registry_sha256, created_by_type, created_by_id
) VALUES (
    'campaigns.delivery', 'v1', :a06_client_one_scope_id, :a06_root_scope_id, 'default', 1, 'building', repeat('f', 64),
    'service_identity', 'analytics-worker'
) RETURNING generation_id \gset

INSERT INTO analytics.analytics_projection_checkpoint (
    projection_name, projection_version, reporting_scope_id, root_scope_id, shard_key,
    generation_id, processing_status
) VALUES ('campaigns.delivery', 'v1', :a06_client_one_scope_id, :a06_root_scope_id, 'default', :generation_id, 'idle');

INSERT INTO analytics.analytics_audit_record (
    chain_name, previous_record_hash, record_hash, principal_type, principal_id,
    reporting_scope_id, root_scope_id, operation, outcome
) VALUES ('customer-access', NULL, repeat('1', 64), 'user', 'user-one', :a06_client_one_scope_id, :a06_root_scope_id, 'report.read', 'allowed');

INSERT INTO analytics.analytics_audit_record (
    chain_name, previous_record_hash, record_hash, principal_type, principal_id,
    reporting_scope_id, root_scope_id, operation, outcome
) VALUES ('customer-access', repeat('1', 64), repeat('2', 64), 'user', 'user-two', :a06_client_two_scope_id, :a06_root_scope_id, 'report.read', 'allowed');

INSERT INTO analytics.analytics_audit_checkpoint (
    chain_name, through_sequence, last_record_hash, signature_algorithm, checkpoint_status
) VALUES ('customer-access', 2, repeat('2', 64), 'pending', 'pending');

DO $$
DECLARE
    client_scope_id BIGINT;
    root_scope_id BIGINT;
BEGIN
    SELECT scope.scope_id, scope.root_scope_id
    INTO client_scope_id, root_scope_id
    FROM analytics.reporting_scope AS scope
    WHERE scope.external_source_id = 'a06-client-one';

    BEGIN
        UPDATE analytics.analytics_event
        SET attributes = '{"mutated":true}'::jsonb
        WHERE event_id = 'a06-event-client-one';
        RAISE EXCEPTION 'immutable event trigger did not reject update';
    EXCEPTION WHEN OTHERS THEN
        IF position('immutable' IN lower(SQLERRM)) = 0 THEN
            RAISE;
        END IF;
    END;

    BEGIN
        INSERT INTO analytics.analytics_audit_record (
            chain_name, previous_record_hash, record_hash, principal_type, principal_id,
            reporting_scope_id, root_scope_id, operation, outcome
        ) VALUES ('customer-access', repeat('9', 64), repeat('3', 64), 'user', 'user-three', client_scope_id, root_scope_id, 'report.read', 'allowed');
        RAISE EXCEPTION 'audit chain trigger did not reject a broken chain';
    EXCEPTION WHEN OTHERS THEN
        IF position('does not continue' IN lower(SQLERRM)) = 0 THEN
            RAISE;
        END IF;
    END;
END;
$$;

ALTER TABLE analytics.analytics_event FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.analytics_audit_record FORCE ROW LEVEL SECURITY;
SELECT analytics.set_authorization_context(ARRAY[:a06_client_one_scope_id]::BIGINT[], 'a06-grant');

DO $$
DECLARE
    visible_events BIGINT;
    visible_audits BIGINT;
BEGIN
    SELECT COUNT(*) INTO visible_events FROM analytics.analytics_event;
    SELECT COUNT(*) INTO visible_audits FROM analytics.analytics_audit_record;
    IF visible_events <> 1 THEN
        RAISE EXCEPTION 'expected one authorized event, got %', visible_events;
    END IF;
    IF visible_audits <> 1 THEN
        RAISE EXCEPTION 'expected one authorized audit record, got %', visible_audits;
    END IF;
END;
$$;

ROLLBACK;
