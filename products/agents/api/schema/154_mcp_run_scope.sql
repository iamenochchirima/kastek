ALTER TABLE agents_platform.mcp_run_provenance
  ADD COLUMN required_scope text NOT NULL DEFAULT 'agents:manage'
  CHECK (required_scope IN ('agents:manage', 'runs:start'));
