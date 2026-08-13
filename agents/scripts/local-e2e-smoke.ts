import { createHmac, randomUUID } from "node:crypto";

if (typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

type Json = Record<string, unknown>;

const agentApiUrl = (process.env.AGENTS_E2E_API_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");
const gatewayUrl = (process.env.AGENTS_E2E_GATEWAY_URL ?? "http://127.0.0.1:4200").replace(/\/$/, "");
const organizationId = process.env.AGENTS_E2E_ORGANIZATION_ID ?? `e2e-${randomUUID()}`;
const actorId = process.env.AGENTS_E2E_ACTOR_ID ?? "local-e2e";
const keepFixtures = process.env.AGENTS_E2E_KEEP_FIXTURES === "true";

async function request(url: string, init: RequestInit = {}): Promise<Json> {
  let response: Response;
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
    throw new Error(`${init.method ?? "GET"} ${url} could not connect: ${reason}`);
  }
  const body = await response.text();
  let payload: Json;
  try {
    payload = body ? JSON.parse(body) as Json : {};
  } catch {
    throw new Error(`${init.method ?? "GET"} ${url} returned non-JSON HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} failed HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function controlHeaders(): HeadersInit {
  const secret = process.env.AGENTS_E2E_INTERNAL_AUTH_SECRET ?? process.env.INTERNAL_AUTH_SECRET;
  if (secret) {
    const claims = Buffer.from(JSON.stringify({
      organizationId,
      actorId,
      audience: process.env.AGENTS_E2E_INTERNAL_AUTH_AUDIENCE ?? process.env.INTERNAL_AUTH_AUDIENCE ?? "kasitek-agents",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      scopes: ["agents:read", "agents:write", "runs:read", "runs:approve", "runs:cancel"],
    })).toString("base64url");
    const signature = createHmac("sha256", secret).update(claims).digest("base64url");
    return { authorization: `Bearer ${claims}.${signature}` };
  }
  return {
    "x-organization-id": organizationId,
    "x-actor-id": actorId,
  };
}

function id(value: unknown, field: string): string {
  if (!value || typeof value !== "object" || typeof (value as Json)[field] !== "string") {
    throw new Error(`Expected ${field} in response: ${JSON.stringify(value)}`);
  }
  return (value as Json)[field] as string;
}

async function waitForTerminal(installationId: string, runId: string, token: string): Promise<Json> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const operation = await request(`${agentApiUrl}/v1/installations/${installationId}/operations/${runId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const run = operation.run as Json | undefined;
    const status = typeof run?.status === "string" ? run.status : "";
    if (["completed", "failed", "cancelled", "expired"].includes(status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Operation ${runId} did not reach a terminal state within 30 seconds`);
}

async function main(): Promise<void> {
  let agentId: string | undefined;
  try {
    await request(`${agentApiUrl}/health/ready`);
    await request(`${gatewayUrl}/health/ready`);

    const agent = await request(`${agentApiUrl}/v1/agents`, {
      method: "POST",
      headers: controlHeaders(),
      body: JSON.stringify({ name: `E2E smoke ${organizationId}`, slug: `e2e-${organizationId.slice(-12)}` }),
    });
    agentId = id(agent, "id");
    const version = await request(`${agentApiUrl}/v1/agents/${agentId}/versions`, {
      method: "POST",
      headers: controlHeaders(),
      body: JSON.stringify({
        instructions: "Use only the explicitly granted tool when asked.",
        policy: { allowedTools: ["platform.current_time"], maxIterations: 1, maxToolCalls: 1 },
      }),
    });
    const versionId = id(version, "id");
    await request(`${agentApiUrl}/v1/agents/${agentId}/versions/${versionId}/publish`, { method: "POST", headers: controlHeaders() });
    const installation = await request(`${agentApiUrl}/v1/installations`, {
      method: "POST",
      headers: controlHeaders(),
      body: JSON.stringify({ agentVersionId: versionId, scopeType: "organization", scopeId: organizationId }),
    });
    const installationId = id(installation, "id");
    const credentialResponse = await request(`${agentApiUrl}/v1/installations/${installationId}/credentials`, {
      method: "POST",
      headers: controlHeaders(),
      body: JSON.stringify({ label: "local-e2e", mcpScopes: ["mcp:read", "mcp:write"], apiScopes: ["api:read", "api:write"] }),
    });
    const secret = id(credentialResponse, "secret");
    const exchange = async (audience: "mcp" | "kasitek-public-api") => request(`${agentApiUrl}/v1/installation-tokens/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, audience }),
    });
    const apiToken = id(await exchange("kasitek-public-api"), "accessToken");
    const mcpToken = id(await exchange("mcp"), "accessToken");

    const tools = await request(`${agentApiUrl}/v1/installations/${installationId}/tools`, { headers: { authorization: `Bearer ${apiToken}` } });
    if (!Array.isArray(tools.tools) || !tools.tools.some((tool) => tool && typeof tool === "object" && (tool as Json).name === "platform.current_time")) {
      throw new Error("Installation discovery did not return its granted platform.current_time tool");
    }
    const idempotencyKey = `e2e-${randomUUID()}`;
    const call = async () => request(`${agentApiUrl}/v1/installations/${installationId}/tools/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "platform.current_time", arguments: {}, idempotencyKey }),
    });
    const first = await call();
    const retry = await call();
    const runId = id(first, "runId");
    if (id(retry, "runId") !== runId) throw new Error("REST idempotency retry created a second operation");
    const terminal = await waitForTerminal(installationId, runId, apiToken);
    if ((terminal.run as Json | undefined)?.status !== "completed") throw new Error(`REST operation did not complete successfully: ${JSON.stringify(terminal)}`);
    console.log("REST credential exchange, discovery, idempotency, and durable execution passed.");

    const mcpHeaders = { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", "mcp-protocol-version": "2025-06-18" };
    const initialize = await request(`${gatewayUrl}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    if ((initialize.result as Json | undefined)?.protocolVersion !== "2025-06-18") throw new Error("Gateway did not negotiate the supported MCP protocol version");
    console.log("MCP gateway authentication and protocol initialization passed.");
    const mcpCall = await request(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "platform.current_time", arguments: {}, idempotencyKey: `mcp-${randomUUID()}` } }),
    });
    if (!(mcpCall.result as Json | undefined)?.structuredContent) throw new Error(`MCP tool call was not accepted: ${JSON.stringify(mcpCall)}`);

    console.log(JSON.stringify({ status: "passed", organizationId, installationId, restRunId: runId, mcpRunId: ((mcpCall.result as Json).structuredContent as Json).runId }, null, 2));
  } finally {
    if (agentId && !keepFixtures) {
      await request(`${agentApiUrl}/v1/agents/${agentId}/archive`, { method: "POST", headers: controlHeaders() });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
