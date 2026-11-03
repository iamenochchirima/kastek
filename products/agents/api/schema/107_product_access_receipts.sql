-- Product-owned access observations are private metadata, not model-visible tool output.
CREATE TABLE agents_platform.product_operation_access (
  operation_id text PRIMARY KEY REFERENCES agents_platform.operations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  binding_id uuid NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 1024),
  scope_reference text NOT NULL CHECK (length(scope_reference) BETWEEN 1 AND 1024),
  result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  information jsonb NOT NULL CHECK (jsonb_typeof(information) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_operation_access_task ON agents_platform.product_operation_access(task_id);
CREATE TRIGGER immutable_product_operation_access BEFORE UPDATE ON agents_platform.product_operation_access
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
