-- Reserve the first possible model/tool operation of every fan-out branch before
-- the branch tasks are launched. The lease is deliberately separate from model
-- reservations: a branch may later perform more sequential operations through
-- the ordinary run budget ledger.
CREATE TABLE IF NOT EXISTS run_budget_parallel_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  branch_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  model_slot_status TEXT NOT NULL CHECK (model_slot_status IN ('reserved', 'consumed', 'released')),
  tool_slot_status TEXT NOT NULL CHECK (tool_slot_status IN ('reserved', 'consumed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  UNIQUE (run_id, branch_key)
);

CREATE INDEX IF NOT EXISTS run_budget_parallel_leases_scope_idx
  ON run_budget_parallel_leases (organization_id, run_id, status, created_at DESC);

DROP TRIGGER IF EXISTS run_budget_parallel_leases_ownership_trigger ON run_budget_parallel_leases;
CREATE TRIGGER run_budget_parallel_leases_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON run_budget_parallel_leases
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();

DROP POLICY IF EXISTS run_budget_parallel_leases_agents_scope ON run_budget_parallel_leases;
CREATE POLICY run_budget_parallel_leases_agents_scope ON run_budget_parallel_leases
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_budget_parallel_leases.run_id
        AND run.organization_id = run_budget_parallel_leases.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_budget_parallel_leases.run_id
        AND run.organization_id = run_budget_parallel_leases.organization_id
    )
  );
ALTER TABLE run_budget_parallel_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_budget_parallel_leases FORCE ROW LEVEL SECURITY;
