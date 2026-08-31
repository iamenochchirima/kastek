import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, query } from "../src/db/pool";
import { runWithDatabaseContext } from "../src/db/context";

const adminUrl = process.env.AGENTS_DATABASE_URL;
const restrictedUrl = process.env.AGENTS_RLS_TEST_DATABASE_URL;
const runIntegration = Boolean(adminUrl && restrictedUrl && process.env.RUN_AGENTS_RLS_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("identity, credential, channel, and effect RLS (integration)", () => {
  const adminPool = createPool({ AGENTS_DATABASE_URL: adminUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const restrictedPool = createPool({ AGENTS_DATABASE_URL: restrictedUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const organizationA = `rls-identity-a-${randomUUID()}`;
  const organizationB = `rls-identity-b-${randomUUID()}`;
  const systemOrganization = "kasitek-system";
  const definitionA = randomUUID();
  const definitionB = randomUUID();
  const systemDefinition = randomUUID();
  const versionA = randomUUID();
  const versionB = randomUUID();
  const systemVersion = randomUUID();
  const installationA = randomUUID();
  const installationB = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  const toolGrantA = randomUUID();
  const toolGrantB = randomUUID();
  const systemToolGrant = randomUUID();
  const deploymentA = randomUUID();
  const deploymentB = randomUUID();
  const modelCredentialA = randomUUID();
  const modelCredentialB = randomUUID();
  const channelCredentialA = randomUUID();
  const channelCredentialB = randomUUID();
  const connectionA = randomUUID();
  const connectionB = randomUUID();
  const bindingA = randomUUID();
  const bindingB = randomUUID();
  const pairingA = randomUUID();
  const pairingB = randomUUID();
  const installationCredentialA = randomUUID();
  const installationCredentialB = randomUUID();
  const resourceGrantA = randomUUID();
  const resourceGrantB = randomUUID();
  const connectorGrantA = randomUUID();
  const connectorGrantB = randomUUID();
  const usageA = randomUUID();
  const usageB = randomUUID();
  const integrationCredentialA = randomUUID();
  const integrationCredentialB = randomUUID();
  const integrationConnectionA = randomUUID();
  const integrationConnectionB = randomUUID();
  const oauthStateA = randomUUID();
  const oauthStateB = randomUUID();
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const effectA = randomUUID();
  const effectB = randomUUID();
  const approvalA = randomUUID();
  const approvalB = randomUUID();
  const scheduleA = randomUUID();
  const scheduleB = randomUUID();
  const killSwitchA = randomUUID();
  const killSwitchB = randomUUID();
  const globalKillSwitch = randomUUID();

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO agent_definitions (id, organization_id, owner_type, protected, name, slug, created_by)
       VALUES ($1, $2, 'organization', false, 'Identity RLS A', $3, 'rls-test'),
              ($4, $5, 'organization', false, 'Identity RLS B', $6, 'rls-test'),
              ($7, $8, 'system', true, 'Identity RLS system', $9, 'rls-test')`,
      [definitionA, organizationA, `identity-rls-${definitionA}`, definitionB, organizationB, `identity-rls-${definitionB}`, systemDefinition, systemOrganization, `identity-rls-${systemDefinition}`],
    );
    await adminPool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, status, instructions, checksum, created_by)
       VALUES ($1, $2, 1, 'published', 'test', $3, 'rls-test'),
              ($4, $5, 1, 'published', 'test', $6, 'rls-test'),
              ($7, $8, 1, 'published', 'test', $9, 'rls-test')`,
      [versionA, definitionA, `checksum-${versionA}`, versionB, definitionB, `checksum-${versionB}`, systemVersion, systemDefinition, `checksum-${systemVersion}`],
    );
    await adminPool.query(
      `INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, status, created_by, execution_mode, release_mode)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'active', 'rls-test', 'external_connected', 'pinned'),
              ($5, $6, $7, $8, 'organization', $8, 'active', 'rls-test', 'external_connected', 'pinned')`,
      [installationA, definitionA, versionA, organizationA, installationB, definitionB, versionB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO agent_principals (id, installation_id, organization_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [principalA, installationA, organizationA, principalB, installationB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO agent_tool_grants (id, organization_id, agent_version_id, installation_id, tool_name, granted_by)
       VALUES ($1, $2, $3, $4, 'tenant.tool', 'rls-test'),
              ($5, $6, $7, $8, 'tenant.tool', 'rls-test'),
              ($9, $10, $11, NULL, 'system.tool', 'rls-test')`,
      [toolGrantA, organizationA, versionA, installationA, toolGrantB, organizationB, versionB, installationB, systemToolGrant, systemOrganization, systemVersion],
    );
    await adminPool.query(
      `INSERT INTO agent_installation_deployments
         (id, organization_id, installation_id, agent_definition_id, agent_version_id, release_mode, action, trigger, outcome, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, 'pinned', 'deployed', 'manual', 'success', 'human', 'rls-test'),
              ($6, $7, $8, $9, $10, 'pinned', 'deployed', 'manual', 'success', 'human', 'rls-test')`,
      [deploymentA, organizationA, installationA, definitionA, versionA, deploymentB, organizationB, installationB, definitionB, versionB],
    );
    await adminPool.query(
      `INSERT INTO credential_vault (id, organization_id, provider, encrypted_payload, created_by)
       VALUES ($1, $2, 'openai', 'encrypted-a', 'rls-test'), ($3, $4, 'openai', 'encrypted-b', 'rls-test')`,
      [modelCredentialA, organizationA, modelCredentialB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO channel_credentials (id, organization_id, provider, encrypted_payload, created_by)
       VALUES ($1, $2, 'telegram', 'encrypted-a', 'rls-test'), ($3, $4, 'telegram', 'encrypted-b', 'rls-test')`,
      [channelCredentialA, organizationA, channelCredentialB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO channel_connections (id, organization_id, installation_id, channel_type, channel_key, credential_reference, created_by)
       VALUES ($1, $2, $3, 'telegram', $4, $5, 'rls-test'), ($6, $7, $8, 'telegram', $9, $10, 'rls-test')`,
      [connectionA, organizationA, installationA, `connection-${connectionA}`, channelCredentialA, connectionB, organizationB, installationB, `connection-${connectionB}`, channelCredentialB],
    );
    await adminPool.query(
      `INSERT INTO channel_bindings (id, organization_id, installation_id, channel_connection_id, channel_type, external_identity)
       VALUES ($1, $2, $3, $4, 'telegram', $5), ($6, $7, $8, $9, 'telegram', $10)`,
      [bindingA, organizationA, installationA, connectionA, `identity-${bindingA}`, bindingB, organizationB, installationB, connectionB, `identity-${bindingB}`],
    );
    await adminPool.query(
      `INSERT INTO channel_pairing_tokens (id, organization_id, installation_id, connection_id, token_hash, external_identity, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour', 'rls-test'),
              ($7, $8, $9, $10, $11, $12, now() + interval '1 hour', 'rls-test')`,
      [pairingA, organizationA, installationA, connectionA, `hash-${pairingA}`, `identity-${pairingA}`, pairingB, organizationB, installationB, connectionB, `hash-${pairingB}`, `identity-${pairingB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_installation_credentials (id, installation_id, organization_id, label, secret_hash, created_by)
       VALUES ($1, $2, $3, 'credential A', 'scrypt$test$safe', 'rls-test'), ($4, $5, $6, 'credential B', 'scrypt$test$safe', 'rls-test')`,
      [installationCredentialA, installationA, organizationA, installationCredentialB, installationB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO agent_installation_resource_grants (id, organization_id, installation_id, resource_type, resource_id, granted_by)
       VALUES ($1, $2, $3, 'content_post', $4, 'rls-test'), ($5, $6, $7, 'content_post', $8, 'rls-test')`,
      [resourceGrantA, organizationA, installationA, `resource-${resourceGrantA}`, resourceGrantB, organizationB, installationB, `resource-${resourceGrantB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_installation_connector_grants (id, organization_id, installation_id, connector_id, granted_by)
       VALUES ($1, $2, $3, $4, 'rls-test'), ($5, $6, $7, $8, 'rls-test')`,
      [connectorGrantA, organizationA, installationA, `connector-${connectorGrantA}`, connectorGrantB, organizationB, installationB, `connector-${connectorGrantB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_usage_records (id, organization_id, installation_id, credential_id, usage_type)
       VALUES ($1, $2, $3, $4, 'tool'), ($5, $6, $7, $8, 'tool')`,
      [usageA, organizationA, installationA, installationCredentialA, usageB, organizationB, installationB, installationCredentialB],
    );
    await adminPool.query(
      `INSERT INTO integration_credentials (id, organization_id, integration_id, encrypted_payload, created_by)
       VALUES ($1, $2, 'calendar', 'encrypted-a', 'rls-test'), ($3, $4, 'calendar', 'encrypted-b', 'rls-test')`,
      [integrationCredentialA, organizationA, integrationCredentialB, organizationB],
    );
    await adminPool.query(
      `INSERT INTO integration_connections (id, organization_id, installation_id, integration_id, credential_id, status, created_by)
       VALUES ($1, $2, $3, 'calendar', $4, 'connected', 'rls-test'), ($5, $6, $7, 'calendar', $8, 'connected', 'rls-test')`,
      [integrationConnectionA, organizationA, installationA, integrationCredentialA, integrationConnectionB, organizationB, installationB, integrationCredentialB],
    );
    await adminPool.query(
      `INSERT INTO integration_oauth_states (id, organization_id, installation_id, integration_id, state_hash, redirect_uri, created_by, expires_at)
       VALUES ($1, $2, $3, 'calendar', $4, 'https://example.test/callback', 'rls-test', now() + interval '1 hour'),
              ($5, $6, $7, 'calendar', $8, 'https://example.test/callback', 'rls-test', now() + interval '1 hour')`,
      [oauthStateA, organizationA, installationA, `state-${oauthStateA}`, oauthStateB, organizationB, installationB, `state-${oauthStateB}`],
    );
    await adminPool.query(
      `INSERT INTO conversations (id, installation_id, organization_id, channel_type, channel_key, external_conversation_id, conversation_kind)
       VALUES ($1, $2, $3, 'test', 'rls', $4, 'test'), ($5, $6, $7, 'test', 'rls', $8, 'test')`,
      [conversationA, installationA, organizationA, `conversation-${conversationA}`, conversationB, installationB, organizationB, `conversation-${conversationB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, input, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'message', 'completed', '{}'::jsonb, gen_random_uuid(), 'rls-test'),
              ($7, $8, $9, $10, $11, $12, 'message', 'completed', '{}'::jsonb, gen_random_uuid(), 'rls-test')`,
      [runA, organizationA, definitionA, versionA, installationA, conversationA, runB, organizationB, definitionB, versionB, installationB, conversationB],
    );
    await adminPool.query(
      `INSERT INTO agent_effect_receipts (id, organization_id, installation_id, run_id, provider_tool_call_id, capability, capability_version, arguments_hash, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, 'test.effect', '1', 'hash', $6, 'reserved'),
              ($7, $8, $9, $10, $11, 'test.effect', '1', 'hash', $12, 'reserved')`,
      [effectA, organizationA, installationA, runA, `effect-${effectA}`, `effect-key-${effectA}`, effectB, organizationB, installationB, runB, `effect-${effectB}`, `effect-key-${effectB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_approval_records (id, organization_id, installation_id, run_id, provider_tool_call_id, capability, capability_version, arguments_hash, preview_revision, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'test.effect', '1', 'hash', 'preview', 'pending', now() + interval '1 hour'),
              ($6, $7, $8, $9, $10, 'test.effect', '1', 'hash', 'preview', 'pending', now() + interval '1 hour')`,
      [approvalA, organizationA, installationA, runA, `approval-${approvalA}`, approvalB, organizationB, installationB, runB, `approval-${approvalB}`],
    );
    await adminPool.query(
      `INSERT INTO agent_schedules (id, organization_id, installation_id, expression, created_by)
       VALUES ($1, $2, $3, '@hourly', 'rls-test'), ($4, $5, $6, '@hourly', 'rls-test')`,
      [scheduleA, organizationA, installationA, scheduleB, organizationB, installationB],
    );
    await adminPool.query(
      `INSERT INTO agent_kill_switches (id, organization_id, scope_type, scope_id, reason, created_by)
       VALUES ($1, $2, 'organization', $2, 'tenant A', 'rls-test'),
              ($3, $4, 'organization', $4, 'tenant B', 'rls-test'),
              ($5, NULL, 'global', 'global', 'platform', 'rls-test')`,
      [killSwitchA, organizationA, killSwitchB, organizationB, globalKillSwitch],
    );
    await adminPool.query(
      `INSERT INTO agent_client_assertion_replays (credential_id, jti, expires_at)
       VALUES ($1, $2, now() + interval '1 hour'), ($3, $4, now() + interval '1 hour')`,
      [installationCredentialA, `jti-${installationCredentialA}`, installationCredentialB, `jti-${installationCredentialB}`],
    );
  });

  it("keeps tenant identity, credential, channel, and execution rows scoped", async () => {
    const result = await runWithDatabaseContext({ organizationId: organizationA, actorId: "rls-test" }, async () => {
      const definitions = await query<{ id: string }>(restrictedPool, "SELECT id FROM agent_definitions WHERE id IN ($1, $2, $3) ORDER BY id", [definitionA, definitionB, systemDefinition]);
      const versions = await query<{ id: string }>(restrictedPool, "SELECT id FROM agent_versions WHERE id IN ($1, $2, $3) ORDER BY id", [versionA, versionB, systemVersion]);
      const rows: Record<string, number> = {};
      const tableIds: Record<string, string[]> = {
        agent_installations: [installationA, installationB],
        agent_principals: [principalA, principalB],
        agent_tool_grants: [toolGrantA, toolGrantB, systemToolGrant],
        agent_installation_deployments: [deploymentA, deploymentB],
        credential_vault: [modelCredentialA, modelCredentialB],
        channel_credentials: [channelCredentialA, channelCredentialB],
        channel_connections: [connectionA, connectionB],
        channel_bindings: [bindingA, bindingB],
        channel_pairing_tokens: [pairingA, pairingB],
        agent_installation_credentials: [installationCredentialA, installationCredentialB],
        agent_installation_resource_grants: [resourceGrantA, resourceGrantB],
        agent_installation_connector_grants: [connectorGrantA, connectorGrantB],
        agent_usage_records: [usageA, usageB],
        integration_credentials: [integrationCredentialA, integrationCredentialB],
        integration_connections: [integrationConnectionA, integrationConnectionB],
        integration_oauth_states: [oauthStateA, oauthStateB],
        agent_effect_receipts: [effectA, effectB],
        agent_approval_records: [approvalA, approvalB],
        agent_schedules: [scheduleA, scheduleB],
      };
      for (const [table, ids] of Object.entries(tableIds)) {
        const scoped = await query<{ id: string }>(restrictedPool, `SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
        rows[table] = scoped.rows.length;
      }
      const killSwitches = await query<{ id: string }>(restrictedPool, "SELECT id FROM agent_kill_switches WHERE id IN ($1, $2, $3) ORDER BY id", [killSwitchA, killSwitchB, globalKillSwitch]);
      const replays = await query<{ credential_id: string }>(restrictedPool, "SELECT credential_id FROM agent_client_assertion_replays WHERE credential_id IN ($1, $2)", [installationCredentialA, installationCredentialB]);
      return { definitions: definitions.rows, versions: versions.rows, rows, killSwitches: killSwitches.rows, replays: replays.rows };
    });

    expect(result.definitions).toEqual([{ id: definitionA }, { id: systemDefinition }].sort((left, right) => left.id.localeCompare(right.id)));
    expect(result.versions.map((row) => row.id).sort()).toEqual([systemVersion, versionA].sort());
    for (const [table, count] of Object.entries(result.rows)) expect(count, table).toBe(table === "agent_tool_grants" ? 2 : 1);
    expect(result.killSwitches.map((row) => row.id).sort()).toEqual([globalKillSwitch, killSwitchA].sort());
    expect(result.replays).toEqual([]);
  });

  it("rejects tenant writes outside its credential and channel scope", async () => {
    await expect(runWithDatabaseContext({ organizationId: organizationA, actorId: "rls-test" }, () => query(
      restrictedPool,
      `INSERT INTO credential_vault (organization_id, provider, encrypted_payload, created_by)
       VALUES ($1, 'openai', 'cross-tenant', 'rls-test')`,
      [organizationB],
    ))).rejects.toMatchObject({ code: "42501" });

    await expect(runWithDatabaseContext({ organizationId: organizationB, actorId: "rls-test" }, () => query(
      restrictedPool,
      `INSERT INTO channel_bindings (organization_id, installation_id, channel_connection_id, channel_type, external_identity)
       VALUES ($1, $2, $3, 'telegram', $4)`,
      [organizationA, installationA, connectionA, `cross-tenant-${randomUUID()}`],
    ))).rejects.toMatchObject({ code: "42501" });
  });

  it("does not allow a tenant to mutate a protected system definition", async () => {
    const result = await runWithDatabaseContext({ organizationId: organizationA, actorId: "rls-test" }, () => query(
      restrictedPool,
      "UPDATE agent_definitions SET name = 'should not change' WHERE id = $1",
      [systemDefinition],
    ));
    expect(result.rowCount).toBe(0);
    const current = await adminPool.query<{ name: string }>("SELECT name FROM agent_definitions WHERE id = $1", [systemDefinition]);
    expect(current.rows[0]?.name).toBe("Identity RLS system");
  });

  it("exposes all seeded rows only under explicit platform operator scope", async () => {
    const result = await runWithDatabaseContext(
      { organizationId: "platform", actorId: "system:rls-test", operator: true },
      async () => ({
        definitions: await query<{ id: string }>(restrictedPool, "SELECT id FROM agent_definitions WHERE id IN ($1, $2, $3)", [definitionA, definitionB, systemDefinition]),
        credentials: await query<{ id: string }>(restrictedPool, "SELECT id FROM credential_vault WHERE id IN ($1, $2)", [modelCredentialA, modelCredentialB]),
        replays: await query<{ credential_id: string }>(restrictedPool, "SELECT credential_id FROM agent_client_assertion_replays WHERE credential_id IN ($1, $2) ORDER BY credential_id", [installationCredentialA, installationCredentialB]),
      }),
    );
    expect(result.definitions.rows).toHaveLength(3);
    expect(result.credentials.rows).toHaveLength(2);
    expect(result.replays.rows).toHaveLength(2);
  });

  afterAll(async () => {
    await adminPool.query("DELETE FROM agent_client_assertion_replays WHERE credential_id IN ($1, $2)", [installationCredentialA, installationCredentialB]);
    await adminPool.query("DELETE FROM agent_approval_records WHERE id IN ($1, $2)", [approvalA, approvalB]);
    await adminPool.query("DELETE FROM agent_effect_receipts WHERE id IN ($1, $2)", [effectA, effectB]);
    await adminPool.query("DELETE FROM integration_oauth_states WHERE id IN ($1, $2)", [oauthStateA, oauthStateB]);
    await adminPool.query("DELETE FROM integration_connections WHERE id IN ($1, $2)", [integrationConnectionA, integrationConnectionB]);
    await adminPool.query("DELETE FROM integration_credentials WHERE id IN ($1, $2)", [integrationCredentialA, integrationCredentialB]);
    await adminPool.query("DELETE FROM agent_usage_records WHERE id IN ($1, $2)", [usageA, usageB]);
    await adminPool.query("DELETE FROM agent_installation_resource_grants WHERE id IN ($1, $2)", [resourceGrantA, resourceGrantB]);
    await adminPool.query("DELETE FROM agent_installation_connector_grants WHERE id IN ($1, $2)", [connectorGrantA, connectorGrantB]);
    await adminPool.query("DELETE FROM agent_installation_credentials WHERE id IN ($1, $2)", [installationCredentialA, installationCredentialB]);
    await adminPool.query("DELETE FROM channel_pairing_tokens WHERE id IN ($1, $2)", [pairingA, pairingB]);
    await adminPool.query("DELETE FROM channel_bindings WHERE id IN ($1, $2)", [bindingA, bindingB]);
    await adminPool.query("DELETE FROM channel_connections WHERE id IN ($1, $2)", [connectionA, connectionB]);
    await adminPool.query("DELETE FROM channel_credentials WHERE id IN ($1, $2)", [channelCredentialA, channelCredentialB]);
    await adminPool.query("DELETE FROM credential_vault WHERE id IN ($1, $2)", [modelCredentialA, modelCredentialB]);
    await adminPool.query("DELETE FROM agent_schedules WHERE id IN ($1, $2)", [scheduleA, scheduleB]);
    await adminPool.query("DELETE FROM agent_kill_switches WHERE id IN ($1, $2, $3)", [killSwitchA, killSwitchB, globalKillSwitch]);
    await adminPool.query("DELETE FROM agent_installation_deployments WHERE id IN ($1, $2)", [deploymentA, deploymentB]);
    await adminPool.query("DELETE FROM agent_tool_grants WHERE id IN ($1, $2, $3)", [toolGrantA, toolGrantB, systemToolGrant]);
    await adminPool.query("DELETE FROM agent_principals WHERE id IN ($1, $2)", [principalA, principalB]);
    await adminPool.query("DELETE FROM agent_runs WHERE id IN ($1, $2)", [runA, runB]);
    await adminPool.query("DELETE FROM conversations WHERE id IN ($1, $2)", [conversationA, conversationB]);
    await adminPool.query("DELETE FROM agent_installations WHERE id IN ($1, $2)", [installationA, installationB]);
    await adminPool.query("DELETE FROM agent_versions WHERE id IN ($1, $2, $3)", [versionA, versionB, systemVersion]);
    await adminPool.query("DELETE FROM agent_definitions WHERE id IN ($1, $2, $3)", [definitionA, definitionB, systemDefinition]);
    await restrictedPool.end();
    await adminPool.end();
  });
});
