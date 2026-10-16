-- 054 added creation_profile with a default for fresh databases, but an
-- already-existing column was not altered by ADD COLUMN IF NOT EXISTS. Repair
-- that upgrade path so every agent definition can be created safely.
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS creation_profile TEXT;

UPDATE agent_definitions
SET creation_profile = CASE
  WHEN owner_type = 'system' AND protected = TRUE THEN 'system'
  ELSE 'custom'
END
WHERE creation_profile IS NULL;

ALTER TABLE agent_definitions
  ALTER COLUMN creation_profile SET DEFAULT 'custom',
  ALTER COLUMN creation_profile SET NOT NULL;
