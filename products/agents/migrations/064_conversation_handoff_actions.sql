-- Conversation-level ownership and durable human handoff requests.
-- Agent runs still use awaiting_human while this projection records who owns
-- the customer conversation and why automation stopped.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS handoff_state TEXT NOT NULL DEFAULT 'agent_active',
  ADD COLUMN IF NOT EXISTS handoff_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS handoff_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handoff_resolved_at TIMESTAMPTZ;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_handoff_state_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_handoff_state_check
  CHECK (handoff_state IN ('agent_active', 'handoff_requested', 'human_owned', 'resolved', 'expired', 'cancelled'));

CREATE TABLE IF NOT EXISTS agent_handoff_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  agent_definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  run_id UUID REFERENCES agent_runs(id),
  channel_type TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('customer_requested', 'agent_uncertain', 'policy_required', 'high_value', 'configured_workflow', 'other')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2_000),
  customer_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'resolved', 'expired', 'cancelled')),
  requested_by TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, installation_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_handoff_requests_active_conversation_idx
  ON agent_handoff_requests (conversation_id)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS agent_handoff_requests_queue_idx
  ON agent_handoff_requests (organization_id, status, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_handoff_requests_installation_idx
  ON agent_handoff_requests (organization_id, installation_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS conversations_handoff_queue_idx
  ON conversations (organization_id, handoff_state, updated_at DESC)
  WHERE conversation_kind = 'customer' AND status <> 'deleted';

COMMENT ON COLUMN conversations.handoff_state IS
  'Conversation ownership state for customer-service automation and human handoff.';

COMMENT ON TABLE agent_handoff_requests IS
  'Durable handoff requests and their operator resolution metadata.';
