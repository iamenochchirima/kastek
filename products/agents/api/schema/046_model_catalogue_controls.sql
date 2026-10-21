CREATE TABLE agents_platform.model_provider_catalogue_controls (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision>0),
  credential_revision integer NOT NULL CHECK (credential_revision>0),
  lease_id uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count>=0),
  error_code text,
  PRIMARY KEY (organization_id,connection_id,connection_revision,credential_revision),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id),
  CHECK ((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE TABLE agents_platform.model_provider_manual_models (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision>0),
  credential_revision integer NOT NULL CHECK (credential_revision>0),
  model_id text NOT NULL,
  descriptor jsonb NOT NULL CHECK (jsonb_typeof(descriptor)='object'),
  descriptor_digest text NOT NULL CHECK (descriptor_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,connection_id,connection_revision,credential_revision,model_id),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id)
);
