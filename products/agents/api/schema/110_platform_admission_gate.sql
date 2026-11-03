-- A platform drain stops new root tasks while accepted roots continue on their pinned runtime.
CREATE TABLE agents_platform.platform_admission_gate (
  id smallint PRIMARY KEY CHECK (id = 1),
  accepting_roots boolean NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  changed_at timestamptz NOT NULL,
  changed_by text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 256)
);

INSERT INTO agents_platform.platform_admission_gate(id, accepting_roots, revision, changed_at, changed_by, reason)
VALUES (1, true, 0, now(), 'schema-migration', 'New root admissions enabled on installation');

CREATE TABLE agents_platform.platform_admission_gate_events (
  id uuid PRIMARY KEY,
  revision bigint NOT NULL UNIQUE,
  action text NOT NULL CHECK (action IN ('drain', 'resume')),
  accepting_roots boolean NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER immutable_platform_admission_gate_event
  BEFORE UPDATE OR DELETE ON agents_platform.platform_admission_gate_events
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
