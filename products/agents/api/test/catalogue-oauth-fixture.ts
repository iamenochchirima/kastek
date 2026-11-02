import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** Actual controlled authorization server: browser consent, DCR, PKCE, one-use code and HTTP token exchange. */
export async function createCatalogueOAuthFixture() {
  let origin = "", exchanges = 0;
  const clients = new Map<string, string[]>(), codes = new Map<string, { challenge: string; redirect: string; client: string; resource: string }>();
  const tokens = new Set<string>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    let text = ""; for await (const chunk of request) text += chunk;
    const json = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) { json({ resource: `${origin}/mcp`, authorization_servers: [origin] }); return; }
    if (url.pathname.startsWith("/.well-known/")) { json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true }); return; }
    if (url.pathname === "/register") { const body = JSON.parse(text), client = randomBytes(16).toString("hex"); clients.set(client, body.redirect_uris); json({ ...body, client_id: client }); return; }
    if (url.pathname === "/authorize") {
      const params = url.searchParams, redirect = params.get("redirect_uri")!, client = params.get("client_id")!;
      if (!clients.get(client)?.includes(redirect) || params.get("code_challenge_method") !== "S256") { json({ error: "invalid_request" }, 400); return; }
      const query = new URLSearchParams(params); query.set("decision", "approve"); const approve = `/consent?${query}`; query.set("decision", "cancel"); const cancel = `/consent?${query}`;
      const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<main><h1>Controlled provider consent</h1><p>This isolated authorization server grants access to one acceptance tool.</p><a href="${escape(approve)}">Authorize acceptance tool</a><a href="${escape(cancel)}">Cancel authorization</a></main>`); return;
    }
    if (url.pathname === "/consent") {
      const params = url.searchParams, redirect = params.get("redirect_uri")!, client = params.get("client_id")!;
      if (!clients.get(client)?.includes(redirect)) { json({ error: "invalid_request" }, 400); return; }
      const target = new URL(redirect); target.searchParams.set("state", params.get("state")!); target.searchParams.set("iss", origin);
      if (params.get("decision") === "cancel") target.searchParams.set("error", "access_denied");
      else { const code = randomBytes(24).toString("base64url"); codes.set(code, { challenge: params.get("code_challenge")!, redirect, client, resource: params.get("resource")! }); target.searchParams.set("code", code); }
      response.writeHead(302, { location: target.href, "cache-control": "no-store" }); response.end(); return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(text), code = params.get("code")!, issued = codes.get(code); codes.delete(code);
      if (!issued || issued.client !== params.get("client_id") || issued.redirect !== params.get("redirect_uri") || issued.resource !== params.get("resource") || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== issued.challenge) { json({ error: "invalid_grant" }, 400); return; }
      exchanges++; const token = randomBytes(32).toString("base64url"); tokens.add(token); json({ access_token: token, token_type: "Bearer", expires_in: 3600 }); return;
    }
    if (url.pathname === "/fixture/status") { json({ exchanges }); return; }
    if (url.pathname !== "/mcp") { json({ error: "not_found" }, 404); return; }
    if (!tokens.has(request.headers.authorization?.replace(/^Bearer /, "") ?? "")) { response.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`); json({ error: "authorization_required" }, 401); return; }
    const rpc = JSON.parse(text), reply = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id, result });
    if (rpc.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "Controlled OAuth MCP", version: "1" } });
    else if (rpc.method === "notifications/initialized") { response.writeHead(202); response.end(); }
    else if (rpc.method === "tools/list") reply({ tools: [{ name: "approved_lookup", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
    else json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.ok(origin);
  return { base: origin, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
