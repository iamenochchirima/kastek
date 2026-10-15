-- First RLS tranche: memory and knowledge are tenant-owned context records.
-- Runtime code sets these values transaction-locally; platform sweepers use the
-- explicit operator scope. This migration is intentionally separate from the
-- broader runtime-table rollout so it can be disabled or reverted independently.

CREATE OR REPLACE FUNCTION kasitek_agents_operator_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('kasitek.organization_id', true) = 'platform'
     AND current_setting('kasitek.operator', true) = 'true';
$$;

GRANT EXECUTE ON FUNCTION kasitek_agents_operator_scope() TO kasitek_agents_runtime;

DROP POLICY IF EXISTS memory_records_agents_scope ON memory_records;
CREATE POLICY memory_records_agents_scope ON memory_records
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      organization_id = current_setting('kasitek.organization_id', true)
      AND EXISTS (
        SELECT 1
        FROM agent_definitions definition
        WHERE definition.id = memory_records.agent_definition_id
          AND (
            definition.organization_id = memory_records.organization_id
            OR (definition.owner_type = 'system' AND definition.protected = TRUE)
          )
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      organization_id = current_setting('kasitek.organization_id', true)
      AND EXISTS (
        SELECT 1
        FROM agent_definitions definition
        WHERE definition.id = memory_records.agent_definition_id
          AND (
            definition.organization_id = memory_records.organization_id
            OR (definition.owner_type = 'system' AND definition.protected = TRUE)
          )
      )
    )
  );
ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_sources_agents_scope ON knowledge_sources;
CREATE POLICY knowledge_sources_agents_scope ON knowledge_sources
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      organization_id = current_setting('kasitek.organization_id', true)
      AND EXISTS (
        SELECT 1
        FROM agent_definitions definition
        WHERE definition.id = knowledge_sources.agent_definition_id
          AND (
            definition.organization_id = knowledge_sources.organization_id
            OR (definition.owner_type = 'system' AND definition.protected = TRUE)
          )
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      organization_id = current_setting('kasitek.organization_id', true)
      AND EXISTS (
        SELECT 1
        FROM agent_definitions definition
        WHERE definition.id = knowledge_sources.agent_definition_id
          AND (
            definition.organization_id = knowledge_sources.organization_id
            OR (definition.owner_type = 'system' AND definition.protected = TRUE)
          )
      )
    )
  );
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_chunks_agents_scope ON knowledge_chunks;
CREATE POLICY knowledge_chunks_agents_scope ON knowledge_chunks
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      organization_id = current_setting('kasitek.organization_id', true)
      AND EXISTS (
        SELECT 1
        FROM knowledge_sources source
        WHERE source.id = knowledge_chunks.source_id
          AND source.organization_id = knowledge_chunks.organization_id
          AND source.agent_definition_id = knowledge_chunks.agent_definition_id
          AND source.installation_id IS NOT DISTINCT FROM knowledge_chunks.installation_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      organization_id = current_setting('kasitek.organization_id', true)
      AND EXISTS (
        SELECT 1
        FROM knowledge_sources source
        WHERE source.id = knowledge_chunks.source_id
          AND source.organization_id = knowledge_chunks.organization_id
          AND source.agent_definition_id = knowledge_chunks.agent_definition_id
          AND source.installation_id IS NOT DISTINCT FROM knowledge_chunks.installation_id
      )
    )
  );
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_deletion_jobs_agents_scope ON memory_deletion_jobs;
CREATE POLICY memory_deletion_jobs_agents_scope ON memory_deletion_jobs
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR organization_id = current_setting('kasitek.organization_id', true)
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR organization_id = current_setting('kasitek.organization_id', true)
  );
ALTER TABLE memory_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_deletion_jobs FORCE ROW LEVEL SECURITY;
