ALTER TABLE agents_platform.agents ADD COLUMN setup jsonb;
ALTER TABLE agents_platform.agents ADD CONSTRAINT agents_setup_object CHECK (setup IS NULL OR jsonb_typeof(setup)='object');
