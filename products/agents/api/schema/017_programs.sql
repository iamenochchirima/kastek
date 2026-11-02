ALTER TABLE agents_platform.agent_versions ADD COLUMN effective_composition jsonb NOT NULL
  CHECK (effective_composition->>'schemaVersion'='1' AND effective_composition->>'digest' ~ '^[a-f0-9]{64}$');
ALTER TABLE agents_platform.tasks ADD COLUMN effective_composition jsonb NOT NULL
  CHECK (effective_composition->>'schemaVersion'='1' AND effective_composition->>'digest' ~ '^[a-f0-9]{64}$');
ALTER TABLE agents_platform.tasks ALTER COLUMN harness_release SET DEFAULT 'modular-programs-v2';
ALTER TABLE agents_platform.tasks ADD COLUMN channel_binding jsonb;

CREATE FUNCTION agents_platform.protect_execution_composition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_composition IS DISTINCT FROM OLD.effective_composition
    OR NEW.effective_configuration IS DISTINCT FROM OLD.effective_configuration
    OR NEW.version_id IS DISTINCT FROM OLD.version_id
    OR NEW.product IS DISTINCT FROM OLD.product
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.principal IS DISTINCT FROM OLD.principal
    OR NEW.harness_release IS DISTINCT FROM OLD.harness_release
    OR NEW.channel_binding IS DISTINCT FROM OLD.channel_binding
  THEN RAISE EXCEPTION 'Admitted execution composition is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_execution_composition BEFORE UPDATE ON agents_platform.tasks
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_execution_composition();
