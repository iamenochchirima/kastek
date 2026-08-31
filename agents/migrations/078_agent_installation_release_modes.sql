-- Make publication and installation deployment separate concepts. Existing
-- user-owned hosted installations follow the published version because that is
-- the behavior the hosted agent editor presents to users. System and external
-- installations keep their explicit version until their own rollout contract
-- is implemented.
ALTER TABLE agent_installations
  ADD COLUMN IF NOT EXISTS release_mode TEXT;

UPDATE agent_installations ai
SET release_mode = CASE
  WHEN ai.execution_mode = 'kasitek_hosted'
    AND ad.owner_type = 'organization'
    AND ad.protected = FALSE
    THEN 'follow_published'
  ELSE 'pinned'
END
FROM agent_definitions ad
WHERE ad.id = ai.agent_definition_id
  AND ai.release_mode IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_installations WHERE release_mode IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill release_mode for every agent installation';
  END IF;
END $$;

ALTER TABLE agent_installations
  ALTER COLUMN release_mode SET DEFAULT 'pinned',
  ALTER COLUMN release_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_installations_release_mode_check'
      AND conrelid = 'agent_installations'::regclass
  ) THEN
    ALTER TABLE agent_installations
      ADD CONSTRAINT agent_installations_release_mode_check
      CHECK (release_mode IN ('pinned', 'follow_published', 'staged'));
  END IF;
END $$;

COMMENT ON COLUMN agent_installations.release_mode IS
  'Version selection policy: pinned, follow_published, or staged. Staged rollout is reserved for a later release.';

CREATE INDEX IF NOT EXISTS agent_installations_release_mode_idx
  ON agent_installations (organization_id, agent_definition_id, release_mode, status);
