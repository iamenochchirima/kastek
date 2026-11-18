ALTER TABLE agents_platform.application_credentials
  DROP CONSTRAINT application_credentials_scopes_check;

ALTER TABLE agents_platform.application_credentials
  ADD CONSTRAINT application_credentials_scopes_check
  CHECK (scopes <@ ARRAY['agents:read','runs:start','runs:read','runs:control']::text[] AND cardinality(scopes) > 0);
