-- Aggregate metadata for platform administrators. No identifiers or content escape RLS.
CREATE FUNCTION analytics.admin_reporting_diagnostics()
RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,analytics AS $$
 SELECT jsonb_build_object(
 'registeredScopes',(SELECT count(*)::text FROM analytics.reporting_scope WHERE status='active'),
 'observedSourceAt',(SELECT max(latest_source_timestamp) FROM analytics.analytics_source_state),
 'ingestedAt',greatest((SELECT max(ingested_at) FROM analytics.analytics_event),(SELECT max(ingested_at) FROM analytics.analytics_metric_observation)),
 'checkpointAt',(SELECT max(updated_at) FROM analytics.analytics_projection_checkpoint),
 'completeThrough',NULL,
 'pending',(SELECT count(*)::text FROM analytics.analytics_projection_work WHERE work_status IN ('pending','leased')),
 'oldestPendingAt',(SELECT min(created_at) FROM analytics.analytics_projection_work WHERE work_status IN ('pending','leased')),
 'failed',(SELECT count(*)::text FROM analytics.analytics_projection_work WHERE work_status='failed'),
 'backfilling',(SELECT count(*)::text FROM analytics.analytics_projection_checkpoint WHERE processing_status='rebuilding'),
 'promotedGenerations',(SELECT count(*)::text FROM analytics.analytics_projection_checkpoint WHERE generation_id IS NOT NULL),
 'latestPromotedAt',(SELECT max(g.promoted_at) FROM analytics.analytics_projection_checkpoint c JOIN analytics.analytics_projection_generation g ON g.generation_id=c.generation_id),
 'sourceStates',COALESCE((SELECT jsonb_object_agg(availability_state,n) FROM (SELECT availability_state,count(*)::text n FROM analytics.analytics_source_state GROUP BY availability_state) s),'{}'::jsonb),
 'coverage','unknown');
$$;
REVOKE ALL ON FUNCTION analytics.admin_reporting_diagnostics() FROM PUBLIC;
