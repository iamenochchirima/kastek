ALTER TABLE memory_records DROP CONSTRAINT IF EXISTS memory_records_status_check;
ALTER TABLE memory_records ADD CONSTRAINT memory_records_status_check
  CHECK (status IN ('active', 'deleted', 'expired', 'quarantined', 'review_pending', 'rejected', 'superseded'));
