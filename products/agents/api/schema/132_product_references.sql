CREATE TABLE agents_platform.product_references (
  id text PRIMARY KEY CHECK (id ~ '^aref_[A-Za-z0-9_-]{43}$'),
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id) ON DELETE CASCADE,
  product text NOT NULL,
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES agents_platform.conversations(id) ON DELETE CASCADE,
  source_task_id uuid NOT NULL,
  root_task_id uuid NOT NULL,
  source_operation_id text NOT NULL,
  binding_id uuid NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  principal_digest text NOT NULL CHECK (principal_digest ~ '^[a-f0-9]{64}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512),
  display_label text CHECK (display_label IS NULL OR length(display_label) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, source_task_id) REFERENCES agents_platform.tasks(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, root_task_id) REFERENCES agents_platform.tasks(organization_id, id) ON DELETE CASCADE,
  UNIQUE (root_task_id, product, tenant_id, principal_digest, resource_type, resource_id)
);

CREATE INDEX product_references_conversation_scope
  ON agents_platform.product_references (organization_id, product, tenant_id, conversation_id, principal_digest, resource_type);
CREATE INDEX product_references_source_task
  ON agents_platform.product_references (source_task_id);
