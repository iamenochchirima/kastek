-- Preserve the canonical transcript position that produced each model request.
-- These fields are nullable for manifests written before the session transcript
-- cutover; canonical requests populate both values.
ALTER TABLE agent_context_request_manifests
  ADD COLUMN IF NOT EXISTS source_cursor BIGINT,
  ADD COLUMN IF NOT EXISTS source_generation BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_context_request_manifests_source_cursor_check'
      AND conrelid = 'agent_context_request_manifests'::regclass
  ) THEN
    ALTER TABLE agent_context_request_manifests
      ADD CONSTRAINT agent_context_request_manifests_source_cursor_check
      CHECK (source_cursor IS NULL OR source_cursor >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_context_request_manifests_source_generation_check'
      AND conrelid = 'agent_context_request_manifests'::regclass
  ) THEN
    ALTER TABLE agent_context_request_manifests
      ADD CONSTRAINT agent_context_request_manifests_source_generation_check
      CHECK (source_generation IS NULL OR source_generation > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_context_request_manifests_source_identity_pair_check'
      AND conrelid = 'agent_context_request_manifests'::regclass
  ) THEN
    ALTER TABLE agent_context_request_manifests
      ADD CONSTRAINT agent_context_request_manifests_source_identity_pair_check
      CHECK ((source_cursor IS NULL) = (source_generation IS NULL));
  END IF;
END;
$$;

COMMENT ON COLUMN agent_context_request_manifests.source_cursor IS
  'Canonical agent session transcript head sequence used for this request';
COMMENT ON COLUMN agent_context_request_manifests.source_generation IS
  'Canonical agent session transcript generation used for this request';
