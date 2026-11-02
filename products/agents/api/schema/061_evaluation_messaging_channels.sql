CREATE TABLE agents_platform.evaluation_trial_messaging_channels (
  trial_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL UNIQUE,
  deployment_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('telegram','whatsapp','facebook','instagram')),
  mode text NOT NULL CHECK(mode IN ('bot','cloud_api','meta','instagram_login')),
  asset_id text NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  fixture jsonb NOT NULL CHECK(jsonb_typeof(fixture)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(trial_id,organization_id) REFERENCES agents_platform.evaluation_trials(id,organization_id),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  FOREIGN KEY(organization_id,deployment_id) REFERENCES agents_platform.channel_deployments(organization_id,id)
);
CREATE TRIGGER immutable_evaluation_messaging_channel BEFORE UPDATE OR DELETE ON agents_platform.evaluation_trial_messaging_channels
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.evaluation_channel_effects (
  id uuid PRIMARY KEY,
  trial_id uuid NOT NULL REFERENCES agents_platform.evaluation_trial_messaging_channels(trial_id),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('accepted','rejected','lost_ack')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_channel_effects_trial ON agents_platform.evaluation_channel_effects(trial_id,sequence);
