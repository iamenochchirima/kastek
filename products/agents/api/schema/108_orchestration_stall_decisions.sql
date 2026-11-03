-- A stalled stop and its input closure commit as one task-scoped decision.
CREATE TABLE agents_platform.orchestration_stall_decisions (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  step integer NOT NULL CHECK(step >= 0),
  observation_digest text NOT NULL CHECK(observation_digest ~ '^[a-f0-9]{64}$'),
  outcome jsonb NOT NULL CHECK(jsonb_typeof(outcome)='object'),
  outcome_digest text NOT NULL CHECK(outcome_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_orchestration_stall_decision BEFORE UPDATE OR DELETE
  ON agents_platform.orchestration_stall_decisions FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
