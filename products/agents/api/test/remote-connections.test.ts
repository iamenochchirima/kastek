import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  it("resumes encrypted OAuth across instances, rejects callback replay and serializes rotating-token refresh",async()=>{
    let origin="",registrations=0,tokenCalls=0,challenge="",failRefresh=false;
    const server=createServer(async(request,response)=>{
      let body="";for await(const chunk of request)body+=chunk;
      response.setHeader("content-type","application/json");
      if(request.url==="/mcp"||request.url?.startsWith("/.well-known/oauth-protected-resource"))return response.end(JSON.stringify({resource:`${origin}/mcp`,authorization_servers:[origin]}));
      if(request.url?.startsWith("/.well-known/"))return response.end(JSON.stringify({issuer:origin,authorization_endpoint:`${origin}/authorize`,token_endpoint:`${origin}/token`,registration_endpoint:`${origin}/register`,response_types_supported:["code"],code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none"],authorization_response_iss_parameter_supported:true}));
      if(request.url==="/register"){registrations++;return response.end(JSON.stringify({...JSON.parse(body),client_id:"fixture-client"}));}
      if(request.url==="/token"){
        tokenCalls++;const input=new URLSearchParams(body);
        if(input.get("grant_type")==="authorization_code")expect(createHash("sha256").update(input.get("code_verifier")!).digest("base64url")).toBe(challenge);
        else if(failRefresh)return response.writeHead(400).end(JSON.stringify({error:"invalid_grant"}));
        else {expect(input.get("refresh_token")).toBe("private-refresh-1");await new Promise(resolve=>setTimeout(resolve,50));}
        return response.end(JSON.stringify({access_token:`private-access-${tokenCalls}`,refresh_token:`private-refresh-${tokenCalls}`,token_type:"Bearer",expires_in:3600}));
      }
      response.writeHead(404).end("{}");
    });
    servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const owner=await scope(),other=await scope(),connection=await remote.create(owner,{operationId:randomUUID(),endpoint:`${origin}/mcp`,authentication:"oauth"});
    const redirect=await remote.beginAuthorization(owner,connection.id,connection.generation),consent=new URL(redirect.authorizationUrl),state=consent.searchParams.get("state")!;
    challenge=consent.searchParams.get("code_challenge")!;
    const resumed=new RemoteConnectionStore(pool,remote.vault,remote.options);
    await expect(resumed.callbackScope(other.accountId,state)).rejects.toMatchObject({code:"OAUTH_STATE_INVALID"});
    await expect(resumed.completeAuthorization(other,state,"valid-code",origin)).rejects.toMatchObject({code:"OAUTH_STATE_INVALID"});
    expect(await resumed.callbackScope(owner.accountId,state)).toEqual(owner);
    expect((await resumed.completeAuthorization(owner,state,"valid-code",origin)).status).toBe("discovering");
    await expect(resumed.completeAuthorization(owner,state,"valid-code",origin)).rejects.toMatchObject({code:"OAUTH_STATE_INVALID"});
    expect(registrations).toBe(1);expect(tokenCalls).toBe(1);
    const expire=async()=>{
      const row=(await pool.query("SELECT c.revision,k.envelope FROM agents_platform.connections c JOIN agents_platform.connection_credentials k ON k.connection_id=c.id AND k.revision=c.revision WHERE c.id=$1",[connection.id])).rows[0];
      expect(JSON.stringify(row.envelope)).not.toContain("private-access");
      const secret=JSON.parse(remote.vault.open(owner.organizationId,connection.id,row.revision,row.envelope));secret.authorization.issuedAt=Date.now()-7200000;
      await pool.query("UPDATE agents_platform.connection_credentials SET envelope=$3 WHERE connection_id=$1 AND revision=$2",[connection.id,row.revision,JSON.stringify(remote.vault.seal(owner.organizationId,connection.id,row.revision,JSON.stringify(secret),65536))]);
    };
    await expire();
    const refreshes=await Promise.allSettled([remote.ensureCredentialFresh(owner,connection.id),resumed.ensureCredentialFresh(owner,connection.id)]);
    expect(refreshes.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(tokenCalls).toBe(2);
    expect(JSON.stringify(await resumed.get(owner,connection.id))).not.toContain("private-");
    await expire();failRefresh=true;
    await expect(resumed.ensureCredentialFresh(owner,connection.id)).rejects.toMatchObject({code:"AUTHENTICATION"});
    expect((await resumed.get(owner,connection.id)).status).toBe("reconnect_required");
    const own=await resumed.create(owner,{operationId:randomUUID(),endpoint:`${origin}/mcp`,authentication:"oauth",oauthClient:{issuer:origin,clientId:"own-client",authMethod:"none"}});
    const ownRedirect=await resumed.beginAuthorization(owner,own.id,own.generation);expect(new URL(ownRedirect.authorizationUrl).searchParams.get("client_id")).toBe("own-client");expect(registrations).toBe(1);
    await expect(resumed.completeAuthorization(owner,new URL(ownRedirect.authorizationUrl).searchParams.get("state")!)).rejects.toMatchObject({code:"OAUTH_CANCELLED"});
    expect((await resumed.get(owner,own.id)).status).toBe("authorization_required");
  },30000);
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
