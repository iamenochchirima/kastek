-- Reporting connections may persist only the authenticated transaction's grant.
-- Product facts, assignments and projection writes remain unavailable to this role.
DROP POLICY IF EXISTS reporting_grant_authorized_insert ON analytics.reporting_grant;
CREATE POLICY reporting_grant_authorized_insert ON analytics.reporting_grant
FOR INSERT WITH CHECK (
    analytics.scope_is_authorized(scope_id)
    AND grant_id = current_setting('analytics.authorization_grant_id', true)
);
