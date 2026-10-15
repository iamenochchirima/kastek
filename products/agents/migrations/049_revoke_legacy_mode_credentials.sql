-- Credentials are transport identities for customer-operated runtimes only.
-- Any credential that predates the execution-mode contract and is attached to
-- KasiAi or a KasiTek-hosted installation is revoked without deleting its
-- history. The token gateway also rejects these modes at request time; this
-- migration makes the durable state unambiguous for operators and audits.
WITH revoked AS (
  UPDATE agent_installation_credentials credential
  SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, now()),
      revoked_by = 'system:three-mode-remediation'
  FROM agent_installations installation
  WHERE credential.installation_id = installation.id
    AND credential.organization_id = installation.organization_id
    AND installation.execution_mode <> 'external_connected'
    AND credential.status = 'active'
  RETURNING credential.id, credential.organization_id, credential.installation_id
)
INSERT INTO audit_records
  (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
SELECT organization_id,
       'system',
       'system:three-mode-remediation',
       'agent_installation_credential.revoked_legacy_mode',
       'agent_installation_credential',
       id,
       jsonb_build_object('installationId', installation_id, 'reason', 'credentials are only valid for external_connected installations')
FROM revoked;

COMMENT ON TABLE agent_installation_credentials IS
  'Transport credentials are valid only for external_connected installations; legacy credentials are retained as revoked audit history.';
