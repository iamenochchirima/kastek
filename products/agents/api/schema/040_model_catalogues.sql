CREATE TABLE agents_platform.model_provider_catalogues (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision>0),
  credential_revision integer NOT NULL CHECK (credential_revision>0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,connection_id,connection_revision,credential_revision),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id)
);
