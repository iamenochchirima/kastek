-- Audience is separate from the hosted builder profile. It determines whether
-- an installation may serve customer channels and later use human handoff.
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS agent_audience TEXT;

-- Existing system agents are personal. Existing organization agents that have
-- already received customer conversations or have an unowned active channel
-- are the safest candidates for customer-service classification; all other
-- definitions remain personal until an operator explicitly classifies them.
UPDATE agent_definitions ad
SET agent_audience = CASE
  WHEN ad.owner_type = 'system' AND ad.protected = TRUE THEN 'personal'
  WHEN EXISTS (
    SELECT 1
    FROM conversations c
    JOIN agent_installations ai ON ai.id = c.installation_id
    WHERE ai.agent_definition_id = ad.id
      AND c.conversation_kind = 'customer'
  ) THEN 'customer_service'
  WHEN EXISTS (
    SELECT 1
    FROM channel_connections cc
    JOIN agent_installations ai ON ai.id = cc.installation_id
    WHERE ai.agent_definition_id = ad.id
      AND cc.status = 'active'
  ) THEN 'customer_service'
  ELSE 'personal'
END
WHERE ad.agent_audience IS NULL;

ALTER TABLE agent_definitions
  ALTER COLUMN agent_audience SET DEFAULT 'personal',
  ALTER COLUMN agent_audience SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_definitions_agent_audience_check'
      AND conrelid = 'agent_definitions'::regclass
  ) THEN
    ALTER TABLE agent_definitions
      ADD CONSTRAINT agent_definitions_agent_audience_check
      CHECK (agent_audience IN ('personal', 'customer_service'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_definitions_audience_idx
  ON agent_definitions (organization_id, agent_audience, status, created_at DESC);

COMMENT ON COLUMN agent_definitions.agent_audience IS
  'Product audience: personal private/test agent or customer_service customer-facing agent.';
