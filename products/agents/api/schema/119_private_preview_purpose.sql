ALTER TABLE agents_platform.tasks DROP CONSTRAINT tasks_execution_purpose_check;
ALTER TABLE agents_platform.tasks ADD CONSTRAINT tasks_execution_purpose_check
  CHECK (execution_purpose IN ('business_v1','support_status_v1','private_preview_v1'));
