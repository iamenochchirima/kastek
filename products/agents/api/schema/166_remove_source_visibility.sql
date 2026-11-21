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
