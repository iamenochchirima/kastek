-- The API verifies request-bound platform admin authority before calling this metadata-only function.
CREATE FUNCTION analytics.admin_reporting_roots(product TEXT, organization_id TEXT)
RETURNS TABLE(scope_id BIGINT,scope_kind TEXT,reporting_timezone TEXT,total_count BIGINT,authorized_scope_ids BIGINT[],scope_count BIGINT)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,analytics AS $$
 SELECT s.scope_id,s.scope_kind,s.reporting_timezone,count(*) OVER(),
 ARRAY(SELECT child.scope_id FROM analytics.reporting_scope child WHERE child.root_scope_id=s.scope_id AND child.status='active' ORDER BY child.scope_id LIMIT 100),
 (SELECT count(*) FROM analytics.reporting_scope child WHERE child.root_scope_id=s.scope_id AND child.status='active')
 FROM analytics.reporting_scope s
 WHERE s.status='active' AND s.parent_scope_id IS NULL
 AND ((product='growth' AND s.scope_kind='core_organization' AND s.owning_source_service='core')
   OR (product='agency' AND s.scope_kind='tenant_workspace' AND s.owning_source_service='tenant-platform')
   OR (product='agents' AND s.scope_kind='agents_organization' AND s.owning_source_service='agent-platform'))
 AND (organization_id IS NULL OR s.external_source_id=organization_id)
 ORDER BY s.scope_id LIMIT 100;
$$;
REVOKE ALL ON FUNCTION analytics.admin_reporting_roots(TEXT,TEXT) FROM PUBLIC;
CREATE TABLE analytics.admin_reporting_audit(
 id UUID PRIMARY KEY,actor_id TEXT NOT NULL,product TEXT NOT NULL,metric_keys TEXT[] NOT NULL,
 included_scopes INTEGER NOT NULL,total_scopes BIGINT NOT NULL,request_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON analytics.admin_reporting_audit FROM PUBLIC;
