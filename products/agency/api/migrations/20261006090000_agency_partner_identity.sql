CREATE TABLE IF NOT EXISTS agency_partners (
    id TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_agency_partners_email
    ON agency_partners (lower(email));

CREATE TABLE IF NOT EXISTS agency_partner_auth_flows (
    state_hash TEXT PRIMARY KEY,
    browser_token_hash TEXT NOT NULL UNIQUE,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    return_path TEXT NOT NULL DEFAULT '/app/businesses',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agency_partner_auth_flows_expires_at
    ON agency_partner_auth_flows (expires_at);

CREATE TABLE IF NOT EXISTS agency_partner_sessions (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL REFERENCES agency_partners(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    provider_sid TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agency_partner_sessions_partner_id
    ON agency_partner_sessions (partner_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_agency_partner_sessions_provider_sid
    ON agency_partner_sessions (provider_sid)
    WHERE provider_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS agency_partner_memberships (
    partner_id TEXT NOT NULL REFERENCES agency_partners(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tenant_user_id TEXT NOT NULL UNIQUE REFERENCES tenant_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role = 'owner'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (partner_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_agency_partner_memberships_workspace_id
    ON agency_partner_memberships (workspace_id);

CREATE TABLE IF NOT EXISTS agency_partner_business_requests (
    partner_id TEXT NOT NULL REFERENCES agency_partners(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (partner_id, request_key)
);

-- Provider-owned partners use this role projection for existing Agency ACLs.
-- A NULL password hash means this account can never authenticate through the
-- workspace email/password login route.
ALTER TABLE tenant_users ALTER COLUMN password_hash DROP NOT NULL;
