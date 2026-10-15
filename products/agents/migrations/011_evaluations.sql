CREATE TABLE IF NOT EXISTS evaluation_scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  agent_definition_id UUID REFERENCES agent_definitions(id),
  name TEXT NOT NULL,
  description TEXT,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  assertions JSONB NOT NULL DEFAULT '[]'::jsonb,
  rubric JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evaluation_scenarios_scope_idx
  ON evaluation_scenarios (organization_id, agent_definition_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  scenario_id UUID NOT NULL REFERENCES evaluation_scenarios(id),
  agent_version_id UUID,
  run_id UUID REFERENCES agent_runs(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'error')),
  evaluator_version TEXT NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evaluation_runs_scope_idx
  ON evaluation_runs (organization_id, scenario_id, started_at DESC);
