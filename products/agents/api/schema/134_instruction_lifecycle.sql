-- Delivered steering must remain applicable until it is explicitly superseded.
-- A delivered marker records what a model has seen, not whether a constraint still applies.
ALTER TABLE agents_platform.orchestration_instructions
  ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'superseded', 'withdrawn')),
  ADD COLUMN superseded_by bigint REFERENCES agents_platform.orchestration_instructions(sequence);

CREATE INDEX orchestration_instructions_active
  ON agents_platform.orchestration_instructions (task_id, state, sequence);
