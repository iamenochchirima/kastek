-- Audit records are append-only evidence. Retention and test cleanup must never
-- mutate or remove an audit row after it has been written.
CREATE OR REPLACE FUNCTION prevent_audit_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_records_immutable_trigger ON audit_records;
CREATE TRIGGER audit_records_immutable_trigger
  BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_record_mutation();
