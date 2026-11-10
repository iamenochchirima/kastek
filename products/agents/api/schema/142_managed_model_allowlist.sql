-- A platform-managed connection exposes an allowlist. `managed_model_id` remains its default model.
ALTER TABLE agents_platform.model_provider_connections
  ADD COLUMN managed_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE agents_platform.model_provider_connections
   SET managed_model_ids = jsonb_build_array(managed_model_id)
 WHERE managed_model_id IS NOT NULL
   AND managed_model_ids = '[]'::jsonb;

ALTER TABLE agents_platform.model_provider_connections
  ADD CONSTRAINT model_provider_managed_model_ids
  CHECK (
    jsonb_typeof(managed_model_ids)='array'
    AND jsonb_array_length(managed_model_ids) <= 64
    AND (managed_model_ids='[]'::jsonb OR custody='platform_managed')
  );
