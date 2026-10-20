import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeRemote,beginRemotePermissionStepUp,remoteAuthOptionsFromEnvironment, remoteAuthFetch, remoteEndpoint, type RemoteAuthorization } from "../src/product/connections/remote-auth";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

async function provider(options:{cimd?:boolean;tokenScope?:string;noRegistration?:boolean}={}) {
  let origin = "", registered = 0, tokenCalls = 0, challenge = "";
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    const path = request.url!;
    if (path === "/mcp" || path.startsWith("/.well-known/oauth-protected-resource")) return response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["records:read"] }));
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return response.end(JSON.stringify({ issuer: origin,
      authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,...(!options.noRegistration?{ registration_endpoint: `${origin}/register`}:{}),client_id_metadata_document_supported:options.cimd??false,
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
      return response.end(JSON.stringify({ access_token: `access-${tokenCalls}`, refresh_token: tokenCalls === 1 ? "refresh-first" : "refresh-rotated", token_type: "Bearer", expires_in: 3600, scope: options.tokenScope??"records:read" }));
    }
    response.writeHead(404).end("{}");
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error(); origin = `http://127.0.0.1:${address.port}`;
  return { origin, challenge: (value: string) => { challenge = value; }, counts: () => ({ registered, tokenCalls }) };
}

describe("remote MCP authorization", () => {
  it("loads bounded operator issuer records with separate environment credential references",()=>{
    const records=[{issuer:"https://identity.example.test",clientIdEnvironment:"TEST_MCP_CLIENT_ID",clientSecretEnvironment:"TEST_MCP_CLIENT_SECRET",authMethod:"client_secret_basic"}];
    const env={AGENTS_MCP_OAUTH_CLIENTS:JSON.stringify(records),TEST_MCP_CLIENT_ID:"configured-client",TEST_MCP_CLIENT_SECRET:"configured-private-secret",AGENTS_MCP_CLIENT_METADATA_URL:"https://agents.example.test/oauth/client.json"};
    expect(remoteAuthOptionsFromEnvironment(env)).toMatchObject({preRegisteredClients:[{issuer:records[0]!.issuer,clientId:"configured-client",clientSecret:"configured-private-secret"}],clientMetadataUrl:env.AGENTS_MCP_CLIENT_METADATA_URL});
    for(const changed of [{TEST_MCP_CLIENT_SECRET:undefined},{AGENTS_MCP_OAUTH_CLIENTS:JSON.stringify([...records,...records])},{AGENTS_MCP_OAUTH_CLIENTS:JSON.stringify([{...records[0],clientSecret:"literal-is-not-a-reference"}])},{AGENTS_MCP_OAUTH_CLIENTS:JSON.stringify([{...records[0],issuer:"http://localhost"}])},{AGENTS_MCP_CLIENT_METADATA_URL:"https://agents.example.test/"}])expect(()=>remoteAuthOptionsFromEnvironment({...env,...changed})).toThrow();
  });
  it("selects a preregistered client only for the discovered issuer before CIMD or DCR and reuses it",async()=>{
    const fixture=await provider({cimd:true}),data:RemoteAuthorization={state:"pre-registered-state"};
    const options={endpoint:`${fixture.origin}/mcp`,callbackUrl:"http://127.0.0.1:3100/callback",clientMetadataUrl:"https://agents.example.test/oauth/client.json",testLoopback:true,
      preRegisteredClients:[{issuer:"https://unrelated.example.test",clientId:"never-forward-this-client"},{issuer:fixture.origin,clientId:"registered-out-of-band"}]};
    expect(await authorizeRemote(options,data)).toBe("REDIRECT");let consent=new URL(data.authorizationUrl!);
    expect(consent.searchParams.get("client_id")).toBe("registered-out-of-band");fixture.challenge(consent.searchParams.get("code_challenge")!);
    const resumed=JSON.parse(JSON.stringify(data));expect(await authorizeRemote(options,resumed,{code:"valid-code",issuer:fixture.origin})).toBe("AUTHORIZED");
    await expect(authorizeRemote({...options,preRegisteredClients:[{issuer:fixture.origin,clientId:"changed-client"}]},resumed)).rejects.toMatchObject({code:"OAUTH_CLIENT_CHANGED"});expect(fixture.counts().tokenCalls).toBe(1);
    resumed.state="reconnect-state";expect(await authorizeRemote(options,resumed,undefined,true)).toBe("REDIRECT");consent=new URL(resumed.authorizationUrl!);
    expect(consent.searchParams.get("client_id")).toBe("registered-out-of-band");expect(fixture.counts()).toEqual({registered:0,tokenCalls:1});
  });
  it("uses advertised CIMD without DCR and falls back to DCR when CIMD is not advertised",async()=>{
    const metadataUrl="https://agents.example.test/oauth/client.json";
    for(const cimd of [true,false]){
      const fixture=await provider({cimd}),data:RemoteAuthorization={state:"metadata-client-state"},options={endpoint:`${fixture.origin}/mcp`,callbackUrl:"http://127.0.0.1:3100/callback",clientMetadataUrl:metadataUrl,testLoopback:true};
      expect(await authorizeRemote(options,data)).toBe("REDIRECT");const consent=new URL(data.authorizationUrl!);
      expect(consent.searchParams.get("client_id")).toBe(cimd?metadataUrl:"registered-client");fixture.challenge(consent.searchParams.get("code_challenge")!);
      expect(await authorizeRemote(options,JSON.parse(JSON.stringify(data)),{code:"valid-code",issuer:fixture.origin})).toBe("AUTHORIZED");expect(fixture.counts().registered).toBe(cimd?0:1);
    }
  });
  it("uses an issuer-bound own client when registration is unavailable and refuses resource changes",async()=>{
    const fixture=await provider({noRegistration:true}),data:RemoteAuthorization={state:"own-client-state",ownClientIssuer:fixture.origin,client:{issuer:fixture.origin,client_id:"own-client",token_endpoint_auth_method:"none"}};
    const options={endpoint:`${fixture.origin}/mcp`,callbackUrl:"http://127.0.0.1:3100/callback",testLoopback:true};
    await authorizeRemote(options,data);const consent=new URL(data.authorizationUrl!);expect(consent.searchParams.get("client_id")).toBe("own-client");fixture.challenge(consent.searchParams.get("code_challenge")!);
    expect(await authorizeRemote(options,data,{code:"valid-code",issuer:fixture.origin})).toBe("AUTHORIZED");
    await expect(authorizeRemote({...options,endpoint:`${fixture.origin}/other-resource`},data)).rejects.toMatchObject({code:"OAUTH_RESOURCE_CHANGED"});expect(fixture.counts()).toEqual({registered:0,tokenCalls:1});
  });
  it("requests bounded step-up consent without refreshing and rejects a denied narrower grant",async()=>{
    const settings={tokenScope:"records:read"},fixture=await provider(settings),data:RemoteAuthorization={state:"initial-state"};
    const options={endpoint:`${fixture.origin}/mcp`,callbackUrl:"http://127.0.0.1:3100/callback",testLoopback:true};
    await authorizeRemote(options,data);fixture.challenge(new URL(data.authorizationUrl!).searchParams.get("code_challenge")!);await authorizeRemote(options,data,{code:"valid-code",issuer:fixture.origin});
    data.state="step-up-state";expect(await beginRemotePermissionStepUp(options,data,{resource:options.endpoint,requiredScope:"records:write"})).toBe("REDIRECT");
    const consent=new URL(data.authorizationUrl!);expect(consent.searchParams.get("scope")).toBe("records:read records:write");expect(fixture.counts().tokenCalls).toBe(1);fixture.challenge(consent.searchParams.get("code_challenge")!);
    await expect(authorizeRemote(options,data,{code:"valid-code",issuer:fixture.origin})).rejects.toMatchObject({code:"OAUTH_SCOPE_DENIED"});
    settings.tokenScope="records:read records:write";data.state="retry-step-up-state";await beginRemotePermissionStepUp(options,data,{resource:options.endpoint,requiredScope:"records:write"});fixture.challenge(new URL(data.authorizationUrl!).searchParams.get("code_challenge")!);
    expect(await authorizeRemote(options,data,{code:"valid-code",issuer:fixture.origin})).toBe("AUTHORIZED");expect(fixture.counts().registered).toBe(1);
    await expect(beginRemotePermissionStepUp(options,data,{resource:options.endpoint,requiredScope:"records:write"})).rejects.toMatchObject({code:"OAUTH_STEP_UP_REPEATED"});
  });
  it("rejects foreign resources, control characters and oversized scope challenges before network",async()=>{
    const fixture=await provider(),options={endpoint:`${fixture.origin}/mcp`,callbackUrl:"http://127.0.0.1:3100/callback",testLoopback:true},data:RemoteAuthorization={state:"bounded-step-up-state",tokens:{access_token:"existing-token",token_type:"Bearer",scope:"records:read"}};
    for(const requiredScope of ["scope\nInjected","x".repeat(2049),Array.from({length:33},(_,i)=>`scope${i}`).join(" ")])await expect(beginRemotePermissionStepUp(options,data,{resource:options.endpoint,requiredScope})).rejects.toMatchObject({code:"OAUTH_SCOPE_INVALID"});
    await expect(beginRemotePermissionStepUp(options,data,{resource:`${fixture.origin}/other`,requiredScope:"records:write"})).rejects.toMatchObject({code:"OAUTH_RESOURCE_CHANGED"});expect(fixture.counts()).toEqual({registered:0,tokenCalls:0});
  });
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
