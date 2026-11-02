CREATE TABLE agents_platform.evaluation_trial_channels (
  trial_id uuid PRIMARY KEY REFERENCES agents_platform.evaluation_trials(id),
  deployment_id uuid NOT NULL REFERENCES agents_platform.website_deployments(id),
  session_id uuid NOT NULL UNIQUE REFERENCES agents_platform.website_sessions(id),
  origin text NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  root_token_limit integer NOT NULL CHECK(root_token_limit BETWEEN 2048 AND 32000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_evaluation_channel BEFORE UPDATE OR DELETE ON agents_platform.evaluation_trial_channels
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
