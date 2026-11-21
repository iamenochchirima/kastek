-- Preserve the values for rollback before removing the columns. Conditional so a
-- database that already dropped them can re-run this file safely.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='agents_platform' AND table_name='sources' AND column_name='visibility') THEN
    CREATE TABLE IF NOT EXISTS agents_platform.source_visibility_archive AS
      SELECT id, organization_id, visibility, now() AS archived_at FROM agents_platform.sources;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='agents_platform' AND table_name='mcp_source_reviews' AND column_name='visibility') THEN
    CREATE TABLE IF NOT EXISTS agents_platform.mcp_source_review_visibility_archive AS
      SELECT id, action, visibility, state, now() AS archived_at FROM agents_platform.mcp_source_reviews;
  END IF;
END $$;

-- Knowledge attached to an agent is usable by that agent. There is no separate
-- source-level audience flag; the agent/version attachment is the boundary.
ALTER TABLE agents_platform.sources DROP COLUMN IF EXISTS visibility;

-- Historical visibility reviews are no longer actionable. Keep the audit rows
-- but remove the obsolete action and its column.
UPDATE agents_platform.mcp_source_reviews SET state='cancelled' WHERE action='visibility';
ALTER TABLE agents_platform.mcp_source_reviews DROP CONSTRAINT IF EXISTS mcp_source_reviews_visibility_check;
ALTER TABLE agents_platform.mcp_source_reviews DROP CONSTRAINT IF EXISTS mcp_source_reviews_action_check;
ALTER TABLE agents_platform.mcp_source_reviews DROP COLUMN IF EXISTS visibility;
ALTER TABLE agents_platform.mcp_source_reviews ADD CONSTRAINT mcp_source_reviews_action_check CHECK (action='approve');
