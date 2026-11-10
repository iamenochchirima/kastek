-- A tenant without a billing link can never settle usage. Record the skip so the queue advances.
ALTER TABLE agents_platform.billing_usage_forwarded
  ADD COLUMN skipped_reason text
  CHECK (skipped_reason IS NULL OR length(skipped_reason) BETWEEN 1 AND 64);
