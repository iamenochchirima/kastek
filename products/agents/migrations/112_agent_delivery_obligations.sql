-- Durable delivery obligations are separate from agent-run completion.
-- The existing channel delivery attempt remains the provider-facing record;
-- this table is the runtime's claim/reconciliation ledger.

CREATE TABLE IF NOT EXISTS agent_delivery_obligations (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  run_id UUID REFERENCES agent_runs(id),
  conversation_id UUID REFERENCES conversations(id),
  channel TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'delivered', 'failed', 'unknown', 'cancelled')),
  claim_id TEXT,
  worker_id TEXT,
  claimed_at TIMESTAMPTZ,
  receipt_ref TEXT,
  reason TEXT,
  reconciliation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, installation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS agent_delivery_obligations_scope_idx
  ON agent_delivery_obligations (organization_id, installation_id, state, updated_at DESC);

CREATE OR REPLACE FUNCTION touch_agent_delivery_obligation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_delivery_obligations_touch ON agent_delivery_obligations;
CREATE TRIGGER agent_delivery_obligations_touch
BEFORE UPDATE ON agent_delivery_obligations
FOR EACH ROW EXECUTE FUNCTION touch_agent_delivery_obligation();

GRANT SELECT, INSERT, UPDATE ON agent_delivery_obligations TO kasitek_agents_runtime;

ALTER TABLE agent_delivery_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_delivery_obligations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_delivery_obligations_agents_scope ON agent_delivery_obligations;
CREATE POLICY agent_delivery_obligations_agents_scope ON agent_delivery_obligations
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id));
