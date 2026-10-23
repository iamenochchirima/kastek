CREATE TABLE admin_service_assertion_nonces (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX admin_service_assertion_nonces_expiry_idx ON admin_service_assertion_nonces(expires_at);
