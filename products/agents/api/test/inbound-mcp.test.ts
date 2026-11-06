import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { registerAgentsMcp } from "../src/product/mcp/server";

describe("inbound MCP boundary", () => {
 it("checks resource and current membership on every bearer request", async () => {
  let member = true, resource = "https://agents.example/mcp";
  const pool = { query: async (sql:string) => sql.includes("mcp_oauth_connections") && sql.includes("SELECT") ? {rows:[{id:"connection",account_id:"account",organization_id:"org",resource,scopes:["agents:read"]}],rowCount:1} : sql.includes("memberships") ? {rows:[],rowCount:member?1:0} : {rows:[],rowCount:1} } as unknown as Pool;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code((error as {statusCode?:number}).statusCode ?? 500).send());
  const token=`agents_oauth_${"a".repeat(43)}`;
  registerAgentsMcp(app, {pool,publicUrl:"https://agents.example",allowedOrigins:[],operations:[{name:"reflection",description:"fixture",scope:"agents:read",inputSchema:{type:"object"},run:async()=>({text:token})},{name:"encoded_reflection",description:"fixture",scope:"agents:read",inputSchema:{type:"object"},run:async()=>({text:Buffer.from(token).toString("base64")})}]});
  const metadata=await app.inject({method:"GET",url:"/.well-known/oauth-protected-resource"});
  expect(metadata.json().resource).toBe(resource);
  const request=(token?:string)=>app.inject({method:"POST",url:"/mcp",headers:{host:"agents.example",accept:"application/json, text/event-stream",...(token?{authorization:`Bearer ${token}`}:{})},payload:{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}}});
  expect((await request()).statusCode).toBe(401);
  expect((await request(token)).statusCode).toBe(200);
  const reflected=await app.inject({method:"POST",url:"/mcp",headers:{host:"agents.example",authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"reflection",arguments:{}}}});
  expect(reflected.json().result.isError).toBe(true);expect(reflected.body).not.toContain(token);
  const encoded=await app.inject({method:"POST",url:"/mcp",headers:{host:"agents.example",authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"encoded_reflection",arguments:{}}}});
  expect(encoded.json().result.isError).toBe(true);expect(encoded.body).not.toContain(Buffer.from(token).toString("base64"));
  resource="https://other.example/mcp";
  expect((await request(token)).statusCode).toBe(401);
  resource="https://agents.example/mcp";member=false;
  expect((await request(token)).statusCode).toBe(403);
  await app.close();
 });
});
