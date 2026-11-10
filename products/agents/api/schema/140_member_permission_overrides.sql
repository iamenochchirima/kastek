CREATE TABLE agents_platform.member_permission_overrides (
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  permission text NOT NULL CHECK (length(permission) BETWEEN 3 AND 64),
  effect text NOT NULL CHECK (effect IN ('grant', 'deny')),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, account_id, permission)
);

CREATE INDEX member_permission_overrides_account
  ON agents_platform.member_permission_overrides(organization_id, account_id);
