ALTER TABLE agents_platform.connections DROP CONSTRAINT connection_profile;
ALTER TABLE agents_platform.connections ADD CONSTRAINT connection_profile CHECK(profile_id IN
 ('report-delivery-v1','github-public-read-v1','stash-read-v1','public-repository-read-v1','remote-mcp-v1','custom-api-v1','google-calendar-v1'));
CREATE TABLE agents_platform.google_calendar_connections (
 connection_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'authorization_required' CHECK(status IN ('authorization_required','calendar_required','ready','reconnect_required','disconnected')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 sharing text NOT NULL DEFAULT 'private' CHECK(sharing IN ('private','organization_service')),
 account_subject text, account_email text, selected_calendar jsonb,
 token_expires_at timestamptz, granted_scopes text[] NOT NULL DEFAULT '{}',
 refresh_lease uuid, refresh_started_at timestamptz, last_error text,
 FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.connections(organization_id,id),
 CHECK((account_subject IS NULL)=(account_email IS NULL)),
 CHECK(selected_calendar IS NULL OR (jsonb_typeof(selected_calendar)='object' AND selected_calendar ?& ARRAY['id','name','timeZone','role'])),
 CHECK((refresh_lease IS NULL)=(refresh_started_at IS NULL))
);
CREATE TABLE agents_platform.google_calendar_oauth_attempts (
 id uuid PRIMARY KEY,
 connection_id uuid NOT NULL REFERENCES agents_platform.google_calendar_connections(connection_id),
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 envelope jsonb NOT NULL, generation integer NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agents_platform.connections DROP CONSTRAINT provider_target;
ALTER TABLE agents_platform.connections ADD CONSTRAINT provider_target CHECK(
 (profile_id='report-delivery-v1' AND target_id NOT LIKE 'provider:%') OR
 (profile_id='github-public-read-v1' AND target_id='provider:github') OR
 (profile_id='stash-read-v1' AND target_id='provider:stash') OR
 (profile_id='public-repository-read-v1' AND target_id='provider:public-repository') OR
 (profile_id='remote-mcp-v1' AND target_id='provider:remote-mcp') OR
 (profile_id='custom-api-v1' AND target_id='provider:custom-api') OR
 (profile_id='google-calendar-v1' AND target_id='provider:google-calendar'));
