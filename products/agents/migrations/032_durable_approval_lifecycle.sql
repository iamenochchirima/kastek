-- Approval records are the authoritative state machine. A proposal starts pending; only an
-- authenticated decision may attach an approver, and one approved record permits one effect.
ALTER TABLE agent_approval_records
  ALTER COLUMN approved_by DROP NOT NULL;

ALTER TABLE agent_approval_records
  ADD COLUMN IF NOT EXISTS policy_revision TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS permitted_effect_key TEXT NOT NULL DEFAULT '';

UPDATE agent_approval_records
SET permitted_effect_key = run_id::text || ':' || provider_tool_call_id
WHERE permitted_effect_key = '';

ALTER TABLE agent_approval_records
  ADD CONSTRAINT agent_approval_records_effect_key_unique UNIQUE (organization_id, permitted_effect_key);
