CREATE TABLE IF NOT EXISTS credential_vault (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'gemini')),
  label TEXT NOT NULL DEFAULT 'provider credential',
  encrypted_payload TEXT NOT NULL,
  funding_source TEXT NOT NULL DEFAULT 'user' CHECK (funding_source = 'user'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS credential_vault_scope_idx
  ON credential_vault (organization_id, provider, status, created_at DESC);
