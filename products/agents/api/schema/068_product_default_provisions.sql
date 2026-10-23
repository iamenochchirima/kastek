CREATE TABLE agents_platform.product_default_provisions (
  product text NOT NULL,
  tenant_id text NOT NULL,
  profile_id text NOT NULL,
  profile_revision text NOT NULL,
  defaults_revision text NOT NULL,
  profile_digest text NOT NULL CHECK(profile_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(product,tenant_id),
  FOREIGN KEY(product,tenant_id) REFERENCES agents_platform.product_execution_tenants(product,tenant_id)
);
