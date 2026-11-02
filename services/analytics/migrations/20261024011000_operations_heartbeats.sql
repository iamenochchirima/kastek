CREATE TABLE operations_worker_heartbeats (
 worker TEXT NOT NULL,
 instance TEXT NOT NULL,
 environment TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(worker,instance,environment)
);

CREATE FUNCTION analytics.operations_projection_overdue_seconds()
RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,analytics AS $$
 SELECT COALESCE(GREATEST(0,floor(extract(epoch FROM now()-min(CASE WHEN work_status='leased' THEN lease_expires_at ELSE available_at END))))::text,'0')
 FROM analytics.analytics_projection_work WHERE (work_status='pending' AND available_at<=now()) OR (work_status='leased' AND lease_expires_at<=now());
$$;
REVOKE ALL ON FUNCTION analytics.operations_projection_overdue_seconds() FROM PUBLIC;
