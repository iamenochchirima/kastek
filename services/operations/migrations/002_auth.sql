CREATE SCHEMA IF NOT EXISTS operations;
CREATE TABLE IF NOT EXISTS operations.admin_principals (
  admin_id text PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer','support','security','operator','admin','owner','superadmin')),
  name text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE TABLE IF NOT EXISTS operations.login_transactions (
  token_hash text PRIMARY KEY, state text NOT NULL, nonce text NOT NULL, verifier text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS operations.admin_sessions (
  token_hash text PRIMARY KEY, admin_id text NOT NULL REFERENCES operations.admin_principals(admin_id),
  principal_revision integer NOT NULL, provider_sid text, refresh_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, refresh_after timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_sessions_principal ON operations.admin_sessions(admin_id);
CREATE TABLE IF NOT EXISTS operations.logout_tokens (jti text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE OR REPLACE FUNCTION operations.revise_principal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.issuer,NEW.subject,NEW.role,NEW.active) IS DISTINCT FROM (OLD.issuer,OLD.subject,OLD.role,OLD.active) THEN
    NEW.revision := OLD.revision+1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS principal_revision ON operations.admin_principals;
CREATE TRIGGER principal_revision BEFORE UPDATE ON operations.admin_principals FOR EACH ROW EXECUTE FUNCTION operations.revise_principal();
CREATE TABLE IF NOT EXISTS operations.principal_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, admin_id text NOT NULL REFERENCES operations.admin_principals(admin_id),
  operator_id text NOT NULL, reason text NOT NULL, active boolean NOT NULL, role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
