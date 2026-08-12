CREATE TABLE IF NOT EXISTS agent_attachment_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  run_id UUID REFERENCES agent_runs(id),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  scan_status TEXT NOT NULL CHECK (scan_status IN ('pending', 'clean', 'quarantined', 'failed')),
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_at TIMESTAMPTZ,
  UNIQUE (organization_id, object_key)
);

CREATE INDEX IF NOT EXISTS agent_attachment_references_scope_idx
  ON agent_attachment_references (organization_id, installation_id, scan_status);
