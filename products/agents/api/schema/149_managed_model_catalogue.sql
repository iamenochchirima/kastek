-- Managed connections now expose the full provider catalogue. An empty
-- managed_model_ids array means "no allowlist"; the configured managed_model_id
-- remains the connection's default model.
UPDATE agents_platform.model_provider_connections
SET managed_model_ids = '[]'::jsonb
WHERE custody = 'platform_managed'
  AND managed_model_ids <> '[]'::jsonb;
