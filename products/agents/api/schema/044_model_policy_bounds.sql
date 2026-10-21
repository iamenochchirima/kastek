ALTER TABLE agents_platform.execution_grants DROP CONSTRAINT execution_grants_max_input_bytes_check,
 ADD CHECK(max_input_bytes BETWEEN 1 AND 2147483647);
ALTER TABLE agents_platform.tasks DROP CONSTRAINT tasks_input_check,
 ADD CHECK(octet_length(input) BETWEEN 1 AND 2147483647);
ALTER TABLE agents_platform.tasks ALTER COLUMN harness_release SET DEFAULT 'model-bindings-v6';
