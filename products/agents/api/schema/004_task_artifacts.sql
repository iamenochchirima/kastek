ALTER TABLE agents_platform.artifacts
  ADD COLUMN task_id uuid REFERENCES agents_platform.tasks(id),
  ADD COLUMN root_task_id uuid REFERENCES agents_platform.tasks(id),
  ADD COLUMN name text CHECK(length(name) BETWEEN 1 AND 120),
  ADD COLUMN source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT artifact_task_lineage CHECK ((task_id IS NULL) = (root_task_id IS NULL));
CREATE INDEX artifacts_root ON agents_platform.artifacts(root_task_id,created_at,id) WHERE state='available';
CREATE TABLE agents_platform.task_artifact_transfers (
  artifact_id uuid NOT NULL REFERENCES agents_platform.artifacts(id),
  target_task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  granted_by_task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(artifact_id,target_task_id)
);
