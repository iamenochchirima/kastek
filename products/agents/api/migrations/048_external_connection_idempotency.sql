-- External-agent creation is a distinct aggregate. Keep the client supplied
-- idempotency key in installation settings so retries cannot create a second
-- runtime identity for the same organization.
CREATE UNIQUE INDEX IF NOT EXISTS agent_external_connection_idempotency_idx
  ON agent_installations (organization_id, ((settings ->> 'externalConnectionKey')))
  WHERE execution_mode = 'external_connected'
    AND settings ? 'externalConnectionKey';
