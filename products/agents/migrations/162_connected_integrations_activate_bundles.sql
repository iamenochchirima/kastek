-- A successful integration connection is the Playground activation event.
-- Backfill connector grants for connections created before the activation
-- contract existed; credentials remain in the encrypted integration vault.
INSERT INTO agent_installation_connector_grants (organization_id, installation_id, connector_id, granted_by)
SELECT connection.organization_id,
       connection.installation_id,
       connection.integration_id,
       connection.created_by
FROM integration_connections connection
WHERE connection.status = 'connected'
  AND connection.revoked_at IS NULL
ON CONFLICT (installation_id, connector_id) DO UPDATE
  SET revoked_at = NULL;
