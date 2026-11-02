CREATE TABLE agents_platform.channel_setup_claims (
  connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision > 0),
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('started','uncertain','complete')),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id)
);
