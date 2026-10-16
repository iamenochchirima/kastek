DO $$
DECLARE
  legacy_constraint TEXT;
BEGIN
  SELECT conname
    INTO legacy_constraint
  FROM pg_constraint
  WHERE conrelid = 'channel_bindings'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (organization_id, channel_type, external_identity)'
  LIMIT 1;

  IF legacy_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE channel_bindings DROP CONSTRAINT %I', legacy_constraint);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_connection_identity_uidx
  ON channel_bindings (organization_id, channel_type, channel_connection_id, external_identity);
