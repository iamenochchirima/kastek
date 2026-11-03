ALTER TABLE agents_platform.model_provider_connections
  ADD COLUMN managed_model_id text CHECK (managed_model_id IS NULL OR
    (custody='platform_managed' AND length(managed_model_id) BETWEEN 1 AND 512));
