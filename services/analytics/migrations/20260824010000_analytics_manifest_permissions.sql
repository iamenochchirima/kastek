-- Source manifests are authenticated capability and heartbeat records, not domain events.
-- Enable them for the currently supported Core and Tenant producers without changing the
-- permissions of Agent Platform until its manifest producer is implemented.

UPDATE analytics.producer
SET permitted_record_categories = permitted_record_categories || '["manifest"]'::JSONB,
    updated_at = NOW()
WHERE producer_id IN ('core-customer-analytics', 'tenant-platform-customer-analytics')
  AND NOT (permitted_record_categories ? 'manifest');
