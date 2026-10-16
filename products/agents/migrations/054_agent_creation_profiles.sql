-- Hosted-agent setup profile is a product concern, separate from execution mode.
-- Existing organization-owned definitions remain custom until explicitly migrated;
-- protected system definitions are marked system and are not user-editable.
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS creation_profile TEXT NOT NULL DEFAULT 'custom';

UPDATE agent_definitions
SET creation_profile = 'system'
WHERE owner_type = 'system' AND protected = TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_definitions_creation_profile_check'
      AND conrelid = 'agent_definitions'::regclass
  ) THEN
    ALTER TABLE agent_definitions
      ADD CONSTRAINT agent_definitions_creation_profile_check
      CHECK (creation_profile IN ('general', 'custom', 'system'));
  END IF;
END $$;

COMMENT ON COLUMN agent_definitions.creation_profile IS
  'Hosted setup profile: general (low configuration), custom (workflow/configuration builder), or system (protected KasiAi).';
