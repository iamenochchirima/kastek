-- Keep the source-evidence deletion guard closed when no transaction actor is set.
-- NULL from current_setting(..., true) must not accidentally pass a comparison.

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

COMMENT ON FUNCTION kasitek_memory_source_event_immutable() IS
  'Freezes captured evidence; only the system memory-deletion actor may purge it, including when no actor is set.';
