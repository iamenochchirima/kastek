-- Persist the execution identity of every installation. Ownership (system versus
-- organization) remains a separate concern; this field controls runtime and API
-- boundaries.
ALTER TABLE agent_installations
  ADD COLUMN IF NOT EXISTS execution_mode TEXT;

-- Existing installations predate the three-mode contract. Protected system
-- definitions are KasiAi/system-hosted; organization-owned definitions are the
-- existing KasiTek-hosted user-agent surface. External-connected installations
-- are created only by the dedicated external-agent flow after this migration.
UPDATE agent_installations ai
SET execution_mode = 'system_hosted'
FROM agent_definitions ad
WHERE ad.id = ai.agent_definition_id
  AND ad.owner_type = 'system'
  AND ad.protected = TRUE
  AND ai.execution_mode IS NULL;

UPDATE agent_installations ai
SET execution_mode = 'kasitek_hosted'
FROM agent_definitions ad
WHERE ad.id = ai.agent_definition_id
  AND ad.owner_type = 'organization'
  AND ai.execution_mode IS NULL;

-- A legacy installation must never remain usable without a mode. The updates
-- above cover the only two pre-mode definition ownership classes; fail loudly if
-- a malformed legacy row exists instead of assigning it an unsafe identity.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_installations WHERE execution_mode IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill execution_mode for every agent installation';
  END IF;
END $$;

ALTER TABLE agent_installations
  ALTER COLUMN execution_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_installations_execution_mode_check'
      AND conrelid = 'agent_installations'::regclass
  ) THEN
    ALTER TABLE agent_installations
      ADD CONSTRAINT agent_installations_execution_mode_check
      CHECK (execution_mode IN ('system_hosted', 'kasitek_hosted', 'external_connected'));
  END IF;
END $$;

COMMENT ON COLUMN agent_installations.execution_mode IS
  'Runtime identity: system_hosted (KasiAi), kasitek_hosted (KasiTek-run user agent), or external_connected (customer runtime calling KasiTek).';

CREATE INDEX IF NOT EXISTS agent_installations_mode_status_idx
  ON agent_installations (organization_id, execution_mode, status, updated_at DESC);
