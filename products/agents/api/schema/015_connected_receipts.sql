CREATE TABLE agents_platform.connected_reads (
 operation_id text PRIMARY KEY REFERENCES agents_platform.operations(id),task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
 organization_id uuid NOT NULL,root_task_id uuid NOT NULL,connection_id uuid NOT NULL REFERENCES agents_platform.connections(id),
 binding_id uuid NOT NULL REFERENCES agents_platform.capability_bindings(id),request_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('started','completed','failed','uncertain')),result jsonb,error_code text,
 claim_token uuid,claim_expires_at timestamptz,
 CHECK ((claim_token IS NULL)=(claim_expires_at IS NULL)),
 body_key text,body_digest text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id)
);
CREATE TABLE agents_platform.connected_attempts (
 operation_id text NOT NULL REFERENCES agents_platform.connected_reads(operation_id),ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 7),
 phase text NOT NULL CHECK(phase IN ('setup','read')),state text NOT NULL CHECK(state IN ('started','completed')),
 receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(operation_id,ordinal)
);
CREATE TABLE agents_platform.connected_handles (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,root_task_id uuid NOT NULL,connection_id uuid NOT NULL REFERENCES agents_platform.connections(id),
 policy_revision integer NOT NULL,resource jsonb NOT NULL,kind text NOT NULL CHECK(kind IN ('revision','file','release')),
 digest text NOT NULL,payload jsonb NOT NULL,created_by_operation text NOT NULL REFERENCES agents_platform.connected_reads(operation_id),
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id),
 UNIQUE(root_task_id,connection_id,policy_revision,kind,digest)
);
CREATE INDEX connected_handle_root ON agents_platform.connected_handles(root_task_id);
CREATE TRIGGER immutable_connected_handle BEFORE UPDATE OR DELETE ON agents_platform.connected_handles
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.connected_discoveries (
 organization_id uuid NOT NULL,account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),operation_id text NOT NULL,
 connection_id uuid NOT NULL REFERENCES agents_platform.connections(id),request_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('started','completed','failed','uncertain')),result jsonb,error_code text,
 attempts jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,account_id,operation_id)
);
CREATE TABLE agents_platform.connected_response_bodies (
 operation_id text NOT NULL REFERENCES agents_platform.connected_reads(operation_id),ordinal integer NOT NULL,
 object_key text NOT NULL UNIQUE,content_digest text NOT NULL,provider_digest text NOT NULL,observed_at timestamptz NOT NULL,
 PRIMARY KEY(operation_id,ordinal)
);
CREATE TRIGGER immutable_connected_response BEFORE UPDATE OR DELETE ON agents_platform.connected_response_bodies
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE FUNCTION agents_platform.preserve_connected_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN ('completed','failed','uncertain') THEN RAISE EXCEPTION 'connected receipt is immutable'; END IF;
 IF TG_TABLE_NAME='connected_reads' THEN
  IF (to_jsonb(NEW)-ARRAY['state','result','error_code','body_key','body_digest','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','result','error_code','body_key','body_digest','updated_at'])
   THEN RAISE EXCEPTION 'connected claim identity is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_connected_receipt BEFORE UPDATE OR DELETE ON agents_platform.connected_reads
 FOR EACH ROW EXECUTE FUNCTION agents_platform.preserve_connected_receipt();
CREATE FUNCTION agents_platform.preserve_connected_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='completed' THEN RAISE EXCEPTION 'connected attempt receipt is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_connected_attempt BEFORE UPDATE OR DELETE ON agents_platform.connected_attempts
 FOR EACH ROW EXECUTE FUNCTION agents_platform.preserve_connected_attempt();
CREATE TRIGGER immutable_connected_discovery BEFORE UPDATE OR DELETE ON agents_platform.connected_discoveries
 FOR EACH ROW EXECUTE FUNCTION agents_platform.preserve_connected_receipt();
