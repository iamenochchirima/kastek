-- Let the worker retire queued projection work after its scope or root is deleted.
-- The existing scope guard still blocks every other update for deleted scopes.

CREATE OR REPLACE FUNCTION analytics.validate_scope_bound_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_root_scope_id BIGINT;
    scope_status TEXT;
    root_status TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND TG_TABLE_SCHEMA = 'analytics'
       AND TG_TABLE_NAME = 'analytics_projection_work' THEN
        IF OLD.work_status IN ('pending', 'leased', 'failed')
           AND NEW.work_status = 'cancelled'
           AND NEW.lease_owner IS NULL
           AND NEW.lease_expires_at IS NULL
           AND NEW.completed_at IS NULL
           AND NEW.last_error_code = 'scope_deleted'
           AND NEW.last_error_message = 'Projection cancelled because its scope or root was deleted'
           AND (to_jsonb(NEW) - ARRAY[
               'work_status', 'lease_owner', 'lease_expires_at', 'last_error_code',
               'last_error_message', 'completed_at', 'updated_at'
           ]) = (to_jsonb(OLD) - ARRAY[
               'work_status', 'lease_owner', 'lease_expires_at', 'last_error_code',
               'last_error_message', 'completed_at', 'updated_at'
           ]) THEN
            SELECT child.root_scope_id, child.status, root_scope.status
            INTO expected_root_scope_id, scope_status, root_status
            FROM analytics.reporting_scope AS child
            JOIN analytics.reporting_scope AS root_scope
              ON root_scope.scope_id = child.root_scope_id
            WHERE child.scope_id = NEW.reporting_scope_id;

            IF FOUND AND (scope_status = 'deleted' OR root_status = 'deleted') THEN
                RETURN NEW;
            END IF;
        END IF;
    END IF;

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
