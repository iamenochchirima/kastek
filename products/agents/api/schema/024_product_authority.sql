CREATE TABLE agents_platform.product_execution_tenants (
  product text NOT NULL CHECK(product IN ('growth','agencies')),
  tenant_id text NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 256),
  organization_id uuid NOT NULL UNIQUE REFERENCES agents_platform.organizations(id),
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 128),
  issuer text NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY(product,tenant_id),
  UNIQUE(product,organization_id,client_id,issuer)
);
CREATE TABLE agents_platform.product_execution_authorities (
  grant_id uuid PRIMARY KEY REFERENCES agents_platform.execution_grants(id),
  product text NOT NULL,
  organization_id uuid NOT NULL,
  client_id text NOT NULL,
  issuer text NOT NULL,
  assertion_digest text NOT NULL CHECK(assertion_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product,organization_id,client_id,issuer)
    REFERENCES agents_platform.product_execution_tenants(product,organization_id,client_id,issuer)
);
CREATE TRIGGER immutable_product_authority BEFORE UPDATE OR DELETE ON agents_platform.product_execution_authorities
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
