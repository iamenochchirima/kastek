import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import pg from "pg";
import { readConfig } from "../src/config.js";
import { backchannelLogout, logoutAll } from "../src/identity/logout.js";

const database=process.env.CORE_OAUTH_TEST_DATABASE_URL;
test("Verified subject-wide revocation ends OAuth grants while sid logout preserves independent connections",{skip:!database,timeout:30000},async()=>{
  const admin=new pg.Pool({connectionString:database}),schema=`oauth_revoke_${randomBytes(12).toString("hex")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema} -c timezone=UTC`});
  const keys=await generateKeyPair("RS256"),jwk={...(await exportJWK(keys.publicKey)),kid:"fixture",alg:"RS256"};
  let adminFails=false;
  const server=createServer((req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.url?.endsWith("/certs"))return res.end(JSON.stringify({keys:[jwk]}));
    if(req.url?.endsWith("/token"))return res.end(JSON.stringify({access_token:"fixture-admin"}));
    if(req.url?.endsWith("/logout")){res.statusCode=adminFails?503:204;return res.end();}
    res.statusCode=404;res.end("{}");
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const issuer=`http://127.0.0.1:${(server.address() as {port:number}).port}/realms/fixture`;
  const config=readConfig({DATABASE_URL:database,OIDC_ISSUER_URL:issuer,OIDC_CLIENT_ID:"growth",OIDC_CLIENT_SECRET:"fixture",OIDC_ADMIN_CLIENT_ID:"admin",OIDC_ADMIN_CLIENT_SECRET:"fixture"}),core={pool,config};
  try {
    await pool.query(`CREATE TABLE "Session"("userId" text,"providerSid" text);CREATE TABLE "ExternalIdentity"(issuer text,subject text,"userId" text);CREATE TABLE "OidcLogoutReplay"(jti text PRIMARY KEY,expires timestamptz);
      INSERT INTO "Session" VALUES('alice','alice-device'),('alice','alice-second-device'),('bob','bob-device');`);
    await pool.query(`INSERT INTO "ExternalIdentity" VALUES($1,'alice-subject','alice'),($1,'bob-subject','bob')`,[issuer]);
    await pool.query(await readFile(new URL("../sql/20261101130000_growth_oauth.sql",import.meta.url),"utf8"));
    await pool.query(`INSERT INTO "GrowthOAuthClient"(id,name,"redirectUris") VALUES('client','Fixture',ARRAY['https://client.example/cb']);
      INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt") VALUES('alice-grant','client','alice','org','resource',ARRAY['growth:read'],'alice-access',NOW()+INTERVAL '1 hour'),('bob-grant','client','bob','org','resource',ARRAY['growth:read'],'bob-access',NOW()+INTERVAL '1 hour');
      INSERT INTO "GrowthOAuthCode"(hash,"clientId","userId","orgId","redirectUri",resource,scopes,challenge,"expiresAt") VALUES('alice-code','client','alice','org','https://client.example/cb','resource',ARRAY['growth:read'],'challenge',NOW()+INTERVAL '1 minute');
      INSERT INTO "GrowthOAuthRequest"(hash,"clientId","userId","redirectUri",resource,scopes,state,challenge,"expiresAt") VALUES('alice-request','client','alice','https://client.example/cb','resource',ARRAY['growth:read'],'state','challenge',NOW()+INTERVAL '1 minute');`);
    const signed=(jti:string,claims:Record<string,unknown>)=>new SignJWT({iss:issuer,aud:"growth",iat:Math.floor(Date.now()/1000),jti,events:{"http://schemas.openid.net/event/backchannel-logout":{}},...claims}).setProtectedHeader({alg:"RS256",kid:"fixture"}).sign(keys.privateKey);
    const revoked=async(id:string)=>(await pool.query(`SELECT "revokedAt" IS NOT NULL AS revoked FROM "GrowthOAuthConnection" WHERE id=$1`,[id])).rows[0].revoked;
    await backchannelLogout(core,await signed("sid-only",{sid:"alice-device",sub:"alice-subject"}));
    assert.equal(await revoked("alice-grant"),false);
    assert.equal((await pool.query(`SELECT COUNT(*)::integer AS count FROM "Session" WHERE "userId"='alice'`)).rows[0].count,1);
    const all=await signed("subject-global",{sub:"alice-subject"});await backchannelLogout(core,all);
    assert.equal(await revoked("alice-grant"),true);assert.equal(await revoked("bob-grant"),false);
    assert.equal((await pool.query(`SELECT "usedAt" IS NOT NULL AS used FROM "GrowthOAuthCode" WHERE hash='alice-code'`)).rows[0].used,true);
    assert.equal((await pool.query(`SELECT "usedAt" IS NOT NULL AS used FROM "GrowthOAuthRequest" WHERE hash='alice-request'`)).rows[0].used,true);
    await assert.rejects(backchannelLogout(core,all));assert.equal(await revoked("bob-grant"),false);
    adminFails=true;await assert.rejects(logoutAll(core,"bob"));assert.equal(await revoked("bob-grant"),false);
    adminFails=false;await logoutAll(core,"bob");assert.equal(await revoked("bob-grant"),true);
  } finally {
    server.close();await once(server,"close");await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
