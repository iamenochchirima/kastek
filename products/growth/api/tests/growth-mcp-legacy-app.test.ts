import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { oauthDigest } from "../src/oauth/index.js";
import { registerGrowthMcpRoutes } from "../src/operations/mcp.js";
import { CONTENT_APP_MIME, CONTENT_APP_TOOL_NAME } from "../src/operations/content-mcp-app.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";

const database=process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("legacy SDK discovers and reads inline review resources while model calls cannot confirm",{skip:!database,timeout:60000},async()=>{
  const inventory=new pg.Pool({connectionString:database});
  const tables=(await inventory.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row=>row.tablename)
    .filter(name=>/^[A-Za-z_]+$/.test(name)&&!name.startsWith("GrowthOAuth")&&!["GrowthOperationReview","GrowthMediaTransfer","analytics_outbox"].includes(name));
  await inventory.end();
  const fixture=await isolatedDatabase(database!,"mcp_legacy_app",tables);
  let app:Awaited<ReturnType<typeof buildApp>>|undefined;
  const client=new Client({name:"legacy-owned-fixture",version:"1.0.0"});
  try {
    await fixture.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await fixture.pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",import.meta.url),"utf8"));
    for(const migration of ["20261101130000_growth_oauth.sql","20261101140000_growth_operation_reviews.sql","20261102190000_content_agent_workflows.sql","20261102200000_content_mcp_app_confirmation.sql"])
      await fixture.pool.query(await readFile(new URL(`../sql/${migration}`,import.meta.url),"utf8"));
    await fixture.pool.query(`INSERT INTO "User"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('alice','Alice','alice@example.test',now(),now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org-a','Fixture business','legacy-app-fixture','alice',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org-a','alice','OWNER',now());
      INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","updatedAt") VALUES('facebook','alice','org-a','FACEBOOK','CONNECTED','Fixture Page','fixture-page',now());
      INSERT INTO "GrowthOAuthClient"(id,name,"redirectUris") VALUES('legacy-fixture','Fixture',ARRAY['http://localhost/callback']);`);
    const token="growth_oauth_"+randomBytes(32).toString("base64url");
    await fixture.pool.query(`INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt") VALUES('connection','legacy-fixture','alice','org-a','http://localhost:4000/mcp',ARRAY['growth:read','growth:draft','growth:manage'],$1,now()+interval '1 hour')`,[oauthDigest(token)]);
    const config=readConfig({DATABASE_URL:database!,ENVIRONMENT:"test",KASITEK_CORE_PUBLIC_URL:"http://localhost:4000",FRONTEND_URL:"http://localhost:3002",GROWTH_AGENT_ACCESS_ENABLED:"true",LOG_LEVEL:"silent"});
    app=await buildApp({pool:fixture.pool,config},[registerGrowthMcpRoutes]);
    const fixtureFetch:typeof fetch=async(input,init)=>{
      const url=new URL(String(input));
      const headers=Object.fromEntries(new Headers(init?.headers).entries());
      const response=await app!.inject({method:(init?.method??"GET") as "POST",url:url.pathname,headers:{...headers,host:url.host},payload:init?.body as string|undefined});
      return new Response(response.body||null,{status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]))});
    };
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4000/mcp"),{fetch:fixtureFetch,requestInit:{headers:{authorization:"Bearer "+token}}}));
    const resources=await client.listResources();
    assert.equal(resources.resources.length,1);
    assert.equal(resources.resources[0]!.mimeType,CONTENT_APP_MIME);
    const resource=await client.readResource({uri:resources.resources[0]!.uri});
    assert.equal(resource.contents[0]!.mimeType,CONTENT_APP_MIME);
    assert.ok("text" in resource.contents[0]!&&resource.contents[0]!.text.includes("<html"));
    const forbidden=await client.callTool({name:CONTENT_APP_TOOL_NAME,arguments:{}});
    assert.equal(forbidden.isError,true);
    assert.equal((forbidden.structuredContent as {code:string}).code,"content_confirmation_unavailable");
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM "GrowthOperationReview"')).rows[0].count,0);
    const draft=await client.callTool({name:"content.posts.draft.create",arguments:{_requestId:"legacy-ui-private-draft",draft:{content:"Legacy fixture draft",channels:["FACEBOOK"],primaryChannelId:"facebook",channelSelections:{FACEBOOK:"facebook"}}}});
    const saved=draft.structuredContent as {state:string;result:{post:{id:string}}};
    assert.equal(saved.state,"succeeded");
    const pending=await client.callTool({name:"content.posts.delete",arguments:{postId:saved.result.post.id,_requestId:"legacy-unsupported-delete"}});
    assert.equal((pending.structuredContent as {state:string}).state,"confirmation_unavailable");
    assert.equal(JSON.stringify(pending).includes("reviewUrl"),false);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM "SocialPost" WHERE id=$1',[saved.result.post.id])).rows[0].count,1);
    assert.equal((await fixture.pool.query('SELECT state FROM "GrowthOperationReview" WHERE "requestKey"=$1',["legacy-unsupported-delete"])).rows[0].state,"proposed");
  } finally {await client.close();await app?.close();await fixture.close();}
});
