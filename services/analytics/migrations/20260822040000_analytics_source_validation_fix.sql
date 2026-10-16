-- A-09 follow-up: producer validation is shared by fact rows, quarantine rows, and scope
-- definition receipts. Those tables do not all have the same scope columns, so inspect the record
-- shape instead of dereferencing a field that is absent from receipt rows.

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
    candidate_scope_id BIGINT;
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

    IF to_jsonb(NEW) ? 'reporting_scope_id' THEN
        candidate_scope_id := NULLIF(to_jsonb(NEW)->>'reporting_scope_id', '')::BIGINT;
    END IF;
    IF candidate_scope_id IS NOT NULL THEN
        SELECT reporting_scope.scope_kind
        INTO scope_kind
        FROM analytics.reporting_scope
        WHERE reporting_scope.scope_id = candidate_scope_id;

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
