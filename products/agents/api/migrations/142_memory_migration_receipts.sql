-- Per-record migration receipts make legacy backfill resumable, auditable,
-- and safe to rerun. A receipt never stores the legacy message body.

CREATE TABLE IF NOT EXISTS agent_memory_migration_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL CHECK (length(trim(organization_id)) BETWEEN 1 AND 240),
  legacy_memory_id UUID NOT NULL,
  source_checksum TEXT NOT NULL CHECK (length(trim(source_checksum)) = 64),
  status TEXT NOT NULL CHECK (status IN ('dry_run', 'migrated', 'skipped', 'failed')),
  skip_reason TEXT,
  canonical_fact_id UUID REFERENCES agent_memory_facts(id) ON DELETE SET NULL,
  canonical_revision_id UUID REFERENCES agent_memory_revisions(id) ON DELETE SET NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, legacy_memory_id)
);

CREATE INDEX IF NOT EXISTS agent_memory_migration_receipts_status_idx
  ON agent_memory_migration_receipts (organization_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION kasitek_touch_memory_migration_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_migration_receipts_updated_at_trigger ON agent_memory_migration_receipts;
CREATE TRIGGER agent_memory_migration_receipts_updated_at_trigger
BEFORE UPDATE ON agent_memory_migration_receipts
FOR EACH ROW EXECUTE FUNCTION kasitek_touch_memory_migration_receipt();

ALTER TABLE agent_memory_migration_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_migration_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_memory_migration_receipts_scope ON agent_memory_migration_receipts;
CREATE POLICY agent_memory_migration_receipts_scope ON agent_memory_migration_receipts
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR organization_id = current_setting('kasitek.organization_id', true))
  WITH CHECK (kasitek_agents_operator_scope() OR organization_id = current_setting('kasitek.organization_id', true));
