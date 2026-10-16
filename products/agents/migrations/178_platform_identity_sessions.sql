-- Human identity belongs to the provider; workspace access belongs to Agents.
-- These tables are accessed by the backend identity repository before tenant
-- context exists. Never expose a generic CRUD endpoint for them.
CREATE TABLE platform_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE platform_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_by UUID NOT NULL REFERENCES platform_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_memberships (
  organization_id UUID NOT NULL REFERENCES platform_organizations(id),
  account_id UUID NOT NULL REFERENCES platform_accounts(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (organization_id, account_id)
);
CREATE INDEX platform_memberships_account_idx ON platform_memberships (account_id)
  WHERE revoked_at IS NULL;

CREATE TABLE platform_browser_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id UUID NOT NULL REFERENCES platform_accounts(id),
  provider_session_id TEXT NOT NULL,
  active_organization_id UUID,
  authenticated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (active_organization_id, account_id)
    REFERENCES platform_memberships (organization_id, account_id),
  CHECK (absolute_expires_at > created_at),
  CHECK (absolute_expires_at <= authenticated_at + interval '30 days')
);
CREATE INDEX platform_browser_sessions_account_idx ON platform_browser_sessions(account_id);
CREATE INDEX platform_browser_sessions_provider_idx ON platform_browser_sessions(provider_session_id);
CREATE INDEX platform_browser_sessions_expiry_idx ON platform_browser_sessions(absolute_expires_at);
