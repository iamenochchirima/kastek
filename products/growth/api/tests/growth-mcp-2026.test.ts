import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { CoreContext } from "../src/context.js";
import type { RequestContext } from "../src/identity/request-context.js";
import { readConfig } from "../src/config.js";
import { MCP_2026_VERSION, handleGrowthMcp2026, isMcp2026Request } from "../src/operations/mcp-2026.js";
const core = {config:readConfig({DATABASE_URL:"postgres://unused",ENVIRONMENT:"test"})} as CoreContext;
const context = {principal:{kind:"oauth_user",id:"fixture"},userId:"alice",clientId:"fixture-client",organizationId:"org-a"} as RequestContext;

test("MCP2026 detects protocol requests without changing legacy request routing", () => {
  assert.equal(isMcp2026Request({headers: {"mcp-protocol-version": MCP_2026_VERSION}, body: {}}), true);
  assert.equal(isMcp2026Request({headers: {}, body: {method: "server/discover"}}), true);
  assert.equal(isMcp2026Request({headers: {"mcp-protocol-version": "2027-01-01"}, body: {}}), true);
  assert.equal(isMcp2026Request({headers: {}, body: {method: "tools/call", params: {_meta: {"io.modelcontextprotocol/protocolVersion": MCP_2026_VERSION}}}}), true);
  assert.equal(isMcp2026Request({headers: {"mcp-protocol-version": "2025-11-25"}, body: {method: "tools/call"}}), false);
});


test("MCP2026 JSON discovery and validation preserve stateless round trips", async () => {
  const app = Fastify({logger:false});
  app.post("/mcp", async (request,reply) => handleGrowthMcp2026(core, context, request,reply));
  const meta = {"io.modelcontextprotocol/protocolVersion":MCP_2026_VERSION,"io.modelcontextprotocol/clientCapabilities":{}};
  const send = (method:string, params:Record<string,unknown> = {_meta:meta}, version=MCP_2026_VERSION) => app.inject({method:"POST",url:"/mcp",
    headers:{"mcp-protocol-version":version,"mcp-method":method,...(typeof params.name === "string" ? {"mcp-name":params.name} : {})},payload:{jsonrpc:"2.0",id:1,method,params}});
  try {
    const discovery = await send("server/discover");
    assert.equal(discovery.statusCode,200);
    assert.equal(discovery.json().result.resultType,"complete");
    assert.ok(discovery.json().result.supportedVersions.includes(MCP_2026_VERSION));
    assert.deepEqual(discovery.json().result.capabilities,{tools:{}});
    assert.equal(discovery.headers["cache-control"],"no-store");
    assert.equal((await send("ping")).json().result.resultType,"complete");
    const unknown = await send("not-supported");
    assert.equal(unknown.statusCode,404);
    assert.equal(unknown.json().error.code,-32601);
    assert.equal(discovery.json().result._meta["io.modelcontextprotocol/serverInfo"].name,"kasitek-growth");
    assert.equal(discovery.json().result.protocolVersions,undefined);
    const wire = (headers:Record<string,string>, method="server/discover", name?:string) => app.inject({method:"POST",url:"/mcp",headers,
      payload:{jsonrpc:"2.0",id:2,method,params:{_meta:meta,...(name ? {name} : {})}}});
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION})).json().error.code,-32020);
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"ping"})).json().error.code,-32020);
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"tools/call"},"tools/call","missing")).json().error.code,-32020);
    const encoded = await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"prompts/get","mcp-name":"=?base64?"+Buffer.from("Héllo").toString("base64")+"?="},"prompts/get","Héllo");
    assert.equal(encoded.statusCode,404); // Encoded header agrees; unsupported method is separate.
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"tools/call","mcp-name":"=?base64?!!?="},"tools/call","missing")).json().error.code,-32020);
    assert.equal((await send("ping",{_meta:meta},"2025-11-25")).json().error.code,-32020);
    assert.equal((await send("ping",{})).statusCode,400);
    assert.equal((await send("ping",{_meta:{...meta,"io.modelcontextprotocol/clientCapabilities":[]}})).statusCode,400);
    assert.equal((await send("ping",{_meta:{...meta,"io.modelcontextprotocol/protocolVersion":"2027-01-01"}},"2027-01-01")).json().error.code,-32022);
    const forged = await send("tools/call",{_meta:meta,name:"content.posts.publish",arguments:{postId:"post-a",platform:"FACEBOOK",_requestId:"stable-request-a"},requestState:"forged",inputResponses:{confirm:{action:"accept",content:{decision:"confirm"}}}});
    assert.equal(forged.json().result.isError,true);
    assert.equal(forged.json().result.structuredContent.code,"operation_arguments_invalid");
  } finally { await app.close(); }
});
