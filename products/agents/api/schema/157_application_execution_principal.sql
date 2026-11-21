ALTER TABLE agents_platform.execution_grants DROP CONSTRAINT execution_grants_principal_check;
ALTER TABLE agents_platform.execution_grants ADD CONSTRAINT execution_grants_principal_check
  CHECK (principal->>'kind' IN ('human','automation','visitor','channel_customer','application'));
