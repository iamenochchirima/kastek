-- Keep the persisted execution identity visible on audit records whenever the
-- audited resource can be resolved to an installation. The JSON metadata copy
-- preserves compatibility for existing audit consumers while the typed column
-- makes filtering and operator metrics safe and bounded.
ALTER TABLE audit_records
  ADD COLUMN IF NOT EXISTS execution_mode TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_records_execution_mode_check'
      AND conrelid = 'audit_records'::regclass
  ) THEN
    ALTER TABLE audit_records
      ADD CONSTRAINT audit_records_execution_mode_check
      CHECK (execution_mode IS NULL OR execution_mode IN ('system_hosted', 'kasitek_hosted', 'external_connected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audit_records_execution_mode_idx
  ON audit_records (organization_id, execution_mode, created_at DESC);

CREATE OR REPLACE FUNCTION enrich_audit_execution_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  installation_id UUID;
BEGIN
  IF NEW.execution_mode IS NULL THEN
    CASE NEW.resource_type
      WHEN 'agent_installation' THEN
        IF NEW.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          installation_id := NEW.resource_id::UUID;
        END IF;
      WHEN 'agent_installation_credential' THEN
        SELECT c.installation_id INTO installation_id
          FROM agent_installation_credentials c
         WHERE c.id::text = NEW.resource_id;
      WHEN 'agent_tool_grant' THEN
        SELECT g.installation_id INTO installation_id
          FROM agent_tool_grants g
         WHERE g.id::text = NEW.resource_id;
      WHEN 'agent_run', 'agent_effect_receipt', 'agent_approval' THEN
        SELECT r.installation_id INTO installation_id
          FROM agent_runs r
         WHERE r.id::text = NEW.resource_id
        LIMIT 1;
        IF installation_id IS NULL THEN
          SELECT e.installation_id INTO installation_id FROM agent_effect_receipts e WHERE e.id::text = NEW.resource_id;
        END IF;
        IF installation_id IS NULL THEN
          SELECT a.installation_id INTO installation_id FROM agent_approval_records a WHERE a.id::text = NEW.resource_id;
        END IF;
      WHEN 'agent_schedule' THEN
        SELECT s.installation_id INTO installation_id
          FROM agent_schedules s
         WHERE s.id::text = NEW.resource_id;
      WHEN 'channel_connection' THEN
        SELECT c.installation_id INTO installation_id
          FROM channel_connections c
         WHERE c.id::text = NEW.resource_id;
      ELSE
        installation_id := NULL;
    END CASE;
  END IF;

  IF installation_id IS NOT NULL THEN
    SELECT execution_mode INTO NEW.execution_mode
      FROM agent_installations
     WHERE id = installation_id;
  END IF;

  IF NEW.execution_mode IS NOT NULL THEN
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('executionMode', NEW.execution_mode);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_execution_mode_enrichment_trigger ON audit_records;
CREATE TRIGGER audit_execution_mode_enrichment_trigger
BEFORE INSERT ON audit_records
FOR EACH ROW
EXECUTE FUNCTION enrich_audit_execution_mode();

COMMENT ON COLUMN audit_records.execution_mode IS
  'Installation execution identity resolved at audit insertion when the resource belongs to an installation.';
