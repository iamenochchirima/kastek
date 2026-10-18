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
CREATE INDEX capacity_waiting_buckets ON agents_platform.capacity_requests USING gin(bucket_keys) WHERE state='waiting';
CREATE INDEX capacity_waiters ON agents_platform.capacity_requests(created_at,id) WHERE state='waiting';
CREATE INDEX capacity_task ON agents_platform.capacity_requests(task_id,state);
CREATE FUNCTION agents_platform.immutable_capacity_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.max_active<>OLD.max_active THEN RAISE EXCEPTION 'Capacity limits are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_capacity_limit BEFORE UPDATE ON agents_platform.capacity_buckets FOR EACH ROW EXECUTE FUNCTION agents_platform.immutable_capacity_limit();
CREATE TABLE agents_platform.capacity_slot_ranges (
 bucket_key text PRIMARY KEY REFERENCES agents_platform.capacity_buckets(key),
 next_slot integer NOT NULL DEFAULT 1 CHECK(next_slot BETWEEN 1 AND 100001)
);
CREATE FUNCTION agents_platform.register_capacity_range() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO agents_platform.capacity_slot_ranges(bucket_key) VALUES(NEW.key); RETURN NEW; END $$;
CREATE TRIGGER register_capacity_range AFTER INSERT ON agents_platform.capacity_buckets FOR EACH ROW EXECUTE FUNCTION agents_platform.register_capacity_range();
CREATE TABLE agents_platform.capacity_slots (
 bucket_key text NOT NULL REFERENCES agents_platform.capacity_buckets(key),
 slot integer NOT NULL CHECK(slot BETWEEN 1 AND 100000),
 owner_request text REFERENCES agents_platform.capacity_requests(id),
 generation integer,
 PRIMARY KEY(bucket_key,slot),
 CHECK((owner_request IS NULL AND generation IS NULL) OR (owner_request IS NOT NULL AND generation>0))
);
CREATE INDEX capacity_free_slots ON agents_platform.capacity_slots(bucket_key,slot) WHERE owner_request IS NULL;
CREATE INDEX capacity_owned_slots ON agents_platform.capacity_slots(owner_request) WHERE owner_request IS NOT NULL;
CREATE FUNCTION agents_platform.validate_capacity_slot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer;
BEGIN
 SELECT max_active INTO STRICT maximum FROM agents_platform.capacity_buckets WHERE key=NEW.bucket_key FOR SHARE;
 IF NEW.slot>maximum THEN RAISE EXCEPTION 'Capacity slot exceeds immutable limit'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capacity_slot_bounds BEFORE INSERT OR UPDATE OF bucket_key,slot ON agents_platform.capacity_slots FOR EACH ROW EXECUTE FUNCTION agents_platform.validate_capacity_slot();
CREATE TABLE agents_platform.capacity_holds (
 request_id text NOT NULL REFERENCES agents_platform.capacity_requests(id),
 bucket_key text NOT NULL REFERENCES agents_platform.capacity_buckets(key),
 generation integer NOT NULL,
 slot integer NOT NULL,
 UNIQUE(bucket_key,slot),
 FOREIGN KEY(bucket_key,slot) REFERENCES agents_platform.capacity_slots(bucket_key,slot),
 PRIMARY KEY(request_id,bucket_key)
);
CREATE INDEX capacity_bucket_active ON agents_platform.capacity_holds(bucket_key);
CREATE FUNCTION agents_platform.reserve_capacity_slots(request text,request_generation integer,keys text[]) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE bucket text; maximum integer; position integer; selected integer; first_slot integer; last_slot integer;
BEGIN
 BEGIN
  FOREACH bucket IN ARRAY keys LOOP
   SELECT max_active INTO STRICT maximum FROM agents_platform.capacity_buckets WHERE key=bucket FOR SHARE;
   position:=(('x'||substr(md5(request||':'||bucket),1,8))::bit(32)::bigint % maximum)::integer;
   SELECT slot INTO selected FROM agents_platform.capacity_slots WHERE bucket_key=bucket AND owner_request IS NULL AND slot>position ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
   IF selected IS NULL THEN
    SELECT slot INTO selected FROM agents_platform.capacity_slots WHERE bucket_key=bucket AND owner_request IS NULL AND slot<=position ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
   END IF;
   IF selected IS NULL THEN
    WITH frontier AS (SELECT next_slot FROM agents_platform.capacity_slot_ranges WHERE bucket_key=bucket FOR UPDATE)
    UPDATE agents_platform.capacity_slot_ranges r SET next_slot=least(maximum+1,f.next_slot+32) FROM frontier f
    WHERE r.bucket_key=bucket AND f.next_slot<=maximum RETURNING f.next_slot,r.next_slot INTO first_slot,last_slot;
    IF first_slot IS NOT NULL THEN
     INSERT INTO agents_platform.capacity_slots(bucket_key,slot) SELECT bucket,generate_series(first_slot,last_slot-1);
     selected:=first_slot+(position%(last_slot-first_slot));
    ELSE
     SELECT slot INTO selected FROM agents_platform.capacity_slots WHERE bucket_key=bucket AND owner_request IS NULL ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
    END IF;
   END IF;
   IF selected IS NULL THEN RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='Capacity full'; END IF;
   UPDATE agents_platform.capacity_slots SET owner_request=request,generation=request_generation WHERE bucket_key=bucket AND slot=selected;
   INSERT INTO agents_platform.capacity_holds(request_id,bucket_key,generation,slot) VALUES(request,bucket,request_generation,selected);
  END LOOP;
 EXCEPTION WHEN SQLSTATE 'PZ001' THEN RETURN false;
 END;
 RETURN true;
END $$;

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
 INSERT INTO agents_platform.tenant_admission(organization_id) VALUES(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER organizations_scheduler AFTER INSERT ON agents_platform.organizations FOR EACH ROW EXECUTE FUNCTION agents_platform.register_scheduling_tenant();
CREATE INDEX scheduling_dispatch_turn ON agents_platform.scheduling_tenants(last_dispatch_at,organization_id);
CREATE INDEX scheduling_capacity_turn ON agents_platform.scheduling_tenants(last_capacity_at,organization_id);
CREATE TABLE agents_platform.tenant_admission (
 organization_id uuid PRIMARY KEY REFERENCES agents_platform.organizations(id),
 active_roots integer NOT NULL DEFAULT 0 CHECK(active_roots BETWEEN 0 AND 100000)
);
CREATE FUNCTION agents_platform.track_root_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_active integer:=0; new_active integer:=0; owner_id uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN
  owner_id:=OLD.organization_id;
  IF OLD.parent_task_id IS NULL AND OLD.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') THEN old_active:=1; END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  owner_id:=NEW.organization_id;
  IF NEW.parent_task_id IS NULL AND NEW.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') THEN new_active:=1; END IF;
 END IF;
 IF new_active<>old_active THEN
  UPDATE agents_platform.tenant_admission SET active_roots=active_roots+new_active-old_active WHERE organization_id=owner_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing tenant admission counter'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER tasks_active_roots AFTER INSERT OR UPDATE OF state,parent_task_id OR DELETE ON agents_platform.tasks
 FOR EACH ROW EXECUTE FUNCTION agents_platform.track_root_activity();
