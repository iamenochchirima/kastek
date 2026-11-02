ALTER TABLE agents_platform.connections DROP CONSTRAINT connection_profile;
ALTER TABLE agents_platform.connections DROP CONSTRAINT provider_target;
ALTER TABLE agents_platform.connections ADD CONSTRAINT connection_profile CHECK(profile_id IN
 ('report-delivery-v1','github-public-read-v1','stash-read-v1','public-repository-read-v1','remote-mcp-v1','custom-api-v1'));
ALTER TABLE agents_platform.connections ADD CONSTRAINT provider_target CHECK(
 (profile_id='report-delivery-v1' AND target_id NOT LIKE 'provider:%') OR
 (profile_id='github-public-read-v1' AND target_id='provider:github') OR
 (profile_id='stash-read-v1' AND target_id='provider:stash') OR
 (profile_id='public-repository-read-v1' AND target_id='provider:public-repository') OR
 (profile_id='remote-mcp-v1' AND target_id='provider:remote-mcp') OR
 (profile_id='custom-api-v1' AND target_id='provider:custom-api'));

CREATE TABLE agents_platform.connection_onboarding (
 connection_id uuid PRIMARY KEY REFERENCES agents_platform.connections(id),
 endpoint text NOT NULL CHECK(octet_length(endpoint)<=2048),
 auth_method text NOT NULL CHECK(auth_method IN ('auto','none','bearer','header','oauth')),
 header_name text,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN
  ('draft','checking','authorization_required','authenticating','discovering','selection_required','ready','reconnect_required','unsupported','failed','disconnected')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 last_error text,
 verified_identity jsonb,
 lease_id uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE TABLE agents_platform.connection_oauth_attempts (
 id uuid PRIMARY KEY,
 connection_id uuid NOT NULL REFERENCES agents_platform.connection_onboarding(connection_id),
 account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 state_digest text NOT NULL UNIQUE CHECK(length(state_digest)=64),
 generation integer NOT NULL,
 envelope jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','exchanging','completed','failed')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_onboarding_owner ON agents_platform.connections(organization_id,account_id,created_at,id);
CREATE INDEX connection_oauth_expiry ON agents_platform.connection_oauth_attempts(expires_at) WHERE state='pending';
