ALTER TABLE agents_platform.memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE agents_platform.memberships
  ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member'));

ALTER TABLE agents_platform.memberships
  ADD COLUMN IF NOT EXISTS role_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS role_changed_by uuid REFERENCES agents_platform.accounts(id);

ALTER TABLE agents_platform.organization_invitations DROP CONSTRAINT organization_invitations_role_check;
ALTER TABLE agents_platform.organization_invitations
  ADD CONSTRAINT organization_invitations_role_check CHECK (role IN ('owner', 'admin', 'member'));

ALTER TABLE agents_platform.accounts
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_verified_source text
    CHECK (email_verified_source IS NULL OR email_verified_source IN ('keycloak'));
