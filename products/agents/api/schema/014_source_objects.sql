CREATE TABLE agents_platform.source_objects (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 job_id uuid NOT NULL REFERENCES agents_platform.ingestion_jobs(id), object_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('raw','stage','text')),
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'), bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),
 state text NOT NULL CHECK(state IN ('writing','available','delete_pending','deleted')),
 write_token uuid NOT NULL, write_attempts integer NOT NULL CHECK(write_attempts BETWEEN 1 AND 3),
 write_lease_until timestamptz NOT NULL, put_ack_at timestamptz, write_error_at timestamptz, delete_ack_at timestamptz,
 next_cleanup_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_objects_cleanup ON agents_platform.source_objects(next_cleanup_at,write_lease_until);
