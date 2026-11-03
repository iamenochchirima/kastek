-- Provenance for capability-only three-way upgrades. It grants no execution authority.
ALTER TABLE agents_platform.product_execution_features
  ADD COLUMN managed_capability_baseline jsonb
  CHECK (managed_capability_baseline IS NULL OR jsonb_typeof(managed_capability_baseline)='object');
