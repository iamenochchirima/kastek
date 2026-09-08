import { describe, expect, it } from "vitest";
import { buildMcpAuthorizationUrl, createPkcePair } from "../src/mcp/oauth";

describe("MCP OAuth browser flow", () => {
  it("creates an RFC 7636 PKCE pair with an opaque state", () => {
    const first = createPkcePair();
    const second = createPkcePair();

    expect(first.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });

  it("builds the provider authorization URL without exposing a client secret", () => {
    const pkce = createPkcePair();
    const authorizationUrl = buildMcpAuthorizationUrl({
      client: {
        clientId: "client-123",
        clientSecret: "must-not-appear",
        authorizationEndpoint: "https://provider.example/oauth/authorize",
        tokenEndpoint: "https://provider.example/oauth/token",
        resource: "https://provider.example/mcp",
        scope: "openid tools",
      },
      redirectUri: "https://app.example/api/agents/v1/integrations/mcp/oauth/callback",
      state: pkce.state,
      codeChallenge: pkce.codeChallenge,
    });
    const parsed = new URL(authorizationUrl);

    expect(parsed.searchParams.get("client_id")).toBe("client-123");
    expect(parsed.searchParams.get("code_challenge")).toBe(pkce.codeChallenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("resource")).toBe("https://provider.example/mcp");
    expect(parsed.searchParams.get("scope")).toBe("openid tools");
    expect(authorizationUrl).not.toContain("must-not-appear");
  });
});
