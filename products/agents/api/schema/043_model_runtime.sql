CREATE TABLE agents_platform.task_model_routes (
 task_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 routes jsonb NOT NULL CHECK(jsonb_typeof(routes)='object'),
 snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
 UNIQUE(organization_id,task_id)
);
CREATE TRIGGER immutable_task_model_routes BEFORE UPDATE OR DELETE ON agents_platform.task_model_routes
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

-- Provider-native thinking, signatures and continuation remain private to the worker.
CREATE TABLE agents_platform.private_model_continuations (
 operation_id text PRIMARY KEY,
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('primary','compaction','delegated')),
 route_binding_digest text NOT NULL CHECK(route_binding_digest ~ '^[a-f0-9]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('started','completed','rejected','uncertain')),
 assistant_digest text CHECK(assistant_digest ~ '^[a-f0-9]{64}$'),
 tool_call_ids text[] NOT NULL DEFAULT '{}',
 native_state jsonb,
 native_state_digest text CHECK(native_state_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.task_model_routes(organization_id,task_id),
 FOREIGN KEY(task_id,operation_id) REFERENCES agents_platform.operations(task_id,id),
 CHECK((state='completed' AND assistant_digest IS NOT NULL AND native_state IS NOT NULL AND native_state_digest IS NOT NULL AND completed_at IS NOT NULL)
    OR (state<>'completed' AND assistant_digest IS NULL AND native_state IS NULL AND native_state_digest IS NULL)),
 CHECK(native_state IS NULL OR jsonb_typeof(native_state)='object')
);
CREATE INDEX private_model_history ON agents_platform.private_model_continuations(task_id,route_binding_digest,assistant_digest)
 WHERE state='completed' AND role<>'compaction';

CREATE FUNCTION agents_platform.protect_private_model_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'started' OR NEW.state='started'
   OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
   OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.role IS DISTINCT FROM OLD.role
   OR NEW.route_binding_digest IS DISTINCT FROM OLD.route_binding_digest OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
 THEN RAISE EXCEPTION 'Private model operation identity and terminal state are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_private_model_continuation BEFORE UPDATE ON agents_platform.private_model_continuations
 FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_private_model_continuation();
