CREATE TABLE agents_platform.growth_capability_publications (
  product text NOT NULL DEFAULT 'growth' CHECK(product='growth'),
  tenant_id text NOT NULL,
  revision text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  publication jsonb NOT NULL,
  issuer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, revision),
  UNIQUE (tenant_id, digest),
  FOREIGN KEY (product,tenant_id) REFERENCES agents_platform.product_execution_tenants(product,tenant_id)
);

ALTER TABLE agents_platform.product_execution_features ADD COLUMN managed_defaults_revision text;
ALTER TABLE agents_platform.product_execution_features ADD COLUMN managed_configuration_digest text CHECK(managed_configuration_digest IS NULL OR managed_configuration_digest ~ '^[a-f0-9]{64}$');
