-- Third RLS tranche: agent identity, credentials, channels, schedules, and
-- effect/approval records. Root definitions are readable when they are
-- protected system templates, but tenant writes remain tenant-owned. Child
-- rows must agree with both their organization and their owning installation,
-- version, connection, or run.

CREATE OR REPLACE FUNCTION kasitek_agents_visible_definition(
  row_definition_id UUID,
  row_organization_id TEXT
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agent_definitions definition
    WHERE definition.id = $1
      AND (
        definition.organization_id = $2
        OR (definition.owner_type = 'system' AND definition.protected = TRUE)
      )
  );
$$;

CREATE OR REPLACE FUNCTION kasitek_agents_tenant_definition(row_definition_id UUID) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agent_definitions definition
    WHERE definition.id = $1
      AND definition.organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND definition.owner_type = 'organization'
      AND definition.protected = FALSE
  );
$$;

GRANT EXECUTE ON FUNCTION kasitek_agents_visible_definition(UUID, TEXT) TO kasitek_agents_runtime;
GRANT EXECUTE ON FUNCTION kasitek_agents_tenant_definition(UUID) TO kasitek_agents_runtime;

-- Definitions and versions are the only roots in this tranche. System roots
-- are readable to tenants, while all non-operator mutations are limited to
-- ordinary, unprotected definitions owned by the current organization.
DROP POLICY IF EXISTS agent_definitions_agents_scope ON agent_definitions;
DROP POLICY IF EXISTS agent_definitions_agents_read ON agent_definitions;
DROP POLICY IF EXISTS agent_definitions_agents_insert ON agent_definitions;
DROP POLICY IF EXISTS agent_definitions_agents_update ON agent_definitions;
DROP POLICY IF EXISTS agent_definitions_agents_delete ON agent_definitions;
CREATE POLICY agent_definitions_agents_read ON agent_definitions
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
    OR (owner_type = 'system' AND protected = TRUE)
  );
CREATE POLICY agent_definitions_agents_insert ON agent_definitions
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND owner_type = 'organization'
      AND protected = FALSE
    )
  );
CREATE POLICY agent_definitions_agents_update ON agent_definitions
  FOR UPDATE TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND owner_type = 'organization'
      AND protected = FALSE
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND owner_type = 'organization'
      AND protected = FALSE
    )
  );
CREATE POLICY agent_definitions_agents_delete ON agent_definitions
  FOR DELETE TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND owner_type = 'organization'
      AND protected = FALSE
    )
  );
ALTER TABLE agent_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_versions_agents_scope ON agent_versions;
DROP POLICY IF EXISTS agent_versions_agents_read ON agent_versions;
DROP POLICY IF EXISTS agent_versions_agents_insert ON agent_versions;
DROP POLICY IF EXISTS agent_versions_agents_update ON agent_versions;
DROP POLICY IF EXISTS agent_versions_agents_delete ON agent_versions;
CREATE POLICY agent_versions_agents_read ON agent_versions
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR EXISTS (
      SELECT 1
      FROM agent_definitions definition
      WHERE definition.id = agent_versions.agent_definition_id
        AND (
          definition.organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
          OR (definition.owner_type = 'system' AND definition.protected = TRUE)
        )
    )
  );
CREATE POLICY agent_versions_agents_insert ON agent_versions
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_tenant_definition(agent_definition_id));
CREATE POLICY agent_versions_agents_update ON agent_versions
  FOR UPDATE TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_tenant_definition(agent_definition_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_tenant_definition(agent_definition_id));
CREATE POLICY agent_versions_agents_delete ON agent_versions
  FOR DELETE TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_tenant_definition(agent_definition_id));
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_installations_agents_scope ON agent_installations;
CREATE POLICY agent_installations_agents_scope ON agent_installations
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND kasitek_agents_visible_definition(agent_definition_id, organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_versions version
      WHERE version.id = agent_installations.agent_version_id
        AND version.agent_definition_id = agent_installations.agent_definition_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND kasitek_agents_visible_definition(agent_definition_id, organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_versions version
      WHERE version.id = agent_installations.agent_version_id
        AND version.agent_definition_id = agent_installations.agent_definition_id
    )
  );
ALTER TABLE agent_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_installations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_principals_agents_scope ON agent_principals;
CREATE POLICY agent_principals_agents_scope ON agent_principals
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_installations installation
      WHERE installation.id = agent_principals.installation_id
        AND installation.organization_id = agent_principals.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_installations installation
      WHERE installation.id = agent_principals.installation_id
        AND installation.organization_id = agent_principals.organization_id
    )
  );
ALTER TABLE agent_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_principals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_tool_grants_agents_scope ON agent_tool_grants;
DROP POLICY IF EXISTS agent_tool_grants_agents_read ON agent_tool_grants;
DROP POLICY IF EXISTS agent_tool_grants_agents_write ON agent_tool_grants;
CREATE POLICY agent_tool_grants_agents_read ON agent_tool_grants
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      installation_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM agent_versions version
        JOIN agent_definitions definition ON definition.id = version.agent_definition_id
        WHERE version.id = agent_tool_grants.agent_version_id
          AND definition.owner_type = 'system'
          AND definition.protected = TRUE
      )
    )
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND kasitek_agents_visible_definition(
        (SELECT version.agent_definition_id FROM agent_versions version WHERE version.id = agent_tool_grants.agent_version_id),
        organization_id
      )
      AND (
        installation_id IS NULL
        OR EXISTS (
          SELECT 1 FROM agent_installations installation
          WHERE installation.id = agent_tool_grants.installation_id
            AND installation.organization_id = agent_tool_grants.organization_id
        )
      )
    )
  );
CREATE POLICY agent_tool_grants_agents_write ON agent_tool_grants
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND kasitek_agents_tenant_definition(
        (SELECT version.agent_definition_id FROM agent_versions version WHERE version.id = agent_tool_grants.agent_version_id)
      )
      AND (
        installation_id IS NULL
        OR EXISTS (
          SELECT 1 FROM agent_installations installation
          WHERE installation.id = agent_tool_grants.installation_id
            AND installation.organization_id = agent_tool_grants.organization_id
        )
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND kasitek_agents_tenant_definition(
        (SELECT version.agent_definition_id FROM agent_versions version WHERE version.id = agent_tool_grants.agent_version_id)
      )
      AND (
        installation_id IS NULL
        OR EXISTS (
          SELECT 1 FROM agent_installations installation
          WHERE installation.id = agent_tool_grants.installation_id
            AND installation.organization_id = agent_tool_grants.organization_id
        )
      )
    )
  );
ALTER TABLE agent_tool_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_installation_deployments_agents_scope ON agent_installation_deployments;
DROP POLICY IF EXISTS agent_installation_deployments_agents_read ON agent_installation_deployments;
DROP POLICY IF EXISTS agent_installation_deployments_agents_write ON agent_installation_deployments;
DROP POLICY IF EXISTS agent_installation_deployments_agents_operator ON agent_installation_deployments;
DROP POLICY IF EXISTS agent_installation_deployments_agents_insert ON agent_installation_deployments;
CREATE POLICY agent_installation_deployments_agents_read ON agent_installation_deployments
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_installation_deployments.installation_id
        AND installation.organization_id = agent_installation_deployments.organization_id
        AND installation.agent_definition_id = agent_installation_deployments.agent_definition_id
    )
    AND kasitek_agents_visible_definition(agent_definition_id, organization_id)
    AND (
      agent_version_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_versions version
        WHERE version.id = agent_installation_deployments.agent_version_id
          AND version.agent_definition_id = agent_installation_deployments.agent_definition_id
      )
    )
  );
CREATE POLICY agent_installation_deployments_agents_operator ON agent_installation_deployments
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
CREATE POLICY agent_installation_deployments_agents_insert ON agent_installation_deployments
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND kasitek_agents_tenant_definition(agent_definition_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_installation_deployments.installation_id
        AND installation.organization_id = agent_installation_deployments.organization_id
        AND installation.agent_definition_id = agent_installation_deployments.agent_definition_id
    )
  );
ALTER TABLE agent_installation_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_installation_deployments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credential_vault_agents_scope ON credential_vault;
CREATE POLICY credential_vault_agents_scope ON credential_vault
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_current_org_scope(organization_id));
ALTER TABLE credential_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_vault FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_credentials_agents_scope ON channel_credentials;
CREATE POLICY channel_credentials_agents_scope ON channel_credentials
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_current_org_scope(organization_id));
ALTER TABLE channel_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_credentials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_connections_agents_scope ON channel_connections;
CREATE POLICY channel_connections_agents_scope ON channel_connections
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = channel_connections.installation_id
        AND installation.organization_id = channel_connections.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = channel_connections.installation_id
        AND installation.organization_id = channel_connections.organization_id
    )
  );
ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_bindings_agents_scope ON channel_bindings;
CREATE POLICY channel_bindings_agents_scope ON channel_bindings
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM channel_connections connection
      WHERE connection.id = channel_bindings.channel_connection_id
        AND connection.organization_id = channel_bindings.organization_id
        AND connection.installation_id = channel_bindings.installation_id
        AND connection.channel_type = channel_bindings.channel_type
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = channel_bindings.installation_id
        AND installation.organization_id = channel_bindings.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM channel_connections connection
      WHERE connection.id = channel_bindings.channel_connection_id
        AND connection.organization_id = channel_bindings.organization_id
        AND connection.installation_id = channel_bindings.installation_id
        AND connection.channel_type = channel_bindings.channel_type
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = channel_bindings.installation_id
        AND installation.organization_id = channel_bindings.organization_id
    )
  );
ALTER TABLE channel_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_pairing_tokens_agents_scope ON channel_pairing_tokens;
CREATE POLICY channel_pairing_tokens_agents_scope ON channel_pairing_tokens
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM channel_connections connection
      WHERE connection.id = channel_pairing_tokens.connection_id
        AND connection.organization_id = channel_pairing_tokens.organization_id
        AND connection.installation_id = channel_pairing_tokens.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = channel_pairing_tokens.installation_id
        AND installation.organization_id = channel_pairing_tokens.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM channel_connections connection
      WHERE connection.id = channel_pairing_tokens.connection_id
        AND connection.organization_id = channel_pairing_tokens.organization_id
        AND connection.installation_id = channel_pairing_tokens.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = channel_pairing_tokens.installation_id
        AND installation.organization_id = channel_pairing_tokens.organization_id
    )
  );
ALTER TABLE channel_pairing_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_pairing_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_installation_credentials_agents_scope ON agent_installation_credentials;
CREATE POLICY agent_installation_credentials_agents_scope ON agent_installation_credentials
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_installation_credentials.installation_id
        AND installation.organization_id = agent_installation_credentials.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_installation_credentials.installation_id
        AND installation.organization_id = agent_installation_credentials.organization_id
    )
  );
ALTER TABLE agent_installation_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_installation_credentials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_installation_resource_grants_agents_scope ON agent_installation_resource_grants;
CREATE POLICY agent_installation_resource_grants_agents_scope ON agent_installation_resource_grants
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_installation_resource_grants.installation_id AND installation.organization_id = agent_installation_resource_grants.organization_id)
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_installation_resource_grants.installation_id AND installation.organization_id = agent_installation_resource_grants.organization_id)
  );
ALTER TABLE agent_installation_resource_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_installation_resource_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_installation_connector_grants_agents_scope ON agent_installation_connector_grants;
CREATE POLICY agent_installation_connector_grants_agents_scope ON agent_installation_connector_grants
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_installation_connector_grants.installation_id AND installation.organization_id = agent_installation_connector_grants.organization_id)
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_installation_connector_grants.installation_id AND installation.organization_id = agent_installation_connector_grants.organization_id)
  );
ALTER TABLE agent_installation_connector_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_installation_connector_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_usage_records_agents_scope ON agent_usage_records;
CREATE POLICY agent_usage_records_agents_scope ON agent_usage_records
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_usage_records.installation_id AND installation.organization_id = agent_usage_records.organization_id)
    AND (
      credential_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_installation_credentials credential
        WHERE credential.id = agent_usage_records.credential_id
          AND credential.installation_id = agent_usage_records.installation_id
          AND credential.organization_id = agent_usage_records.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_usage_records.installation_id AND installation.organization_id = agent_usage_records.organization_id)
    AND (
      credential_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_installation_credentials credential
        WHERE credential.id = agent_usage_records.credential_id
          AND credential.installation_id = agent_usage_records.installation_id
          AND credential.organization_id = agent_usage_records.organization_id
      )
    )
  );
ALTER TABLE agent_usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_usage_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integration_credentials_agents_scope ON integration_credentials;
CREATE POLICY integration_credentials_agents_scope ON integration_credentials
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_current_org_scope(organization_id));
ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_credentials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integration_connections_agents_scope ON integration_connections;
CREATE POLICY integration_connections_agents_scope ON integration_connections
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = integration_connections.installation_id AND installation.organization_id = integration_connections.organization_id)
    AND (
      credential_id IS NULL
      OR EXISTS (
        SELECT 1 FROM integration_credentials credential
        WHERE credential.id = integration_connections.credential_id
          AND credential.organization_id = integration_connections.organization_id
          AND credential.integration_id = integration_connections.integration_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = integration_connections.installation_id AND installation.organization_id = integration_connections.organization_id)
    AND (
      credential_id IS NULL
      OR EXISTS (
        SELECT 1 FROM integration_credentials credential
        WHERE credential.id = integration_connections.credential_id
          AND credential.organization_id = integration_connections.organization_id
          AND credential.integration_id = integration_connections.integration_id
      )
    )
  );
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integration_oauth_states_agents_scope ON integration_oauth_states;
CREATE POLICY integration_oauth_states_agents_scope ON integration_oauth_states
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = integration_oauth_states.installation_id AND installation.organization_id = integration_oauth_states.organization_id)
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = integration_oauth_states.installation_id AND installation.organization_id = integration_oauth_states.organization_id)
  );
ALTER TABLE integration_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_oauth_states FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_effect_receipts_agents_scope ON agent_effect_receipts;
CREATE POLICY agent_effect_receipts_agents_scope ON agent_effect_receipts
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = agent_effect_receipts.run_id
        AND run.organization_id = agent_effect_receipts.organization_id
        AND run.installation_id = agent_effect_receipts.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_effect_receipts.installation_id
        AND installation.organization_id = agent_effect_receipts.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = agent_effect_receipts.run_id
        AND run.organization_id = agent_effect_receipts.organization_id
        AND run.installation_id = agent_effect_receipts.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_effect_receipts.installation_id
        AND installation.organization_id = agent_effect_receipts.organization_id
    )
  );
ALTER TABLE agent_effect_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_effect_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_approval_records_agents_scope ON agent_approval_records;
CREATE POLICY agent_approval_records_agents_scope ON agent_approval_records
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = agent_approval_records.run_id
        AND run.organization_id = agent_approval_records.organization_id
        AND run.installation_id = agent_approval_records.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_approval_records.installation_id
        AND installation.organization_id = agent_approval_records.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = agent_approval_records.run_id
        AND run.organization_id = agent_approval_records.organization_id
        AND run.installation_id = agent_approval_records.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_approval_records.installation_id
        AND installation.organization_id = agent_approval_records.organization_id
    )
  );
ALTER TABLE agent_approval_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_approval_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_schedules_agents_scope ON agent_schedules;
CREATE POLICY agent_schedules_agents_scope ON agent_schedules
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_schedules.installation_id AND installation.organization_id = agent_schedules.organization_id)
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_schedules.installation_id AND installation.organization_id = agent_schedules.organization_id)
  );
ALTER TABLE agent_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_schedules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_kill_switches_agents_read ON agent_kill_switches;
DROP POLICY IF EXISTS agent_kill_switches_agents_write ON agent_kill_switches;
DROP POLICY IF EXISTS agent_kill_switches_agents_scope ON agent_kill_switches;
CREATE POLICY agent_kill_switches_agents_read ON agent_kill_switches
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR organization_id IS NULL
    OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
  );
CREATE POLICY agent_kill_switches_agents_write ON agent_kill_switches
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND scope_type <> 'global'
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
      AND scope_type <> 'global'
    )
  );
ALTER TABLE agent_kill_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_kill_switches FORCE ROW LEVEL SECURITY;

-- Replay rows have no denormalized organization column. They are used only
-- during platform-scoped token exchange, so tenant-scoped runtime sessions
-- must never read or mutate them.
DROP POLICY IF EXISTS agent_client_assertion_replays_agents_scope ON agent_client_assertion_replays;
CREATE POLICY agent_client_assertion_replays_agents_scope ON agent_client_assertion_replays
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
ALTER TABLE agent_client_assertion_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_client_assertion_replays FORCE ROW LEVEL SECURITY;
