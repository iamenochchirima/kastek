-- Immutable, tenant-scoped context decisions. Source message history remains in
-- conversation storage; this table stores only the bounded projection decision
-- and the redacted/deterministic summary revision.
CREATE TABLE IF NOT EXISTS agent_context_compaction_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(btrim(operation_id)) BETWEEN 1 AND 240),
  context_id TEXT NOT NULL CHECK (length(btrim(context_id)) BETWEEN 1 AND 240),
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  operation_fingerprint TEXT NOT NULL CHECK (length(operation_fingerprint) = 64),
  decision JSONB NOT NULL,
  compaction JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, operation_id)
);

CREATE INDEX IF NOT EXISTS agent_context_compaction_context_idx
  ON agent_context_compaction_revisions (organization_id, context_id, revision);

GRANT SELECT, INSERT ON agent_context_compaction_revisions TO kasitek_agents_runtime;

ALTER TABLE agent_context_compaction_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_context_compaction_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_context_compaction_revisions_agents_scope ON agent_context_compaction_revisions;
CREATE POLICY agent_context_compaction_revisions_agents_scope ON agent_context_compaction_revisions
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR kasitek_agents_current_org_scope(organization_id)
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR kasitek_agents_current_org_scope(organization_id)
  );
