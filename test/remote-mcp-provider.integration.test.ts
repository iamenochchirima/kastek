import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool";
import { RemoteMcpProviderRepository } from "../src/db/repositories/remote-mcp-provider-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("remote MCP provider persistence (integration)", () => {
  const pool = createPool({ AGENTS_DATABASE_URL: databaseUrl!, AGENTS_DATABASE_POOL_MAX: 2, NODE_ENV: "development" } as never);
  const repository = new RemoteMcpProviderRepository(pool);
  const organizationId = `remote-mcp-${randomUUID()}`;
  const actorId = "remote-mcp-test-owner";
  const agentId = randomUUID();
  const agentVersionId = randomUUID();
  let server: Server;
  let endpoint: string;
  let providerId: string;
  let providerVersionId: string;
  let providerReachable = true;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const input = JSON.parse(body) as { method: string };
        response.setHeader("content-type", "application/json");
        if (!providerReachable) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "temporarily unavailable" }));
          return;
        }
        if (input.method === "initialize") {
          response.setHeader("Mcp-Session-Id", "integration-session");
          response.end(JSON.stringify({ jsonrpc: "2.0", id: "kasitek-initialize", result: { protocolVersion: "2025-06-18" } }));
        } else if (input.method === "tools/list") {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: "kasitek-tools-list", result: { tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } }));
        } else {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: "kasitek-tools-call", result: { ok: true } }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
  });

  it("requires discovery and publication before an agent version can pin a provider", async () => {
    const provider = await repository.create(organizationId, actorId, { name: "Test remote provider", endpointUrl: endpoint, timeoutMs: 2_000, maxResponseBytes: 100_000, rateLimitPerMinute: 1 });
    providerId = provider.id;
    const discovered = await repository.discover(organizationId, actorId, provider.id);
    providerVersionId = discovered.id;
    expect(discovered.tools[0]?.name).toBe("lookup");
    expect((await repository.list(organizationId))[0]?.health_status).toBe("healthy");
    await repository.publish(organizationId, actorId, provider.id, discovered.id);

    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Remote MCP test agent', $3, $4)", [agentId, organizationId, `remote-agent-${agentId.slice(0, 8)}`, actorId]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by) VALUES ($1, $2, 1, 'test', 'test', $3)", [agentVersionId, agentId, actorId]);
    await repository.pin(organizationId, actorId, agentVersionId, discovered.id);
    expect((await repository.listPinned(organizationId, agentVersionId)).map((version) => version.id)).toEqual([discovered.id]);
  });

  it("fails closed after a failed health check and recovers after a successful probe", async () => {
    providerReachable = false;
    await expect(repository.healthCheck(organizationId, providerId)).rejects.toThrow("REMOTE_MCP_HTTP_503");
    expect((await repository.list(organizationId))[0]?.health_status).toBe("unhealthy");
    expect(await repository.listPinned(organizationId, agentVersionId)).toEqual([]);

    providerReachable = true;
    await expect(repository.healthCheck(organizationId, providerId)).resolves.toMatchObject({ health_status: "healthy", health_consecutive_failures: 0 });
    expect((await repository.listPinned(organizationId, agentVersionId)).map((version) => version.id)).toEqual([providerVersionId]);
  });

  it("enforces the provider rate limit through a durable window", async () => {
    await expect(repository.callPinnedTool({ organizationId, agentVersionId, providerVersionId, toolName: "lookup", argumentsValue: {} })).resolves.toEqual({ ok: true });
    await expect(repository.callPinnedTool({ organizationId, agentVersionId, providerVersionId, toolName: "lookup", argumentsValue: {} })).rejects.toThrow("REMOTE_MCP_RATE_LIMITED");
  });

  it("revocation removes the provider from effective pins", async () => {
    await repository.revoke(organizationId, actorId, providerId);
    expect(await repository.listPinned(organizationId, agentVersionId)).toEqual([]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_version_mcp_providers WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [agentVersionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    if (providerVersionId) await pool.query("DELETE FROM agent_mcp_provider_versions WHERE id = $1", [providerVersionId]);
    if (providerId) await pool.query("DELETE FROM agent_mcp_providers WHERE id = $1", [providerId]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });
});
