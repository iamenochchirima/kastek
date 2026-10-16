import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverMcpOAuth, registerMcpOAuthClient } from "../src/mcp/oauth";

const jsonResponse = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("MCP OAuth discovery and registration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the canonical protected-resource metadata URL for root endpoints", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://mcp.calendly.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ resource: "https://mcp.calendly.com/", authorization_servers: ["https://calendly.com/"] });
      }
      if (url === "https://calendly.com/.well-known/oauth-authorization-server") {
        return jsonResponse({ authorization_endpoint: "https://calendly.com/oauth/authorize", token_endpoint: "https://calendly.com/oauth/token", registration_endpoint: "https://calendly.com/oauth/register" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(discoverMcpOAuth({ endpointUrl: "https://mcp.calendly.com", environment: "development" })).resolves.toMatchObject({
      authorizationEndpoint: "https://calendly.com/oauth/authorize",
      tokenEndpoint: "https://calendly.com/oauth/token",
      registrationEndpoint: "https://calendly.com/oauth/register",
    });
    expect(requestedUrls).not.toContain("https://mcp.calendly.com/.well-known/oauth-protected-resource/");
  });

  it("registers a public client with only the grant the runtime supports", async () => {
    let registrationBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://example.com/oauth/register") {
        registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ client_id: "client-123" }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(registerMcpOAuthClient({
      discovery: {
        resource: "https://example.com/mcp",
        authorizationEndpoint: "https://example.com/oauth/authorize",
        tokenEndpoint: "https://example.com/oauth/token",
        registrationEndpoint: "https://example.com/oauth/register",
        scopesSupported: [],
      },
      redirectUri: "https://dev-client.kasitek.co.za/api/agents/integrations/mcp/oauth/callback",
      clientName: "KasiTek Agent Platform",
      environment: "development",
    })).resolves.toMatchObject({ clientId: "client-123" });
    expect(registrationBody?.grant_types).toEqual(["authorization_code"]);
  });
});
