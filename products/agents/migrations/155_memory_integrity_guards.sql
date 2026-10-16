-- Close the mutable-scope and source-evidence integrity gaps in the v2 memory domain.
-- Facts are scoped records, not free-form JSON rows, and source events are the immutable
-- evidence boundary. The deletion worker is the only supported actor allowed to purge source
-- evidence after a completed deletion request.

DROP TRIGGER IF EXISTS agent_memory_facts_workspace_scope_trigger ON agent_memory_facts;
CREATE TRIGGER agent_memory_facts_workspace_scope_trigger
BEFORE INSERT OR UPDATE ON agent_memory_facts
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_fact_scope();

CREATE OR REPLACE FUNCTION kasitek_memory_source_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('kasitek.actor_id', true) IS DISTINCT FROM 'system:memory-deletion' THEN
      RAISE EXCEPTION 'Memory source events are immutable outside the deletion workflow';
    END IF;
    RETURN OLD;
  END IF;

  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Memory source events are immutable; append a new event instead';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_source_events_immutable_trigger ON memory_source_events;
CREATE TRIGGER memory_source_events_immutable_trigger
BEFORE UPDATE OR DELETE ON memory_source_events
FOR EACH ROW EXECUTE FUNCTION kasitek_memory_source_event_immutable();

CREATE OR REPLACE FUNCTION kasitek_memory_checkpoint_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'committed' AND NEW.status <> 'committed' THEN
    RAISE EXCEPTION 'Committed memory checkpoints cannot transition backwards';
  END IF;

  IF NEW.status = 'committed' AND NEW.committed_at IS NULL THEN
    RAISE EXCEPTION 'Committed memory checkpoints require committed_at';
  END IF;
  IF NEW.status <> 'committed' AND NEW.committed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only committed memory checkpoints may have committed_at';
  END IF;

  IF OLD.status <> 'committed' AND NEW.status NOT IN ('requested', 'committed', 'blocked', 'failed') THEN
    RAISE EXCEPTION 'Invalid memory checkpoint transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_checkpoints_transition_guard ON memory_checkpoints;
CREATE TRIGGER memory_checkpoints_transition_guard
BEFORE UPDATE ON memory_checkpoints
FOR EACH ROW EXECUTE FUNCTION kasitek_memory_checkpoint_transition_guard();

COMMENT ON FUNCTION kasitek_memory_source_event_immutable() IS
  'Freezes captured evidence; only the system memory-deletion actor may purge it.';
COMMENT ON FUNCTION kasitek_memory_checkpoint_transition_guard() IS
  'Prevents committed checkpoints from being rolled back and keeps status/timestamp coherent.';
