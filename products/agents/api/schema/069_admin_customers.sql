CREATE TABLE agents_platform.admin_customer_operations (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  action text NOT NULL CHECK(action IN ('task.cancel','ingress.retry')),
  target_id uuid NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 8 AND 500),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','confirmed','rejected','failed','unknown')),
  code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_customer_operation_history ON agents_platform.admin_customer_operations(organization_id,id);
CREATE TABLE agents_platform.admin_customer_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_customer_nonce_expiry ON agents_platform.admin_customer_nonces(expires_at);
