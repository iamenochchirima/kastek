-- A product artifact is owned by the real product task, not a standalone account.
CREATE UNIQUE INDEX product_task_artifact_operation
  ON agents_platform.artifacts(product_owner,organization_id,task_id,operation_id)
  WHERE product_owner IS NOT NULL;

-- Apply the managed-agent capability rollout once, without undoing later settings.
ALTER TABLE agents_platform.product_execution_features
  ADD COLUMN artifact_rollout_revision integer NOT NULL DEFAULT 0 CHECK (artifact_rollout_revision >= 0);
