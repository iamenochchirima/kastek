-- Growth owns registered growth.agent.* lifecycle events in its existing Core outbox.
UPDATE analytics.producer
SET permitted_contract_namespaces = permitted_contract_namespaces || '["growth"]'::jsonb,
    updated_at = NOW()
WHERE producer_id = 'core-customer-analytics'
  AND service_identity_id = 'core'
  AND NOT permitted_contract_namespaces @> '["growth"]'::jsonb;
