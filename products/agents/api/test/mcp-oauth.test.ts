import {createHash,randomBytes,randomUUID} from "node:crypto";
import Fastify,{type FastifyBodyParser} from "fastify";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {registerAgentsOAuth,resolveAgentsOAuthToken,storeAgentsClientMetadata} from "../src/product/mcp/oauth";

const url=process.env.AGENTS_TEST_DATABASE_URL;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const formBodyParser:FastifyBodyParser<string>=(_req,body,done)=>done(null,Object.fromEntries(new URLSearchParams(body)));
(url?describe:describe.skip)("MCP OAuth authorization and revocation",()=>{
 const name=`agents_oauth_${randomUUID().replaceAll("-","")}`,accountId=randomUUID(),orgId=randomUUID();
 let admin:Pool,pool:Pool,app:ReturnType<typeof Fastify>,metadataFetches=0;
 beforeAll(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname=`/${name}`;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);
  await pool.query("INSERT INTO agents_platform.accounts(id,issuer,subject,email,display_name) VALUES($1,'https://identity.example','subject','person@example.test','Person')",[accountId]);
  await pool.query("INSERT INTO agents_platform.organizations(id,name) VALUES($1,'Business')",[orgId]);await pool.query("INSERT INTO agents_platform.memberships(account_id,organization_id,role) VALUES($1,$2,'owner')",[accountId,orgId]);
  app=Fastify();app.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string"},formBodyParser);
  registerAgentsOAuth(app,{pool,publicUrl:"https://agents.example",account:async()=>({id:accountId}),fetchClientMetadata:async id=>{metadataFetches++;return {id,name:"Metadata client",redirectUris:["https://client.example/callback"]};}});await app.ready();
 });
 afterAll(async()=>{await app?.close();await pool?.end();if(admin){await dropClosedTestDatabase(admin,name);await admin.end();}});
 it("bounds metadata client admission while allowing existing clients to refresh",async()=>{
  const ip="198.51.100.21";
  for(let i=0;i<30;i++) await storeAgentsClientMetadata(pool,{id:`https://client${i}.example/metadata`,name:"Client",redirectUris:["https://client.example/callback"]},ip);
  await expect(storeAgentsClientMetadata(pool,{id:"https://new.example/metadata",name:"New",redirectUris:["https://client.example/callback"]},ip)).rejects.toMatchObject({code:"temporarily_unavailable",statusCode:429});
  await storeAgentsClientMetadata(pool,{id:"https://client0.example/metadata",name:"Updated",redirectUris:["https://client.example/new"]},ip);
  expect((await pool.query("SELECT name,redirect_uris FROM agents_platform.mcp_oauth_clients WHERE id=$1",["https://client0.example/metadata"])).rows[0]).toMatchObject({name:"Updated",redirect_uris:["https://client.example/new"]});
 });
 it("rate limits a registered client's valid authorization requests",async()=>{
  const registration=await app.inject({method:"POST",url:"/oauth/register",payload:{client_name:"Rate limited",redirect_uris:["https://client.example/callback"]}}),client=registration.json().client_id;
  const verifier=randomBytes(32).toString("base64url"),resource="https://agents.example/mcp",query=new URLSearchParams({response_type:"code",client_id:client,redirect_uri:"https://client.example/callback",resource,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
  let last;
  for(let i=0;i<31;i++)last=await app.inject({method:"GET",url:`/oauth/authorize?${query}`,headers:{"x-forwarded-for":`203.0.113.${i+1}`}});
  expect(last?.statusCode).toBe(429);
  expect((await pool.query("SELECT count(*)::int total FROM agents_platform.mcp_oauth_requests WHERE client_id=$1",[client])).rows[0].total).toBe(30);
 });
 it("ignores arbitrary X-Forwarded-For and does not allocate buckets for unknown clients",async()=>{
  const resource="https://agents.example/mcp",verifier=randomBytes(32).toString("base64url");
  const unknownClients=["unknown-client-a","unknown-client-b","unknown-client-c"];
  for(let i=0;i<unknownClients.length;i++){
   const query=new URLSearchParams({response_type:"code",client_id:unknownClients[i]!,redirect_uri:"https://client.example/callback",resource,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
   expect((await app.inject({method:"GET",url:`/oauth/authorize?${query}`,headers:{"x-forwarded-for":`203.0.113.${i+1}`}})).statusCode).toBe(400);
  }
  expect((await pool.query("SELECT bucket_key FROM agents_platform.mcp_oauth_authorize_limits WHERE bucket_key LIKE 'ip:%'")).rows).toHaveLength(1);
  expect((await pool.query("SELECT count(*)::int total FROM agents_platform.mcp_oauth_authorize_limits WHERE bucket_key=ANY($1::text[])",[unknownClients.map(id=>`client:${hash(id)}`)])).rows[0].total).toBe(0);
 });
 it("caches CIMD metadata and refreshes it after the cache window",async()=>{
  metadataFetches=0;const clientId="https://metadata.example/client.json",resource="https://agents.example/mcp",verifier=randomBytes(32).toString("base64url");
  const query=new URLSearchParams({response_type:"code",client_id:clientId,redirect_uri:"https://client.example/callback",resource,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
  expect((await app.inject({method:"GET",url:`/oauth/authorize?${query}`})).statusCode).toBe(302);
  expect((await app.inject({method:"GET",url:`/oauth/authorize?${query}`})).statusCode).toBe(302);
  expect(metadataFetches).toBe(1);
  await pool.query("UPDATE agents_platform.mcp_oauth_clients SET metadata_refreshed_at=now()-interval '20 minutes' WHERE id=$1",[clientId]);
  expect((await app.inject({method:"GET",url:`/oauth/authorize?${query}`})).statusCode).toBe(302);
  expect(metadataFetches).toBe(2);
 });
 it("cleans expired authorization rows in bounded batches on admission",async()=>{
  const registration=await app.inject({method:"POST",url:"/oauth/register",payload:{client_name:"Cleanup",redirect_uris:["https://client.example/callback"]}}),client=registration.json().client_id;
  const resource="https://agents.example/mcp",expiredCode=hash(randomBytes(32).toString("base64url")),expiredRefresh=hash(randomBytes(32).toString("base64url")),connectionId=randomUUID();
  await pool.query("INSERT INTO agents_platform.mcp_oauth_connections(id,client_id,account_id,organization_id,resource,scopes,access_hash,access_expires_at) VALUES($1,$2,$3,$4,$5,ARRAY['agents:read'],'expired-token-hash',now()+interval '1 hour')",[connectionId,client,accountId,orgId,resource]);
  await pool.query(`INSERT INTO agents_platform.mcp_oauth_requests(hash,client_id,redirect_uri,resource,scopes,state,challenge,expires_at)
   SELECT 'expired-request-'||n::text,$1,'https://client.example/callback',$2,ARRAY['agents:read'],'state','challenge',now()-interval '1 minute' FROM generate_series(1,501) AS expired(n)`,[client,resource]);
  await pool.query("INSERT INTO agents_platform.mcp_oauth_codes(hash,client_id,account_id,organization_id,redirect_uri,resource,scopes,challenge,expires_at) VALUES($1,$2,$3,$4,'https://client.example/callback',$5,ARRAY['agents:read'],'challenge',now()-interval '1 minute')",[expiredCode,client,accountId,orgId,resource]);
  await pool.query("INSERT INTO agents_platform.mcp_oauth_refresh(hash,connection_id,expires_at) VALUES($1,$2,now()-interval '2 hours')",[expiredRefresh,connectionId]);
  const verifier=randomBytes(32).toString("base64url"),query=new URLSearchParams({response_type:"code",client_id:client,redirect_uri:"https://client.example/callback",resource,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
  expect((await app.inject({method:"GET",url:`/oauth/authorize?${query}`})).statusCode).toBe(302);
  expect((await pool.query("SELECT (SELECT count(*) FROM agents_platform.mcp_oauth_requests WHERE hash LIKE 'expired-request-%')::int requests,(SELECT count(*) FROM agents_platform.mcp_oauth_codes WHERE hash=$1)::int codes,(SELECT count(*) FROM agents_platform.mcp_oauth_refresh WHERE hash=$2)::int refreshes",[expiredCode,expiredRefresh])).rows[0]).toEqual({requests:1,codes:0,refreshes:0});
 });
 it("runs PKCE with form posts, refresh replay revocation and membership checks",async()=>{
  const registration=await app.inject({method:"POST",url:"/oauth/register",payload:{client_name:"Assistant",redirect_uris:["https://client.example/callback"]}});expect(registration.statusCode).toBe(201);const client=registration.json().client_id;
  const verifier=randomBytes(32).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url"),resource="https://agents.example/mcp";
  const query=new URLSearchParams({response_type:"code",client_id:client,redirect_uri:"https://client.example/callback",resource,scope:"agents:read agents:manage",state:"state",code_challenge:challenge,code_challenge_method:"S256"});
  const start=await app.inject({method:"GET",url:`/oauth/authorize?${query}`});expect(start.statusCode).toBe(302);const nonce=new URL(start.headers.location!,"https://agents.example").searchParams.get("request")!;
  const consent=(await app.inject({method:"GET",url:`/api/mcp/oauth/requests/${nonce}`})).json();
  expect(consent.organizations).toHaveLength(1);
  expect(consent.request).toMatchObject({clientName:"Assistant",clientId:client,redirectHost:"client.example",scopes:["agents:read","agents:manage"]});
  const decision=await app.inject({method:"POST",url:`/api/mcp/oauth/requests/${nonce}/decision`,payload:{approved:true,organizationId:orgId}});const code=new URL(decision.json().redirectUrl).searchParams.get("code")!;
  const post=async(input:Record<string,string>)=>app.inject({method:"POST",url:"/oauth/token",headers:{"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams(input).toString()});
  const token=await post({grant_type:"authorization_code",client_id:client,resource,redirect_uri:"https://client.example/callback",code,code_verifier:verifier});expect(token.statusCode).toBe(200);expect(token.headers["cache-control"]).toBe("no-store");expect(await resolveAgentsOAuthToken(pool,token.json().access_token,resource)).toMatchObject({accountId,organizationId:orgId});
  expect((await post({grant_type:"authorization_code",client_id:client,resource,redirect_uri:"https://client.example/callback",code,code_verifier:verifier})).statusCode).toBe(400);
  const refreshed=await post({grant_type:"refresh_token",client_id:client,resource,refresh_token:token.json().refresh_token});expect(refreshed.statusCode).toBe(200);
  expect((await post({grant_type:"refresh_token",client_id:client,resource,refresh_token:token.json().refresh_token})).statusCode).toBe(400);expect(await resolveAgentsOAuthToken(pool,refreshed.json().access_token,resource)).toBeNull();
  const next=await app.inject({method:"GET",url:`/oauth/authorize?${query}`});const nonce2=new URL(next.headers.location!,"https://agents.example").searchParams.get("request")!;await app.inject({method:"GET",url:`/api/mcp/oauth/requests/${nonce2}`});const decision2=await app.inject({method:"POST",url:`/api/mcp/oauth/requests/${nonce2}/decision`,payload:{approved:true,organizationId:orgId}});const code2=new URL(decision2.json().redirectUrl).searchParams.get("code")!;const token2=(await post({grant_type:"authorization_code",client_id:client,resource,redirect_uri:"https://client.example/callback",code:code2,code_verifier:verifier})).json();
  await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE account_id=$1 AND organization_id=$2",[accountId,orgId]);await expect(resolveAgentsOAuthToken(pool,token2.access_token,resource)).rejects.toMatchObject({code:"access_denied"});await pool.query("UPDATE agents_platform.memberships SET revoked_at=NULL WHERE account_id=$1 AND organization_id=$2",[accountId,orgId]);
  const revoked=await app.inject({method:"POST",url:"/oauth/revoke",headers:{"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams({client_id:client,token:token2.refresh_token}).toString()});expect(revoked.statusCode).toBe(200);expect(await resolveAgentsOAuthToken(pool,token2.access_token,resource)).toBeNull();
 });
});
