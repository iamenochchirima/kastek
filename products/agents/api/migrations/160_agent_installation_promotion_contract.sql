-- Target-scoped Playground -> Live promotion evidence.
-- The existing deployment history remains the source of truth for pointer
-- movement; these nullable fields identify the promotion request that caused
-- a row and make retries safe without copying environment-owned secrets.

ALTER TABLE agent_installation_deployments
  ADD COLUMN IF NOT EXISTS source_installation_id UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS candidate_digest TEXT,
  ADD COLUMN IF NOT EXISTS extension_snapshot_checksum TEXT,
  ADD COLUMN IF NOT EXISTS binding_revision TEXT,
  ADD COLUMN IF NOT EXISTS promotion_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS agent_installation_deployments_promotion_idempotency_uidx
  ON agent_installation_deployments (organization_id, installation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_installation_deployments_source_idx
  ON agent_installation_deployments (organization_id, source_installation_id, created_at DESC)
  WHERE source_installation_id IS NOT NULL;

COMMENT ON COLUMN agent_installation_deployments.source_installation_id IS
  'Playground installation that supplied the immutable candidate for a promotion.';
COMMENT ON COLUMN agent_installation_deployments.idempotency_key IS
  'Caller supplied promotion key; retries cannot activate a different target.';
COMMENT ON COLUMN agent_installation_deployments.binding_revision IS
  'Opaque Live binding revision used for activation; secret values never enter evidence.';

ALTER TABLE agent_installation_deployments
  ADD CONSTRAINT agent_installation_deployments_promotion_source_org_fk
  FOREIGN KEY (source_installation_id) REFERENCES agent_installations(id) ON DELETE SET NULL;

ALTER TABLE agent_installation_deployments
  ADD CONSTRAINT agent_installation_deployments_promotion_digest_length
  CHECK (candidate_digest IS NULL OR length(candidate_digest) <= 256),
  ADD CONSTRAINT agent_installation_deployments_binding_revision_length
  CHECK (binding_revision IS NULL OR length(binding_revision) <= 256);
