CREATE TABLE agents_platform.model_provider_defaults (
  organization_id uuid PRIMARY KEY REFERENCES agents_platform.organizations(id),
  connection_id uuid NOT NULL,
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  use_grant_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  updated_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id),
  FOREIGN KEY (organization_id,use_grant_id) REFERENCES agents_platform.model_provider_use_grants(organization_id,id)
);

CREATE TABLE agents_platform.model_provider_verifications (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision>0),
  credential_revision integer NOT NULL CHECK (credential_revision>0),
  endpoint text NOT NULL,
  protocol text NOT NULL,
  model_id text NOT NULL,
  model_revision text NOT NULL,
  verification text NOT NULL CHECK (verification IN ('inference_verified','tools_verified')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,connection_id,connection_revision,credential_revision,model_id),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id)
);
