import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";
import { issueInstallationToken } from "../src/auth/installation-token";
import { createDefaultTools } from "../src/temporal/activities";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { InstallationCredentialRepository } from "../src/db/repositories/installation-credential-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ToolGrantRepository } from "../src/db/repositories/tool-grant-repository";
import { ToolInvocationRepository } from "../src/db/repositories/tool-invocation-repository";
import { InstallationGrantRepository } from "../src/db/repositories/installation-grant-repository";
import { OperatorControlRepository } from "../src/db/repositories/operator-control-repository";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";
import type { KasitekCoreReadClient } from "../src/core/client";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const organizationId = `rest-mcp-durable-${randomUUID()}`;
const actorId = "rest-mcp-durable-test";

const parityCases = [
  { name: "kasitek.core.workspace_status", method: "getWorkspaceStatus", args: {}, output: { organizationId, connections: [] } },
  { name: "kasitek.core.connections_list", method: "listWorkspaceConnections", args: { provider: "FACEBOOK", limit: 25 }, output: { organizationId, connections: [] } },
  { name: "kasitek.core.workspace_report", method: "getWorkspaceReport", args: {}, output: { organizationId, connections: {}, content: {}, contacts: {}, inbox: {}, bookings: {}, campaigns: {}, templates: {} } },
  { name: "kasitek.core.booking_services_list", method: "listBookingServices", args: { limit: 25 }, output: { services: [], total: 0, hasMore: false } },
  { name: "kasitek.core.bookings_list", method: "listBookings", args: { limit: 25 }, output: { bookings: [] } },
  { name: "kasitek.core.campaigns_list", method: "listCampaigns", args: { limit: 25 }, output: { campaigns: [] } },
  { name: "kasitek.core.templates_list", method: "listTemplates", args: { status: "APPROVED", limit: 25 }, output: { templates: [] } },
  { name: "kasitek.core.contacts_list", method: "listContacts", args: { q: "Ada", optIn: "true", limit: 25 }, output: { contacts: [], totalContacts: 0 } },
  { name: "kasitek.core.inbox_conversations_list", method: "listInboxConversations", args: { limit: 25 }, output: { conversations: [] } },
  { name: "kasitek.core.content_posts_list", method: "listContentPosts", args: {}, output: { posts: [] } },
] as const;

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: databaseUrl ?? "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 2,
  TEMPORAL_ENABLED: false,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
  INSTALLATION_TOKEN_PRIVATE_KEY: privateKey,
  INSTALLATION_TOKEN_ISSUER: "rest-mcp-durable-parity",
};

describe.skipIf(!runIntegration)("database-backed MCP and installation REST parity", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const credentials = new InstallationCredentialRepository(pool);
  const runs = new RunRepository(pool);
  const toolGrants = new ToolGrantRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const installationGrants = new InstallationGrantRepository(pool);
  const controls = new OperatorControlRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  let installationId = "";
  let credentialId = "";

  function token(audience: "mcp" | "kasitek-public-api"): string {
    return issueInstallationToken({
      privateKeyPem: privateKey,
      issuer: config.INSTALLATION_TOKEN_ISSUER,
      installationId,
      organizationId,
      credentialId,
      audience,
    }).accessToken;
  }

  beforeAll(async () => {
    const aggregate = await agents.createExternalInstallation(organizationId, actorId, {
      name: "REST/MCP parity",
      slug: `rest-mcp-${randomUUID()}`,
      runtime: "test",
      protocols: ["mcp", "rest"],
      capabilities: parityCases.map((testCase) => testCase.name),
      resources: [],
      connectors: [],
      instructions: "Exercise the local protocol parity contract.",
      credentialLabel: "local parity",
      idempotencyKey: `rest-mcp-${randomUUID()}`,
    });
    installationId = aggregate.installation.id;
    credentialId = aggregate.credential!.credential.id;
    await pool.query("SELECT 1");
  });

  it("persists the same bounded read outcomes through MCP and installation REST", async () => {
    const coreMethods: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const testCase of parityCases) coreMethods[testCase.method] = async () => testCase.output;
    const app = buildApp({
      config,
      pool,
      agents,
      runs,
      toolGrants,
      toolInvocations,
      installationGrants,
      controls,
      killSwitches,
      credentials: undefined,
      installationCredentials: credentials,
      toolRegistry: createDefaultTools(coreMethods as unknown as KasitekCoreReadClient),
    });
    try {
      for (const [index, testCase] of parityCases.entries()) {
        const mcp = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${token("mcp")}` },
          payload: { jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: testCase.name, arguments: testCase.args, idempotencyKey: `durable-mcp-${index}-key` } },
        });
        const rest = await app.inject({
          method: "POST",
          url: `/v1/installations/${installationId}/tools/call`,
          headers: { authorization: `Bearer ${token("kasitek-public-api")}` },
          payload: { name: testCase.name, arguments: testCase.args, idempotencyKey: `durable-rest-${index}-key` },
        });

        expect(mcp.statusCode, testCase.name).toBe(200);
        expect(rest.statusCode, `${testCase.name}: ${rest.body}`).toBe(202);
        expect(mcp.json()).toMatchObject({ result: { structuredContent: { status: "completed", output: testCase.output } } });
        expect(rest.json()).toMatchObject({ status: "completed", output: testCase.output });
      }

      const persistedRuns = await pool.query<{ status: string; count: string }>("SELECT status, COUNT(*)::text AS count FROM agent_runs WHERE organization_id = $1 GROUP BY status", [organizationId]);
      expect(persistedRuns.rows).toEqual([{ status: "completed", count: String(parityCases.length * 2) }]);
      const persistedInvocations = await pool.query<{ status: string; count: string }>("SELECT status, COUNT(*)::text AS count FROM tool_invocations WHERE organization_id = $1 GROUP BY status", [organizationId]);
      expect(persistedInvocations.rows).toEqual([{ status: "completed", count: String(parityCases.length * 2) }]);
      const persistedEvents = await pool.query<{ event_type: string; count: string }>("SELECT event_type, COUNT(*)::text AS count FROM agent_events WHERE organization_id = $1 GROUP BY event_type", [organizationId]);
      expect(persistedEvents.rows).toEqual(expect.arrayContaining([
        { event_type: "run.received", count: String(parityCases.length * 2) },
        { event_type: "run.queued", count: String(parityCases.length * 2) },
        { event_type: "run.running", count: String(parityCases.length * 2) },
        { event_type: "run.completed", count: String(parityCases.length * 2) },
      ]));
      const operations = await runs.listInstallationOperations(organizationId, installationId, 100);
      expect(operations).toHaveLength(parityCases.length * 2);
      expect(new Set(operations.map((operation) => operation.transport))).toEqual(new Set(["mcp", "rest"]));
      const summary = await runs.installationOperationSummary(organizationId, installationId);
      expect(summary).toMatchObject({ total: parityCases.length * 2, toolInvocations: parityCases.length * 2 });
      expect(summary.byStatus.completed).toBe(parityCases.length * 2);
      const operationResponse = await app.inject({
        method: "GET",
        url: `/v1/installations/${installationId}/operations?limit=100`,
        headers: { "x-organization-id": organizationId, "x-actor-id": actorId },
      });
      expect(operationResponse.statusCode).toBe(200);
      expect(operationResponse.json()).toMatchObject({ installationId, summary: { total: parityCases.length * 2 } });
    } finally {
      await app.close();
    }
  }, 30_000);

  afterAll(async () => {
    await pool.query("DELETE FROM tool_invocations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_steps WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_workflow_state WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_usage_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installation_resource_grants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installation_connector_grants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installation_credentials WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_tool_grants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id IN (SELECT id FROM agent_definitions WHERE organization_id = $1)", [organizationId]);
    await pool.query("DELETE FROM agent_definitions WHERE organization_id = $1", [organizationId]);
    await pool.end();
  });
});
