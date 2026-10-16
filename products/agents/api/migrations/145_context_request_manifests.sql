-- Bounded, tenant-scoped read model for model-facing context manifests.
-- This table deliberately stores identifiers, digests, and numeric accounting
-- only. Prompt content, tool output, credentials, and tool schemas remain in
-- their existing authoritative boundaries and are never copied here.
CREATE TABLE IF NOT EXISTS agent_context_request_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  request_manifest_id TEXT NOT NULL CHECK (length(btrim(request_manifest_id)) BETWEEN 1 AND 240),
  run_id TEXT NOT NULL CHECK (length(btrim(run_id)) BETWEEN 1 AND 240),
  turn_id TEXT NOT NULL CHECK (length(btrim(turn_id)) BETWEEN 1 AND 240),
  model_attempt_id TEXT CHECK (model_attempt_id IS NULL OR length(btrim(model_attempt_id)) BETWEEN 1 AND 240),
  provider_request_id TEXT CHECK (provider_request_id IS NULL OR length(btrim(provider_request_id)) BETWEEN 1 AND 240),
  schema_version TEXT NOT NULL DEFAULT 'v1' CHECK (schema_version = 'v1'),
  compaction_generation INTEGER NOT NULL DEFAULT 0 CHECK (compaction_generation >= 0),
  source_boundary_digest TEXT NOT NULL CHECK (source_boundary_digest ~ '^[0-9a-f]{64}$'),
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  source_message_count INTEGER NOT NULL CHECK (source_message_count >= 0),
  selected_message_count INTEGER NOT NULL CHECK (selected_message_count >= 0),
  source_tool_count INTEGER NOT NULL CHECK (source_tool_count >= 0),
  selected_tool_count INTEGER NOT NULL CHECK (selected_tool_count >= 0),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
  safety_margin_tokens INTEGER NOT NULL CHECK (safety_margin_tokens >= 0),
  provider_context_window_tokens INTEGER NOT NULL CHECK (provider_context_window_tokens >= 0),
  input_budget_tokens INTEGER NOT NULL CHECK (input_budget_tokens >= 0),
  soft_threshold_tokens INTEGER NOT NULL CHECK (soft_threshold_tokens >= 0),
  hard_limit_tokens INTEGER NOT NULL CHECK (hard_limit_tokens >= 0),
  estimated_request_bytes BIGINT NOT NULL CHECK (estimated_request_bytes >= 0),
  component_accounting JSONB NOT NULL DEFAULT '[]'::jsonb,
  fit_decision TEXT NOT NULL CHECK (fit_decision IN ('ready', 'compact', 'prune', 'limited', 'cannot_fit')),
  status TEXT NOT NULL CHECK (status IN ('fits', 'compacted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, request_manifest_id),
  CHECK (jsonb_typeof(component_accounting) = 'array'),
  CHECK (jsonb_array_length(component_accounting) <= 5),
  CHECK (octet_length(component_accounting::text) <= 4096)
);

CREATE INDEX IF NOT EXISTS agent_context_request_manifests_run_idx
  ON agent_context_request_manifests (organization_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS agent_context_request_manifests_turn_idx
  ON agent_context_request_manifests (organization_id, turn_id, created_at);

GRANT SELECT, INSERT ON agent_context_request_manifests TO kasitek_agents_runtime;

ALTER TABLE agent_context_request_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_context_request_manifests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_context_request_manifests_agents_scope ON agent_context_request_manifests;
CREATE POLICY agent_context_request_manifests_agents_scope ON agent_context_request_manifests
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR kasitek_agents_current_org_scope(organization_id)
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR kasitek_agents_current_org_scope(organization_id)
  );
