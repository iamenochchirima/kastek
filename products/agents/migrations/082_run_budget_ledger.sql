CREATE TABLE IF NOT EXISTS run_budgets (
  run_id UUID PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  max_model_calls INTEGER CHECK (max_model_calls IS NULL OR max_model_calls > 0),
  max_tool_calls INTEGER CHECK (max_tool_calls IS NULL OR max_tool_calls > 0),
  max_total_tokens BIGINT CHECK (max_total_tokens IS NULL OR max_total_tokens > 0),
  max_estimated_cost_usd NUMERIC(18, 8) CHECK (max_estimated_cost_usd IS NULL OR max_estimated_cost_usd >= 0),
  reserved_model_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_model_calls >= 0),
  reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  reserved_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0 CHECK (reserved_cost_usd >= 0),
  captured_model_calls INTEGER NOT NULL DEFAULT 0 CHECK (captured_model_calls >= 0),
  captured_tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (captured_tool_calls >= 0),
  captured_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (captured_input_tokens >= 0),
  captured_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (captured_output_tokens >= 0),
  captured_total_tokens BIGINT NOT NULL DEFAULT 0 CHECK (captured_total_tokens >= 0),
  captured_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0 CHECK (captured_cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_budgets_scope_idx
  ON run_budgets (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS run_budget_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  reservation_key TEXT NOT NULL,
  estimated_tokens BIGINT NOT NULL CHECK (estimated_tokens >= 0),
  estimated_cost_usd NUMERIC(18, 8) NOT NULL CHECK (estimated_cost_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'captured', 'released')),
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_total_tokens INTEGER,
  actual_cost_usd NUMERIC(18, 8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  UNIQUE (run_id, reservation_key)
);

CREATE INDEX IF NOT EXISTS run_budget_reservations_scope_idx
  ON run_budget_reservations (organization_id, run_id, status, created_at DESC);

DROP TRIGGER IF EXISTS run_budgets_ownership_trigger ON run_budgets;
CREATE TRIGGER run_budgets_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON run_budgets
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();

DROP TRIGGER IF EXISTS run_budget_reservations_ownership_trigger ON run_budget_reservations;
CREATE TRIGGER run_budget_reservations_ownership_trigger
BEFORE INSERT OR UPDATE OF organization_id, run_id ON run_budget_reservations
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_run_child_scope();
