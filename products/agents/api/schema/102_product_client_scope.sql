ALTER TABLE agents_platform.product_conversations ADD COLUMN client_id text;
ALTER TABLE agents_platform.product_task_contexts ADD COLUMN client_id text;
ALTER TABLE agents_platform.product_conversations ADD CONSTRAINT product_conversation_client_scope
  CHECK (client_id IS NULL OR length(client_id) BETWEEN 1 AND 256);
ALTER TABLE agents_platform.product_task_contexts ADD CONSTRAINT product_task_client_scope
  CHECK (client_id IS NULL OR length(client_id) BETWEEN 1 AND 256);
CREATE INDEX product_client_conversations ON agents_platform.product_conversations(product,tenant_id,client_id,updated_at DESC,conversation_id);

CREATE TABLE agents_platform.product_capability_publications (
  product text NOT NULL,
  tenant_id text NOT NULL,
  revision text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product,tenant_id,revision),
  FOREIGN KEY (product,tenant_id) REFERENCES agents_platform.product_execution_tenants(product,tenant_id)
);
CREATE TRIGGER immutable_product_capability_publication BEFORE UPDATE OR DELETE ON agents_platform.product_capability_publications
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
