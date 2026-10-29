CREATE TABLE agents_platform.support_presence (
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('available', 'away')),
  lease_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, account_id),
  FOREIGN KEY (organization_id, account_id) REFERENCES agents_platform.memberships(organization_id, account_id)
);
