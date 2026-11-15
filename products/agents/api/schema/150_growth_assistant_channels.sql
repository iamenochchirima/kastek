-- Allow the Growth product root agent to serve customer channels.
ALTER TABLE agents_platform.agents
  DROP CONSTRAINT IF EXISTS agents_offering_check;

ALTER TABLE agents_platform.agents
  ADD CONSTRAINT agents_offering_check
  CHECK (offering IN ('faq', 'customer-service', 'growth-assistant'));

ALTER TABLE agents_platform.agents
  DISABLE TRIGGER immutable_agent_offering;

UPDATE agents_platform.agents a
SET offering = 'growth-assistant'
WHERE a.offering IS NULL
  AND a.name = 'Growth assistant'
  AND a.created_by_service->>'product' = 'growth'
  AND EXISTS (
    SELECT 1
    FROM agents_platform.product_execution_tenants t
    WHERE t.product = 'growth'
      AND t.organization_id = a.organization_id
  );

ALTER TABLE agents_platform.agents
  ENABLE TRIGGER immutable_agent_offering;
