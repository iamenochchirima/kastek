ALTER TABLE agents_platform.execution_grants ALTER COLUMN root_token_limit DROP NOT NULL;
ALTER TABLE agents_platform.tasks ALTER COLUMN root_token_limit DROP NOT NULL;
ALTER TABLE agents_platform.tasks ALTER COLUMN allocation_active_ms DROP NOT NULL;
ALTER TABLE agents_platform.usage_reservations DROP CONSTRAINT usage_reservations_tokens_check;
ALTER TABLE agents_platform.usage_reservations ADD CHECK(tokens>=0);

-- These counters are integers representable exactly by the application's number type.
-- Per-operation transport bounds and monetary bigint accounting remain independent.
DO $$
DECLARE relation_name text; column_name text; constraint_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['tasks','execution_roots'] LOOP
    FOREACH column_name IN ARRAY ARRAY['tokens_used','tokens_reserved','model_calls','tool_calls','active_ms','active_reserved_ms'] LOOP
      constraint_name=relation_name || '_' || column_name || '_check';
      EXECUTE format('ALTER TABLE agents_platform.%I DROP CONSTRAINT IF EXISTS %I',relation_name,constraint_name);
      EXECUTE format('ALTER TABLE agents_platform.%I ALTER COLUMN %I TYPE double precision',relation_name,column_name);
      EXECUTE format('ALTER TABLE agents_platform.%I ADD CHECK (%I>=0 AND %I<=9007199254740991 AND trunc(%I)=%I)',relation_name,column_name,column_name,column_name,column_name);
    END LOOP;
  END LOOP;
  FOREACH column_name IN ARRAY ARRAY['child_reserved_tokens','child_reserved_ms'] LOOP
    EXECUTE format('ALTER TABLE agents_platform.execution_roots DROP CONSTRAINT IF EXISTS %I','execution_roots_' || column_name || '_check');
    EXECUTE format('ALTER TABLE agents_platform.execution_roots ALTER COLUMN %I TYPE double precision',column_name);
    EXECUTE format('ALTER TABLE agents_platform.execution_roots ADD CHECK (%I>=0 AND %I<=9007199254740991 AND trunc(%I)=%I)',column_name,column_name,column_name,column_name);
  END LOOP;
END; $$;
ALTER TABLE agents_platform.usage_ledger ALTER COLUMN accounted_tokens TYPE double precision;

ALTER TABLE agents_platform.tasks ALTER COLUMN deadline_at DROP NOT NULL;
