ALTER TABLE agents_platform.google_calendar_connections
 ADD COLUMN connector_digest text NOT NULL DEFAULT repeat('0',64) CHECK(connector_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE agents_platform.google_calendar_connections ALTER COLUMN connector_digest DROP DEFAULT;
ALTER TABLE agents_platform.google_calendar_oauth_attempts
 ADD COLUMN connector_digest text NOT NULL DEFAULT repeat('0',64) CHECK(connector_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE agents_platform.google_calendar_oauth_attempts ALTER COLUMN connector_digest DROP DEFAULT;
