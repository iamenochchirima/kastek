-- Each browser authorization attempt is short-lived and consumed exactly once.
-- Only the opaque transaction token enters its HttpOnly browser cookie.
CREATE TABLE platform_login_transactions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX platform_login_transactions_expiry_idx ON platform_login_transactions(expires_at);
