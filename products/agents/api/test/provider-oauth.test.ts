import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ServerMetadata } from "openid-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nativeProviderConnectors, type NativeConnectorConfiguration } from "../src/adapters/providers/connector-registry";
import { NativeProviderOAuth, providerOAuthConfigFromEnvironment, providerScopes, type ProviderOAuthAttempt, type ProviderOAuthTokens } from "../src/product/connections/provider-oauth";

const microsoft = nativeProviderConnectors.find(item => item.id === "microsoft-calendar")!;
const hubspot = nativeProviderConnectors.find(item => item.id === "hubspot")!;

describe("native provider OAuth configuration", () => {
  const environment = (definition: NativeConnectorConfiguration, origin: string): NodeJS.ProcessEnv => ({
    NODE_ENV: "development", AGENTS_PUBLIC_URL: origin,
    [definition.auth.environment.clientId]: "fixture-client", [definition.auth.environment.clientSecret]: "fixture-secret",
    [definition.auth.environment.callbackUrl]: `${origin}${definition.auth.callbackPath}`,
  });
  it.each([microsoft, hubspot])("supports scoped server configuration for $id", definition => {
    expect(providerOAuthConfigFromEnvironment(definition, environment(definition, "http://localhost:3100"))).toMatchObject({ clientId: "fixture-client", appUrl: "http://localhost:3100/" });
    expect(providerOAuthConfigFromEnvironment(definition, { ...environment(definition, "https://agents.example.test"), NODE_ENV: "production" })).toBeDefined();
    expect(providerOAuthConfigFromEnvironment(definition, { ...environment(definition, "http://localhost:3100"), NODE_ENV: "production" })).toBeUndefined();
  });
  it.each(["http://agents.example.test", "https://user:secret@agents.example.test", "https://agents.example.test?secret=yes", "https://agents.example.test#fragment", "https://agents.example.test/path"])("rejects unsafe app URL %s", origin => {
    expect(providerOAuthConfigFromEnvironment(microsoft, environment(microsoft, origin))).toBeUndefined();
  });
  it("rejects cross-origin or wrong-path callbacks and missing configuration", () => {
    const env = environment(microsoft, "https://agents.example.test"), callback = microsoft.auth.environment.callbackUrl;
    expect(providerOAuthConfigFromEnvironment(microsoft, { ...env, [callback]: "https://other.example.test" + microsoft.auth.callbackPath })).toBeUndefined();
    expect(providerOAuthConfigFromEnvironment(microsoft, { ...env, [callback]: "https://agents.example.test/wrong" })).toBeUndefined();
    expect(providerOAuthConfigFromEnvironment(microsoft, {})).toBeUndefined();
  });
  it("derives minimum operation scopes and rejects unknown or duplicate action grants", () => {
    expect(providerScopes(microsoft, ["calendar.availability"])).toContain("Calendars.Read");
    expect(providerScopes(microsoft, ["calendar.availability"])).not.toContain("Calendars.ReadWrite");
    expect(providerScopes(hubspot, ["contacts.search"])).toEqual(["crm.objects.contacts.read"]);
    expect(() => providerScopes(hubspot, ["invented"])).toThrow();
    expect(() => providerScopes(hubspot, ["contacts.search", "contacts.search"])).toThrow();
  });
});

describe("native provider verified account and scope lifecycle", () => {
  let server: Server, base: string, key: Awaited<ReturnType<typeof generateKeyPair>>, jwk: any;
  let calls: { path: string; body: URLSearchParams }[] = [], mode = "ok";
  const tenant = randomUUID(), otherTenant = randomUUID();
  const codes = new Map<string, { nonce: string; challenge?: string; scopes: string[]; oidc: boolean }>();
  beforeAll(async () => {
    key = await generateKeyPair("RS256"); jwk = await exportJWK(key.publicKey); jwk.kid = "fixture"; jwk.alg = "RS256";
    server = createServer(async (req, res) => { try {
      let text = ""; for await (const part of req) text += part;
      const body = new URLSearchParams(text); calls.push({ path: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/jwks") { res.end(JSON.stringify({ keys: [jwk] })); return; }
      if (req.url === "/introspect") {
        expect(body.get("client_id")).toBe("fixture-client"); expect(body.get("client_secret")).toBe("fixture-secret");
        expect(body.get("token")).toMatch(/private-access/); expect(body.get("token_type_hint")).toBe("access_token");
        res.end(JSON.stringify({ active: mode !== "inactive", hub_id: mode === "account" ? 456 : 123, client_id: mode === "client" ? "wrong-client" : "fixture-client", user: "owner@example.test",
          scopes: mode === "scope" ? [] : ["crm.objects.contacts.read"], privateUnexpectedField: "introspection-private-canary" })); return;
      }
      if (req.url === "/token") {
        expect(body.get("client_id")).toBe("fixture-client"); expect(body.get("client_secret")).toBe("fixture-secret");
        const refresh = body.get("grant_type") === "refresh_token";
        const code = refresh ? undefined : codes.get(body.get("code") ?? "");
        if (!refresh && !code) { res.statusCode = 400; res.end('{"error":"invalid_grant"}'); return; }
        if (code?.oidc) expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")).toBe(code.challenge);
        if (code && !code.oidc) expect(body.has("code_verifier")).toBe(false);
        const oidc = code?.oidc ?? body.get("refresh_token")?.includes("microsoft");
        const idToken = oidc ? await new SignJWT({ nonce: mode === "nonce" ? "wrong-nonce" : code?.nonce, tid: mode === "account" ? otherTenant : tenant, preferred_username: "owner@example.test" })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer(base).setAudience(mode === "audience" ? "wrong-client" : "fixture-client")
          .setSubject("stable-subject").setIssuedAt().setExpirationTime("5m").sign(key.privateKey) : undefined;
        res.end(JSON.stringify({ access_token: "private-access-token", refresh_token: `${oidc ? "microsoft" : "hubspot"}-private-refresh`, expires_in: mode === "expiry" ? -1 : 3600, token_type: "Bearer",
          scope: mode === "scope" ? "openid" : (code?.scopes ?? (oidc ? ["Calendars.Read"] : ["crm.objects.contacts.read"])).map(value => value === "Calendars.Read" ? `https://graph.microsoft.com/${value}` : value).join(" "),
          ...(idToken ? { id_token: mode === "signature" ? idToken.slice(0, -8) + "invalid0" : idToken } : {}) })); return;
      }
      res.statusCode = 404; res.end("{}");
    } catch { res.statusCode = 500; res.end('{"error":"fixture_assertion"}'); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => { calls = []; mode = "ok"; codes.clear(); });
  const metadata = (): ServerMetadata => ({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, introspection_endpoint: `${base}/introspect`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
  const client = (definition: NativeConnectorConfiguration) => new NativeProviderOAuth(definition, { clientId: "fixture-client", clientSecret: "fixture-secret", callbackUrl: `${base}${definition.auth.callbackPath}`, appUrl: "https://agents.example.test" }, metadata());
  async function begin(definition: NativeConnectorConfiguration) {
    const oauth = client(definition), scopes = providerScopes(definition, [definition === microsoft ? "calendar.availability" : "contacts.search"]);
    const attempt = await oauth.begin(scopes), url = new URL(attempt.authorizationUrl), code = randomUUID();
    codes.set(code, { nonce: url.searchParams.get("nonce") ?? "", challenge: url.searchParams.get("code_challenge") ?? undefined, scopes, oidc: definition.auth.kind === "oidc" });
    return { oauth, attempt: { ...attempt, scopes } as ProviderOAuthAttempt, url, query: `?code=${code}&state=${attempt.state}` };
  }
  async function connected(definition: NativeConnectorConfiguration): Promise<{ oauth: NativeProviderOAuth; tokens: ProviderOAuthTokens }> {
    const flow = await begin(definition); return { oauth: flow.oauth, tokens: await flow.oauth.complete(flow.query, flow.attempt) };
  }
  it("verifies Microsoft signed identity, tenant-qualified subject, PKCE, nonce and read-only scopes", async () => {
    const flow = await begin(microsoft);
    expect(flow.url.searchParams.get("code_challenge_method")).toBe("S256"); expect(flow.url.searchParams.get("nonce")).toBe(flow.attempt.nonce);
    expect(await flow.oauth.complete(flow.query, flow.attempt)).toMatchObject({ subject: `${tenant}:stable-subject`, email: "owner@example.test", scopes: expect.arrayContaining(["Calendars.Read"]), accessToken: "private-access-token" });
    expect(flow.url.searchParams.get("scope")).not.toContain("Calendars.ReadWrite");
  });
  it.each(["nonce", "audience", "signature", "expiry"])("rejects Microsoft %s without disclosing provider material", async value => {
    const flow = await begin(microsoft); mode = value;
    await expect(flow.oauth.complete(flow.query, flow.attempt)).rejects.toMatchObject({ code: "PROVIDER_AUTHORIZATION_FAILED" });
  });
  it("rejects callback state mismatch before exchanging a Microsoft code", async () => {
    const flow = await begin(microsoft); await expect(flow.oauth.complete(flow.query.replace(flow.attempt.state, "foreign-state"), flow.attempt)).rejects.toMatchObject({ code: "PROVIDER_AUTHORIZATION_FAILED" });
    expect(calls.filter(call => call.path === "/token")).toHaveLength(0);
  });
  it("rejects missing delegated Microsoft operation permission", async () => {
    const flow = await begin(microsoft); mode = "scope"; await expect(flow.oauth.complete(flow.query, flow.attempt)).rejects.toMatchObject({ code: "PROVIDER_SCOPES_REQUIRED" });
  });
  it("rejects refreshed Microsoft account changes", async () => {
    const flow = await connected(microsoft); mode = "account";
    await expect(flow.oauth.refresh(flow.tokens.refreshToken, flow.tokens)).rejects.toMatchObject({ code: "PROVIDER_RECONNECT_REQUIRED" });
  });
  it("uses HubSpot confidential code plus state and verified client/account introspection", async () => {
    const flow = await begin(hubspot); expect(flow.url.searchParams.has("code_challenge")).toBe(false); expect(flow.url.searchParams.has("nonce")).toBe(false);
    const tokens = await flow.oauth.complete(flow.query, flow.attempt);
    expect(tokens).toMatchObject({ subject: "hub:123", email: "owner@example.test", scopes: ["crm.objects.contacts.read"] });
    expect(JSON.stringify(tokens)).not.toContain("introspection-private-canary"); expect(calls.filter(call => call.path === "/introspect")).toHaveLength(1);
  });
  it("rejects HubSpot state mismatch without token exchange", async () => {
    const flow = await begin(hubspot); await expect(flow.oauth.complete(flow.query.replace(flow.attempt.state, "foreign-state"), flow.attempt)).rejects.toMatchObject({ code: "PROVIDER_AUTHORIZATION_FAILED" }); expect(calls).toHaveLength(0);
  });
  it.each(["client", "inactive"])("rejects HubSpot %s introspection with a generic error", async value => {
    const flow = await begin(hubspot); mode = value;
    try { await flow.oauth.complete(flow.query, flow.attempt); expect.fail("Expected rejected authorization"); }
    catch (error) { expect(error).toMatchObject({ code: "PROVIDER_AUTHORIZATION_FAILED" }); expect(String(error)).not.toContain("introspection-private-canary"); }
  });
  it("rejects HubSpot missing operation scopes", async () => {
    const flow = await begin(hubspot); mode = "scope"; await expect(flow.oauth.complete(flow.query, flow.attempt)).rejects.toMatchObject({ code: "PROVIDER_SCOPES_REQUIRED" });
  });
  it("rejects refreshed HubSpot account changes", async () => {
    const flow = await connected(hubspot); mode = "account"; await expect(flow.oauth.refresh(flow.tokens.refreshToken, flow.tokens)).rejects.toMatchObject({ code: "PROVIDER_RECONNECT_REQUIRED" });
  });
});
