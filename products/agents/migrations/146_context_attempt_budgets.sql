-- Durable, tenant-scoped admission accounting for context recovery work.
-- Reservations are never released or deleted. A replacement worker reuses the
-- same operation key and receives the existing receipt instead of opening a
-- second slot. This table contains no prompt, model, credential, or memory
-- data.
CREATE TABLE IF NOT EXISTS agent_context_attempt_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  budget_id TEXT NOT NULL CHECK (length(btrim(budget_id)) BETWEEN 1 AND 240),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  reserved_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reserved_attempts >= 0),
  consumed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (consumed_attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, budget_id)
);

CREATE INDEX IF NOT EXISTS agent_context_attempt_budgets_run_idx
  ON agent_context_attempt_budgets (organization_id, run_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_context_attempt_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL CHECK (length(btrim(turn_id)) BETWEEN 1 AND 240),
  operation_key TEXT NOT NULL CHECK (length(btrim(operation_key)) BETWEEN 1 AND 240),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'proactive_compaction',
    'overflow_recovery',
    'provider_retry',
    'worker_replacement'
  )),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (organization_id, budget_id, operation_key),
  UNIQUE (organization_id, budget_id, attempt_number),
  FOREIGN KEY (organization_id, budget_id)
    REFERENCES agent_context_attempt_budgets (organization_id, budget_id)
    ON DELETE CASCADE,
  CHECK (
    (state = 'reserved' AND consumed_at IS NULL)
    OR (state = 'consumed' AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS agent_context_attempt_reservations_run_idx
  ON agent_context_attempt_reservations (organization_id, run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_context_attempt_reservations_replay_idx
  ON agent_context_attempt_reservations (organization_id, budget_id, operation_key);

DROP TRIGGER IF EXISTS agent_context_attempt_budgets_ownership_trigger
  ON agent_context_attempt_budgets;
CREATE TRIGGER agent_context_attempt_budgets_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON agent_context_attempt_budgets
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();

DROP TRIGGER IF EXISTS agent_context_attempt_reservations_ownership_trigger
  ON agent_context_attempt_reservations;
CREATE TRIGGER agent_context_attempt_reservations_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON agent_context_attempt_reservations
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();

GRANT SELECT, INSERT, UPDATE
  ON agent_context_attempt_budgets, agent_context_attempt_reservations
  TO kasitek_agents_runtime;

ALTER TABLE agent_context_attempt_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_context_attempt_budgets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_context_attempt_budgets_agents_scope
  ON agent_context_attempt_budgets;
CREATE POLICY agent_context_attempt_budgets_agents_scope
  ON agent_context_attempt_budgets
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1
        FROM agent_runs run
        WHERE run.id = agent_context_attempt_budgets.run_id
          AND run.organization_id = agent_context_attempt_budgets.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1
        FROM agent_runs run
        WHERE run.id = agent_context_attempt_budgets.run_id
          AND run.organization_id = agent_context_attempt_budgets.organization_id
      )
    )
  );

ALTER TABLE agent_context_attempt_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_context_attempt_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_context_attempt_reservations_agents_scope
  ON agent_context_attempt_reservations;
CREATE POLICY agent_context_attempt_reservations_agents_scope
  ON agent_context_attempt_reservations
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1
        FROM agent_context_attempt_budgets budget
        WHERE budget.organization_id = agent_context_attempt_reservations.organization_id
          AND budget.budget_id = agent_context_attempt_reservations.budget_id
          AND budget.run_id = agent_context_attempt_reservations.run_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1
        FROM agent_context_attempt_budgets budget
        WHERE budget.organization_id = agent_context_attempt_reservations.organization_id
          AND budget.budget_id = agent_context_attempt_reservations.budget_id
          AND budget.run_id = agent_context_attempt_reservations.run_id
      )
    )
  );
