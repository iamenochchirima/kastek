import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { clientMetadata, publicMetadataAddress, redirectUri } from "../src/oauth/clients.js";
import { oauthDigest, parseGrowthOAuthScopes, registerGrowthOAuthRoutes, resolveGrowthOAuthContext } from "../src/oauth/index.js";

test("Growth OAuth permits bounded public-client metadata and rejects private metadata addresses", () => {
  assert.deepEqual(parseGrowthOAuthScopes("growth:read growth:draft growth:read"), ["growth:read", "growth:draft"]);
  assert.throws(() => parseGrowthOAuthScopes("growth:admin"), /Unsupported/);
  assert.equal(redirectUri("http://127.0.0.1:8787/callback"), "http://127.0.0.1:8787/callback");
  for (const uri of ["http://remote.example/callback", "https://example.com/cb#fragment", "https://user:secret@example.com/cb"])
    assert.throws(() => redirectUri(uri));
  for (const ip of ["127.0.0.1", "10.2.3.4", "169.254.169.254", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "64:ff9b::a00:1"])
    assert.equal(publicMetadataAddress(ip), false, ip);
  assert.equal(publicMetadataAddress("8.8.8.8"), true);
  assert.equal(publicMetadataAddress("2606:4700:4700::1111"), true);
  assert.throws(() => clientMetadata({client_id:"https://evil.example/meta",redirect_uris:["https://example.com/cb"]},"https://example.com/meta"));
  assert.throws(() => clientMetadata({redirect_uris:["https://example.com/cb"],token_endpoint_auth_method:"client_secret_post"},"client"));
  assert.throws(() => clientMetadata({redirect_uris:["https://example.com/cb"],grant_types:["client_credentials"]},"client"));
});

const database=process.env.CORE_OAUTH_TEST_DATABASE_URL;
test("Growth OAuth consent, PKCE, workspace isolation, code races, rotation, replay and independent revocation", {skip:!database,timeout:30000}, async () => {
  const url=new URL(database!);
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname),"OAuth fixtures require local PostgreSQL");
  const admin=new pg.Pool({connectionString:database}),schema=`growth_oauth_test_${randomBytes(12).toString("hex")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema} -c timezone=UTC`});
  let app:Awaited<ReturnType<typeof buildApp>>|undefined;
  try {
    await pool.query(`CREATE TABLE "User"(id text PRIMARY KEY,name text,email text,phone text,image text,"emailVerified" timestamptz,"createdAt" timestamptz DEFAULT NOW(),"updatedAt" timestamptz DEFAULT NOW());
      CREATE TABLE "Organization"(id text PRIMARY KEY,name text);
      CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);
      CREATE TABLE "Session"("userId" text,"refreshToken" text,"identityCheckedAt" timestamptz,"providerRefreshedAt" timestamptz,"sessionToken" text,expires timestamptz,"lastActivityAt" timestamptz);
      INSERT INTO "User"(id,name,email,"emailVerified") VALUES('alice','Alice','alice@example.test',NOW()),('bob','Bob','bob@example.test',NOW());
      INSERT INTO "Organization" VALUES('org-a','A'),('org-b','B');
      INSERT INTO "OrganizationMember" VALUES('org-a','alice','OWNER'),('org-b','bob','OWNER');`);
    await pool.query(await readFile(new URL("../sql/20261101130000_growth_oauth.sql",import.meta.url),"utf8"));
    for(const user of ["alice","bob"])
      await pool.query(`INSERT INTO "Session" VALUES($1,'unused',NOW(),NOW(),$2,NOW()+INTERVAL '1 day',NOW())`,[user,oauthDigest(`${user}-session`)]);
    const config=readConfig({DATABASE_URL:database,ENVIRONMENT:"test",FRONTEND_URL:"http://localhost:3002",KASITEK_CORE_PUBLIC_URL:"http://localhost:4000"}),core={pool,config};
    app=await buildApp(core,[registerGrowthOAuthRoutes]);await app.ready();
    const call=(method:string,path:string,body?:unknown,user?:string) => app!.inject({method:method as "GET"|"POST"|"DELETE",url:path,...(body===undefined?{}:{payload:body as Record<string,unknown>}),headers:{...(user?{cookie:`kasitek_session=${user}-session; kasitek_active_org=${user==="alice"?"org-a":"org-b"}`,origin:config.frontendUrl}:{})}});
    const discovery=(await call("GET","/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(discovery.resource,"http://localhost:4000/mcp");
    assert.equal((await call("GET","/.well-known/oauth-authorization-server")).json().client_id_metadata_document_supported,true);
    const registered=await call("POST","/oauth/register",{client_name:"Fixture agent",redirect_uris:["http://127.0.0.1:8787/callback"]});
    assert.equal(registered.statusCode,201,registered.body);
    const client=registered.json().client_id,resource=discovery.resource;
    const {createHash}=await import("node:crypto");
    const verifier=randomBytes(32).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url");
    const authorize=async () => {
      const query=new URLSearchParams({client_id:client,resource,redirect_uri:"http://127.0.0.1:8787/callback",scope:"growth:read growth:draft",state:"fixture-state",response_type:"code",code_challenge:challenge,code_challenge_method:"S256"});
      const r=await call("GET",`/oauth/authorize?${query}`);assert.equal(r.statusCode,302,r.body);
      return new URL(r.headers.location!).searchParams.get("request")!;
    };
    const consent=async (nonce:string,approved=true) => {
      const inspection=await call("GET",`/api/oauth/requests/${nonce}`,undefined,"alice");assert.equal(inspection.statusCode,200,inspection.body);
      assert.deepEqual(inspection.json().organizations,[{id:"org-a",name:"A"}]);
      const foreign=await call("GET",`/api/oauth/requests/${nonce}`,undefined,"bob");assert.equal(foreign.statusCode,404);
      const bad=await call("POST",`/api/oauth/requests/${nonce}/decision`,{approved:true,organizationId:"org-b"},"alice");assert.equal(bad.statusCode,403,bad.body);
      const escalation=await call("POST",`/api/oauth/requests/${nonce}/decision`,{approved:true,organizationId:"org-a",scope:"growth:read growth:publish"},"alice");assert.equal(escalation.statusCode,403,escalation.body);
      const r=await call("POST",`/api/oauth/requests/${nonce}/decision`,{approved,organizationId:"org-a"},"alice");assert.equal(r.statusCode,200,r.body);
      assert.equal((await call("POST",`/api/oauth/requests/${nonce}/decision`,{approved,organizationId:"org-a"},"alice")).statusCode,404);
      const callback=new URL(r.json().redirectUrl);assert.equal(callback.searchParams.get("state"),"fixture-state");assert.equal(callback.searchParams.get("iss"),config.publicApiUrl);
      return callback;
    };
    const issue=async () => {
      const callback=await consent(await authorize());
      return {grant_type:"authorization_code",client_id:client,resource,code:callback.searchParams.get("code"),redirect_uri:"http://127.0.0.1:8787/callback",code_verifier:verifier};
    };
    const denial=await consent(await authorize(),false);assert.equal(denial.searchParams.get("error"),"access_denied");
    const exchange=await issue();
    assert.equal((await call("POST","/oauth/token",{...exchange,code_verifier:"a".repeat(43)})).statusCode,400);
    assert.equal((await call("POST","/oauth/token",{...exchange,resource:"http://other.example/mcp"})).statusCode,400);
    const race=await Promise.all([call("POST","/oauth/token",exchange),call("POST","/oauth/token",exchange)]);
    assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,400]);
    const first=race.find(r=>r.statusCode===200)!.json();
    const context=await resolveGrowthOAuthContext(core,first.access_token);
    assert.equal(context?.organizationId,"org-a");assert.equal(context?.principal.kind,"oauth_user");
    assert.deepEqual([...context!.apiScopes!],["growth:read","growth:draft"]);
    const second=(await call("POST","/oauth/token",await issue())).json();
    const connections=await call("GET","/api/oauth/connections",undefined,"alice");assert.equal(connections.json().connections.length,2);
    assert.ok(!connections.body.includes("accessHash"));
    assert.equal((await call("GET","/api/oauth/connections",undefined,"bob")).json().connections.length,0);
    assert.equal((await call("POST","/oauth/token",{grant_type:"refresh_token",client_id:"wrong-client",resource,refresh_token:first.refresh_token})).statusCode,400);
    assert.equal((await call("POST","/oauth/token",{grant_type:"refresh_token",client_id:client,resource,refresh_token:first.refresh_token,scope:"growth:read growth:publish"})).statusCode,400);
    const rotatedResponse=await call("POST","/oauth/token",{grant_type:"refresh_token",client_id:client,resource,refresh_token:first.refresh_token});assert.equal(rotatedResponse.statusCode,200,rotatedResponse.body);
    const rotated=rotatedResponse.json();await assert.rejects(resolveGrowthOAuthContext(core,first.access_token),/expired or revoked/);
    assert.ok(await resolveGrowthOAuthContext(core,rotated.access_token));
    assert.equal((await call("POST","/oauth/token",{grant_type:"refresh_token",client_id:client,resource,refresh_token:first.refresh_token})).statusCode,400);
    await assert.rejects(resolveGrowthOAuthContext(core,rotated.access_token),/expired or revoked/);
    assert.ok(await resolveGrowthOAuthContext(core,second.access_token));
    const secondContext=await resolveGrowthOAuthContext(core,second.access_token);
    assert.equal((await call("DELETE",`/api/oauth/connections/${secondContext!.principal.id}`,undefined,"bob")).statusCode,404);
    assert.equal((await call("POST","/oauth/revoke",{client_id:client,token:second.refresh_token})).statusCode,200);
    await assert.rejects(resolveGrowthOAuthContext(core,second.access_token),/expired or revoked/);
    const third=(await call("POST","/oauth/token",await issue())).json();
    await pool.query(`UPDATE "GrowthOAuthConnection" SET "accessExpiresAt"=NOW()-INTERVAL '1 minute' WHERE "accessHash"=$1`,[oauthDigest(third.access_token)]);
    await assert.rejects(resolveGrowthOAuthContext(core,third.access_token),/expired or revoked/);
    await pool.query(`UPDATE "GrowthOAuthConnection" SET "accessExpiresAt"=NOW()+INTERVAL '1 hour' WHERE "accessHash"=$1`,[oauthDigest(third.access_token)]);
    const expired=await issue();
    await pool.query(`UPDATE "GrowthOAuthCode" SET "expiresAt"=NOW()-INTERVAL '1 minute' WHERE hash=$1`,[oauthDigest(expired.code!)]);
    assert.equal((await call("POST","/oauth/token",expired)).statusCode,400);
    await pool.query(`DELETE FROM "OrganizationMember" WHERE "userId"='alice'`);
    await assert.rejects(resolveGrowthOAuthContext(core,third.access_token),/Workspace access/);
    assert.equal(await resolveGrowthOAuthContext(core,"kst_not-an-oauth-token"),null);
  } finally {
    await app?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
