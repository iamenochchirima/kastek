CREATE TABLE agents_platform.applications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  agent_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (organization_id, id)
);

CREATE TABLE agents_platform.application_credentials (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['agents:read']::text[] AND cardinality(scopes) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, application_id) REFERENCES agents_platform.applications(organization_id, id)
);
