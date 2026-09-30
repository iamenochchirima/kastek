-- A-10 correction: derived rows use target_scope_id rather than the source-fact column name.

CREATE OR REPLACE FUNCTION analytics.validate_target_scope_bound_record()
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
    WHERE child.scope_id = NEW.target_scope_id;

    IF NOT FOUND OR scope_status = 'deleted' OR root_status = 'deleted' THEN
        RAISE EXCEPTION 'Reporting target scope % is not available for analytics projection', NEW.target_scope_id;
    END IF;

    IF NEW.root_scope_id <> expected_root_scope_id THEN
        RAISE EXCEPTION
            'Analytics projection root scope % does not match target scope % root %',
            NEW.root_scope_id,
            NEW.target_scope_id,
            expected_root_scope_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS analytics_projection_contribution_scope_validate_trigger
    ON analytics.analytics_projection_contribution;
CREATE TRIGGER analytics_projection_contribution_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_projection_contribution
FOR EACH ROW EXECUTE FUNCTION analytics.validate_target_scope_bound_record();

DROP TRIGGER IF EXISTS analytics_projection_rollup_scope_validate_trigger
    ON analytics.analytics_projection_rollup;
CREATE TRIGGER analytics_projection_rollup_scope_validate_trigger
BEFORE INSERT OR UPDATE ON analytics.analytics_projection_rollup
FOR EACH ROW EXECUTE FUNCTION analytics.validate_target_scope_bound_record();
