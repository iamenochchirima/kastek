-- Separate an agent's offer from a customer-authorized handoff request.
-- Pending offers never change conversation ownership or stop automation.
CREATE TABLE IF NOT EXISTS agent_handoff_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  source_run_id UUID REFERENCES agent_runs(id),
  source_message_id UUID REFERENCES messages(id),
  channel_type TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('agent_uncertain', 'policy_required', 'high_value', 'configured_workflow', 'other')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2_000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  offered_by TEXT NOT NULL,
  decision_message_id UUID REFERENCES messages(id),
  classifier_version TEXT,
  idempotency_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
  decided_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, installation_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_handoff_offers_pending_conversation_idx
  ON agent_handoff_offers (conversation_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS agent_handoff_offers_expiry_idx
  ON agent_handoff_offers (organization_id, status, expires_at)
  WHERE status = 'pending';

ALTER TABLE agent_handoff_requests
  ADD COLUMN IF NOT EXISTS request_source TEXT NOT NULL DEFAULT 'legacy_unverified',
  ADD COLUMN IF NOT EXISTS source_message_id UUID REFERENCES messages(id),
  ADD COLUMN IF NOT EXISTS offer_id UUID REFERENCES agent_handoff_offers(id),
  ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classifier_version TEXT;

ALTER TABLE agent_handoff_requests DROP CONSTRAINT IF EXISTS agent_handoff_requests_source_check;
ALTER TABLE agent_handoff_requests ADD CONSTRAINT agent_handoff_requests_source_check
  CHECK (request_source IN ('customer_direct', 'customer_confirmed', 'operator', 'legacy_unverified'));

CREATE INDEX IF NOT EXISTS agent_handoff_requests_source_message_idx
  ON agent_handoff_requests (source_message_id)
  WHERE source_message_id IS NOT NULL;

COMMENT ON TABLE agent_handoff_offers IS
  'Customer-service handoff offers. Offers remain non-owning until an explicit customer decision is recorded.';

COMMENT ON COLUMN agent_handoff_requests.request_source IS
  'Provenance for ownership changes: customer consent, operator action, or legacy data awaiting migration.';
