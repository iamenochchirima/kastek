import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { RemoteConnectionStore } from "../src/product/connections/remote-connections";
import { ConnectionVault } from "../src/infrastructure/vault";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("durable remote connections",()=>{
  let admin:Pool,pool:Pool,platform:PlatformStore,remote:RemoteConnectionStore;
  const database=`agents_remote_${randomUUID().replaceAll("-","")}`,servers:Server[]=[];
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    platform=new PlatformStore(pool);remote=new RemoteConnectionStore(pool,new ConnectionVault("test",{test:randomBytes(32).toString("base64")}),
      {callbackUrl:"http://127.0.0.1:3100/api/connections/oauth/callback",testLoopback:true});
  });
  afterAll(async()=>{
    for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}
  });
  async function scope(){const account=await platform.ensureAccount({issuer:"https://login.example.test",subject:randomUUID(),email:"test@example.test",displayName:"Owner"});
    const org=await platform.createOrganization(account.id,"Remote tests");return {accountId:account.id,organizationId:org.id};}
  it("persists a draft, encrypts secrets, replays requests and fences other owners",async()=>{
    const owner=await scope(),other=await scope(),input={operationId:randomUUID(),endpoint:"https://tools.example.test/mcp",authentication:"header",headerName:"X-Api-Key",secret:"private-test-key"};
    const first=await remote.create(owner,input),replay=await remote.create(owner,input);
    expect(first.id).toBe(replay.id);expect(first.status).toBe("draft");expect(JSON.stringify(first)).not.toContain(input.secret);
    expect((await remote.list(owner))[0]?.id).toBe(first.id);expect(await remote.list(other)).toEqual([]);
    await expect(remote.get(other,first.id)).rejects.toMatchObject({code:"CONNECTION_NOT_FOUND"});
    await expect(remote.create(owner,{...input,endpoint:"https://other.example.test/mcp"})).rejects.toMatchObject({code:"CONNECTION_CHANGED"});
    const stored=(await pool.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1",[first.id])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(input.secret);
    await expect(remote.create(owner,{...input,operationId:randomUUID(),headerName:"Host"})).rejects.toMatchObject({code:"CONNECTION_HEADER_INVALID"});
  });
  it("disconnects immediately, invalidates pending authorization and cannot be rediscovered",async()=>{
    const owner=await scope(),connection=await remote.create(owner,{operationId:randomUUID(),endpoint:"https://tools.example.test/mcp",authentication:"none"});
    expect((await remote.disconnect(owner,connection.id,connection.generation)).disconnected).toBe(true);
    expect((await remote.get(owner,connection.id)).status).toBe("disconnected");
    await expect(remote.discover(owner,connection.id,connection.generation)).rejects.toMatchObject({code:"CONNECTION_CHANGED"});
    await expect(remote.completeAuthorization(owner,"a".repeat(43),"forged")).rejects.toMatchObject({code:"OAUTH_STATE_INVALID"});
  });
  it("records authorization-required after an actual MCP401 without persisting a healthy state",async()=>{
    const server=createServer((_request,response)=>response.writeHead(401,{"www-authenticate":'Bearer resource_metadata="https://example.test/metadata"'}).end());
    servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error();
    const owner=await scope(),connection=await remote.create(owner,{operationId:randomUUID(),endpoint:`http://127.0.0.1:${address.port}/mcp`});
    const result=await remote.discover(owner,connection.id,connection.generation);
    expect(result.connection.status,JSON.stringify(result.connection)).toBe("authorization_required");expect(result.connection.lastError).toBe("AUTHENTICATION");
    expect(result).not.toHaveProperty("catalog");
    expect((await pool.query("SELECT lease_id FROM agents_platform.connection_onboarding WHERE connection_id=$1",[connection.id])).rows[0].lease_id).toBeNull();
  },15000);
});
