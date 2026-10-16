-- Tighten the memory-v2 evidence boundary after the initial integrity guards.
-- Checkpoint identity is immutable; only lifecycle/error metadata may change.
-- Facts use the workspace-scoped validator for every insert/update, so the
-- older namespace-only trigger is redundant and must not leave a partial
-- update surface behind.

DROP TRIGGER IF EXISTS agent_memory_facts_scope_trigger ON agent_memory_facts;

CREATE OR REPLACE FUNCTION kasitek_memory_checkpoint_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.agent_definition_id IS DISTINCT FROM NEW.agent_definition_id
    OR OLD.agent_version_id IS DISTINCT FROM NEW.agent_version_id
    OR OLD.installation_id IS DISTINCT FROM NEW.installation_id
    OR OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.turn_id IS DISTINCT FROM NEW.turn_id
    OR OLD.compaction_generation IS DISTINCT FROM NEW.compaction_generation
    OR OLD.source_boundary IS DISTINCT FROM NEW.source_boundary
    OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.source_event_id IS DISTINCT FROM NEW.source_event_id
    OR OLD.requested_at IS DISTINCT FROM NEW.requested_at
  THEN
    RAISE EXCEPTION 'Memory checkpoint identity is immutable; create a new checkpoint instead';
  END IF;

  IF OLD.status = 'committed' AND NEW.status <> 'committed' THEN
    RAISE EXCEPTION 'Committed memory checkpoints cannot transition backwards';
  END IF;

  IF OLD.status = 'requested' AND NEW.status NOT IN ('requested', 'committed', 'blocked', 'failed') THEN
    RAISE EXCEPTION 'Invalid requested memory checkpoint transition';
  END IF;
  IF OLD.status IN ('blocked', 'failed') AND NEW.status NOT IN ('requested', 'committed', 'blocked', 'failed') THEN
    RAISE EXCEPTION 'Invalid retryable memory checkpoint transition';
  END IF;

  IF NEW.status = 'committed' THEN
    IF NEW.committed_at IS NULL THEN
      RAISE EXCEPTION 'Committed memory checkpoints require committed_at';
    END IF;
    IF NEW.error_code IS NOT NULL OR NEW.error_digest IS NOT NULL THEN
      RAISE EXCEPTION 'Committed memory checkpoints cannot retain an error';
    END IF;
  ELSIF NEW.committed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only committed memory checkpoints may have committed_at';
  END IF;

  IF NEW.status IN ('blocked', 'failed')
    AND NULLIF(trim(COALESCE(NEW.error_code, '')), '') IS NULL
  THEN
    RAISE EXCEPTION 'Blocked or failed memory checkpoints require error_code';
  END IF;

  IF NEW.status = 'requested'
    AND (NEW.error_code IS NOT NULL OR NEW.error_digest IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Requested memory checkpoints cannot retain an error';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_checkpoints_transition_guard ON memory_checkpoints;
CREATE TRIGGER memory_checkpoints_transition_guard
BEFORE UPDATE ON memory_checkpoints
FOR EACH ROW EXECUTE FUNCTION kasitek_memory_checkpoint_transition_guard();

COMMENT ON FUNCTION kasitek_memory_checkpoint_transition_guard() IS
  'Keeps checkpoint identity immutable, permits only retryable lifecycle transitions, and enforces status/error/timestamp coherence.';
