-- Link request manifests to the exact canonical active transcript projection
-- without copying any prompt or tool content into the manifest table.
ALTER TABLE agent_context_request_manifests
  ADD COLUMN IF NOT EXISTS source_projection_digest TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_context_request_manifests_source_projection_digest_check'
      AND conrelid = 'agent_context_request_manifests'::regclass
  ) THEN
    ALTER TABLE agent_context_request_manifests
      ADD CONSTRAINT agent_context_request_manifests_source_projection_digest_check
      CHECK (source_projection_digest IS NULL OR source_projection_digest ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_context_request_manifests_source_projection_identity_check'
      AND conrelid = 'agent_context_request_manifests'::regclass
  ) THEN
    ALTER TABLE agent_context_request_manifests
      ADD CONSTRAINT agent_context_request_manifests_source_projection_identity_check
      CHECK ((source_projection_digest IS NULL) = (source_cursor IS NULL));
  END IF;
END;
$$;

COMMENT ON COLUMN agent_context_request_manifests.source_projection_digest IS
  'Digest of the canonical active transcript projection before provider selection';
