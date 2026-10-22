ALTER TABLE agents_platform.google_calendar_connections RENAME TO native_provider_connections;
ALTER TABLE agents_platform.google_calendar_oauth_attempts RENAME TO native_provider_oauth_attempts;
ALTER TABLE agents_platform.native_provider_connections
 ADD COLUMN provider_id text NOT NULL DEFAULT 'google-calendar',
 ADD COLUMN selected_operations text[] NOT NULL DEFAULT ARRAY['calendar.availability','calendar.book'],
 ADD COLUMN binding_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN current_oauth_attempt_id uuid,
 ADD COLUMN last_verified_at timestamptz;
ALTER TABLE agents_platform.native_provider_connections ALTER COLUMN provider_id DROP DEFAULT;
ALTER TABLE agents_platform.native_provider_connections ALTER COLUMN selected_operations DROP DEFAULT;
ALTER TABLE agents_platform.native_provider_connections DROP CONSTRAINT google_calendar_connections_status_check;
ALTER TABLE agents_platform.native_provider_connections ADD CONSTRAINT native_provider_status CHECK(status IN ('authorization_required','calendar_required','selection_required','ready','reconnect_required','disconnected'));
ALTER TABLE agents_platform.connections DROP CONSTRAINT connection_profile;
ALTER TABLE agents_platform.connections ADD CONSTRAINT connection_profile CHECK(profile_id IN
 ('report-delivery-v1','github-public-read-v1','stash-read-v1','public-repository-read-v1','remote-mcp-v1','custom-api-v1','google-calendar-v1','microsoft-calendar-v1','hubspot-contacts-v1'));
ALTER TABLE agents_platform.connections DROP CONSTRAINT provider_target;
ALTER TABLE agents_platform.connections ADD CONSTRAINT provider_target CHECK(
 (profile_id='report-delivery-v1' AND target_id NOT LIKE 'provider:%') OR
 (profile_id='github-public-read-v1' AND target_id='provider:github') OR
 (profile_id='stash-read-v1' AND target_id='provider:stash') OR
 (profile_id='public-repository-read-v1' AND target_id='provider:public-repository') OR
 (profile_id='remote-mcp-v1' AND target_id='provider:remote-mcp') OR
 (profile_id='custom-api-v1' AND target_id='provider:custom-api') OR
 (profile_id IN ('google-calendar-v1','microsoft-calendar-v1','hubspot-contacts-v1')
  AND target_id ~ '^provider:[a-z][a-z0-9_.-]{0,99}$'));
