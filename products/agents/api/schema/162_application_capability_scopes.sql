ALTER TABLE agents_platform.application_credentials
  DROP CONSTRAINT application_credentials_scopes_check;

ALTER TABLE agents_platform.application_credentials
  ADD CONSTRAINT application_credentials_scopes_check
  CHECK (scopes <@ ARRAY['agents:read','agents:manage','agents:publish','connections:manage',
    'runs:start','runs:read','runs:control','reviews:decide']::text[] AND cardinality(scopes) > 0);
