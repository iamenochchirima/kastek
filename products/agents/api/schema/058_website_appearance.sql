ALTER TABLE agents_platform.website_deployments
  ADD COLUMN appearance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(appearance)='object'),
  ADD COLUMN paused boolean NOT NULL DEFAULT false;
