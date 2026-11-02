CREATE TABLE agents_platform.channel_setup_resource_claims (
  resource_digest text PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES agents_platform.channel_connections(id),
  claim_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('started','uncertain','complete')),
  expires_at timestamptz NOT NULL
);
CREATE TABLE agents_platform.channel_contact_consents (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  granted boolean NOT NULL,
  categories text[] NOT NULL,
  evidence jsonb NOT NULL,
  recorded_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,connection_id,recipient_id),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id)
);
