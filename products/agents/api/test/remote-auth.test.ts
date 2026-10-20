import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeRemote, remoteAuthFetch, remoteEndpoint, type RemoteAuthorization } from "../src/product/connections/remote-auth";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

async function provider() {
  let origin = "", registered = 0, tokenCalls = 0, challenge = "";
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    const path = request.url!;
    if (path === "/mcp" || path.startsWith("/.well-known/oauth-protected-resource")) return response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["records:read"] }));
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return response.end(JSON.stringify({ issuer: origin,
      authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true }));
    if (path === "/register") { registered++; return response.end(JSON.stringify({ ...JSON.parse(body), client_id: "registered-client" })); }
    if (path === "/token") {
      tokenCalls++; const input = new URLSearchParams(body);
      expect(input.get("resource")).toBe(`${origin}/mcp`);
      if (input.get("grant_type") === "authorization_code") {
        expect(createHash("sha256").update(input.get("code_verifier")!).digest("base64url")).toBe(challenge);
        expect(input.get("code")).toBe("valid-code");
      } else expect(input.get("refresh_token")).toBe("refresh-first");
      return response.end(JSON.stringify({ access_token: `access-${tokenCalls}`, refresh_token: tokenCalls === 1 ? "refresh-first" : "refresh-rotated", token_type: "Bearer", expires_in: 3600, scope: "records:read" }));
    }
    response.writeHead(404).end("{}");
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error(); origin = `http://127.0.0.1:${address.port}`;
  return { origin, challenge: (value: string) => { challenge = value; }, counts: () => ({ registered, tokenCalls }) };
}

describe("remote MCP authorization", () => {
  it("uses discovery, DCR and PKCE, persists the redirect round trip and rotates refresh tokens", async () => {
    const fixture = await provider();
    const options = { endpoint: `${fixture.origin}/mcp`, callbackUrl: "http://127.0.0.1:3100/api/connections/oauth/callback", testLoopback: true };
    const data: RemoteAuthorization = { state: "opaque-session-bound-state" };
    expect(await authorizeRemote(options, data)).toBe("REDIRECT");
    const consent = new URL(data.authorizationUrl!);
    expect(consent.searchParams.get("state")).toBe(data.state);
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    fixture.challenge(consent.searchParams.get("code_challenge")!);
    const persisted = JSON.parse(JSON.stringify(data)) as RemoteAuthorization;
    expect(await authorizeRemote(options, persisted, { code: "valid-code", issuer: fixture.origin })).toBe("AUTHORIZED");
    expect(persisted.tokens?.access_token).toBe("access-1");
    expect(await authorizeRemote(options, persisted)).toBe("AUTHORIZED");
    expect(persisted.tokens?.refresh_token).toBe("refresh-rotated");
    expect(fixture.counts()).toEqual({ registered: 1, tokenCalls: 2 });
  });

  it("rejects an issuer mix-up before sending the authorization code", async () => {
    const fixture = await provider(), data: RemoteAuthorization = { state: "session-state" };
    const options = { endpoint: `${fixture.origin}/mcp`, callbackUrl: "http://127.0.0.1:3100/callback", testLoopback: true };
    await authorizeRemote(options, data);
    await expect(authorizeRemote(options, data, { code: "valid-code", issuer: "https://other.example" })).rejects.toThrow();
    expect(fixture.counts().tokenCalls).toBe(0);
  });

  it("preserves authentication challenges while denying private endpoints and redirects", async () => {
    expect(() => remoteEndpoint("http://localhost:8080/mcp")).toThrow();
    expect(() => remoteEndpoint("https://169.254.169.254/mcp")).toThrow();
    expect(() => remoteEndpoint("https://user:secret@example.com/mcp")).toThrow();
    expect(() => remoteEndpoint("https://example.com/mcp#secret")).toThrow();
    const server = createServer((request, response) => request.url === "/redirect"
      ? response.writeHead(302, { location: "/challenge" }).end()
      : response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://example.com/metadata"' }).end());
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error(); const origin = `http://127.0.0.1:${address.port}`;
    const request = remoteAuthFetch(true);
    const challenge = await request(`${origin}/challenge`);
    expect(challenge.status).toBe(401); expect(challenge.headers.get("www-authenticate")).toContain("resource_metadata");
    await expect(request(`${origin}/redirect`)).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  });
});
