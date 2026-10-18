ALTER TABLE agents_platform.task_events ADD COLUMN observation jsonb
  CHECK(observation->>'schemaVersion'='agent.observation.v1');
CREATE TABLE agents_platform.observation_exports (
  event_sequence bigint PRIMARY KEY REFERENCES agents_platform.task_events(sequence),
  observation_id text NOT NULL UNIQUE CHECK(observation_id ~ '^[a-f0-9]{64}$'),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  exported_at timestamptz
);
CREATE INDEX observation_export_pending ON agents_platform.observation_exports(available_at,event_sequence) WHERE exported_at IS NULL;
