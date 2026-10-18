CREATE TABLE agents_platform.capacity_buckets (
 key text PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 256),
 max_active integer NOT NULL CHECK(max_active BETWEEN 1 AND 100000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agents_platform.capacity_requests (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
 task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
 bucket_keys text[] NOT NULL CHECK(cardinality(bucket_keys) BETWEEN 1 AND 8),
 workload text NOT NULL CHECK(workload IN ('interactive','background','ingestion','sandbox','evaluation')),
 state text NOT NULL CHECK(state IN ('waiting','granted','active','uncertain','released','rejected')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz NOT NULL,
 granted_at timestamptz,
 lease_until timestamptz,
 finished_at timestamptz,
 error_code text
);
CREATE INDEX capacity_waiters ON agents_platform.capacity_requests(created_at,id) WHERE state='waiting';
CREATE INDEX capacity_task ON agents_platform.capacity_requests(task_id,state);
CREATE TABLE agents_platform.capacity_holds (
 request_id text NOT NULL REFERENCES agents_platform.capacity_requests(id),
 bucket_key text NOT NULL REFERENCES agents_platform.capacity_buckets(key),
 generation integer NOT NULL,
 PRIMARY KEY(request_id,bucket_key)
);
CREATE INDEX capacity_bucket_active ON agents_platform.capacity_holds(bucket_key);
CREATE TABLE agents_platform.capacity_notifications (
 request_id text NOT NULL REFERENCES agents_platform.capacity_requests(id),
 generation integer NOT NULL,
 task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner uuid,
 lease_until timestamptz,
 dispatched_at timestamptz,
 PRIMARY KEY(request_id,generation)
);
CREATE INDEX capacity_notification_due ON agents_platform.capacity_notifications(available_at) WHERE dispatched_at IS NULL;
ALTER TABLE agents_platform.task_controls ADD COLUMN lease_owner uuid, ADD COLUMN lease_until timestamptz;
CREATE INDEX task_controls_due ON agents_platform.task_controls(task_id,generation) WHERE dispatched_at IS NULL;
CREATE INDEX task_outbox_fair ON agents_platform.task_outbox(available_at,created_at,task_id) WHERE dispatched_at IS NULL;
CREATE TABLE agents_platform.scheduling_tenants (
 organization_id uuid PRIMARY KEY REFERENCES agents_platform.organizations(id),
 last_dispatch_at timestamptz NOT NULL DEFAULT 'epoch',
 last_capacity_at timestamptz NOT NULL DEFAULT 'epoch'
);
CREATE FUNCTION agents_platform.register_scheduling_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO agents_platform.scheduling_tenants(organization_id) VALUES(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER organizations_scheduler AFTER INSERT ON agents_platform.organizations FOR EACH ROW EXECUTE FUNCTION agents_platform.register_scheduling_tenant();
CREATE INDEX scheduling_dispatch_turn ON agents_platform.scheduling_tenants(last_dispatch_at,organization_id);
CREATE INDEX scheduling_capacity_turn ON agents_platform.scheduling_tenants(last_capacity_at,organization_id);
