CREATE TABLE agents_platform.channel_setup_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK(connection_revision>0),
  session_digest text NOT NULL,
  ticket_digest text NOT NULL UNIQUE,
  phase text NOT NULL CHECK(phase IN ('authorization','selection')),
  envelope jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  CHECK((consumed_at IS NULL AND envelope IS NOT NULL) OR (consumed_at IS NOT NULL AND envelope IS NULL))
);
CREATE INDEX channel_setup_expiry ON agents_platform.channel_setup_sessions(expires_at);
