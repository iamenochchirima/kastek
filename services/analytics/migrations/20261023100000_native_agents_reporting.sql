INSERT INTO analytics.scope_kind_registry(scope_kind,major_version,owner_source_service,parent_scope_kind,allows_children)
 VALUES ('agents_organization',1,'agent-platform',NULL,FALSE) ON CONFLICT(scope_kind) DO NOTHING;
UPDATE analytics.producer SET permitted_record_categories='["event","observation","scope_definition"]'::jsonb,
 permitted_scope_kinds='["core_organization","tenant_workspace","tenant_client","agents_organization"]'::jsonb
 WHERE producer_id='agent-platform-customer-analytics';
