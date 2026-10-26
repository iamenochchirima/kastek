ALTER TABLE agents_platform.agents
  ADD COLUMN setup_step text CHECK (setup_step IS NULL OR setup_step IN ('Business','Responsibilities','Knowledge','Channels','Preferences','Bookings','Review','complete')),
  ADD COLUMN setup_operation_id uuid,
  ADD COLUMN setup_request_digest text;
CREATE UNIQUE INDEX agent_setup_operation ON agents_platform.agents(organization_id,created_by,setup_operation_id)
  WHERE setup_operation_id IS NOT NULL;
