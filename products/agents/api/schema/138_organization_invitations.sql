ALTER TABLE agents_platform.memberships
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE agents_platform.organization_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES agents_platform.accounts(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX organization_invitations_pending_email
  ON agents_platform.organization_invitations(organization_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX organization_invitations_organization
  ON agents_platform.organization_invitations(organization_id, created_at DESC);

CREATE INDEX organization_invitations_token
  ON agents_platform.organization_invitations(token_hash);
