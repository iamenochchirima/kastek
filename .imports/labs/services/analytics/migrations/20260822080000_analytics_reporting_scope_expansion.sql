-- A-11: allow the reporting API to expand an already verified all-descendants grant without
-- making the application role owner of the scope tables. The function is called only after the
-- signed grant and persisted grant row have been matched.

CREATE OR REPLACE FUNCTION analytics.authorized_active_descendant_scope_ids(
    requested_ancestor_scope_id BIGINT
)
RETURNS TABLE(scope_id BIGINT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = analytics, pg_catalog
AS $$
    SELECT hierarchy.descendant_scope_id AS scope_id
    FROM analytics.scope_ancestor AS hierarchy
    JOIN analytics.reporting_scope AS scope
      ON scope.scope_id = hierarchy.descendant_scope_id
    WHERE hierarchy.ancestor_scope_id = requested_ancestor_scope_id
      AND scope.status = 'active'
    ORDER BY hierarchy.descendant_scope_id
$$;

COMMENT ON FUNCTION analytics.authorized_active_descendant_scope_ids(BIGINT) IS
    'Expands a verified reporting grant root into active descendant scope IDs for RLS context setup';
