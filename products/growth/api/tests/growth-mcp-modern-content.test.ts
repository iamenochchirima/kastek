import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { installPgTimestampParsers } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { oauthDigest } from "../src/oauth/index.js";
import { registerGrowthMcpRoutes } from "../src/operations/mcp.js";
import { MCP_2026_VERSION } from "../src/operations/mcp-2026.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";

const database=process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("modern authenticated MCP exposes optional exact previews and performs authorized content actions once",{skip:!database,timeout:60000},async()=>{
  installPgTimestampParsers();
  const inventory=new pg.Pool({connectionString:database});
  const tables=(await inventory.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row=>row.tablename)
    .filter(name=>/^[A-Za-z_]+$/.test(name)&&!name.startsWith("GrowthOAuth")&&!["GrowthOperationReview","GrowthMediaTransfer","analytics_outbox"].includes(name));
  await inventory.end();
  const fixture=await isolatedDatabase(database!,"mcp_modern_app",tables);
  let app:Awaited<ReturnType<typeof buildApp>>|undefined;
  try {
    await fixture.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await fixture.pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",import.meta.url),"utf8"));
    for(const migration of ["20261101130000_growth_oauth.sql","20261101140000_growth_operation_reviews.sql","20261101150000_growth_media_transfers.sql","20261102190000_content_agent_workflows.sql","20261102200000_content_mcp_app_confirmation.sql","20261102210000_content_requested_actions.sql"])
      await fixture.pool.query(await readFile(new URL(`../sql/${migration}`,import.meta.url),"utf8"));
    await fixture.pool.query(`INSERT INTO "User"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('alice','Alice','alice@example.test',now(),now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org-a','Fixture business','modern-app-fixture','alice',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org-a','alice','OWNER',now());
      INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","updatedAt") VALUES('facebook','alice','org-a','FACEBOOK','CONNECTED','Fixture Page','fixture-page',now());
      INSERT INTO "GrowthOAuthClient"(id,name,"redirectUris") VALUES('modern-fixture','Fixture',ARRAY['http://localhost/callback']);`);
    const token="growth_oauth_"+randomBytes(32).toString("base64url");
    await fixture.pool.query(`INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt") VALUES('connection','modern-fixture','alice','org-a','http://localhost:4000/mcp',ARRAY['growth:read','growth:draft','growth:manage'],$1,now()+interval '1 hour')`,[oauthDigest(token)]);
    const config=readConfig({DATABASE_URL:database!,ENVIRONMENT:"test",KASITEK_CORE_PUBLIC_URL:"http://localhost:4000",FRONTEND_URL:"http://localhost:3002",GROWTH_AGENT_ACCESS_ENABLED:"true",GROWTH_AGENT_EFFECTS_ENABLED:"true",LOG_LEVEL:"silent"});
    app=await buildApp({pool:fixture.pool,config},[registerGrowthMcpRoutes]);
    const ui={extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}},elicitation:{form:{}}};
    const send=async(method:string,params:Record<string,unknown>={},capabilities:Record<string,unknown>=ui)=>{
      const name=typeof params.name==="string"?params.name:typeof params.uri==="string"?params.uri:undefined;
      const response=await app!.inject({method:"POST",url:"/mcp",headers:{host:"localhost:4000",authorization:"Bearer "+token,"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":method,...(name?{"mcp-name":name}:{})},
        payload:{jsonrpc:"2.0",id:randomBytes(4).toString("hex"),method,params:{...params,_meta:{"io.modelcontextprotocol/protocolVersion":MCP_2026_VERSION,"io.modelcontextprotocol/clientCapabilities":capabilities}}}});
      assert.equal(response.statusCode,200);
      return response.json().result;
    };
    assert.deepEqual((await send("server/discover")).capabilities,{tools:{}});
    const tools=(await send("tools/list")).tools as {name:string;_meta?:unknown}[];
    assert.equal(tools.some(tool=>tool.name==="content.actions.confirm"),false);
    assert.equal(tools.some(tool=>tool._meta!==undefined),false);
    const saved=await send("tools/call",{name:"content.posts.draft.create",arguments:{_requestId:"modern-ui-private-draft",draft:{content:"Exact inline review draft",channels:["FACEBOOK"],primaryChannelId:"facebook",channelSelections:{FACEBOOK:"facebook"}}}});
    assert.equal(saved.structuredContent.state,"succeeded");
    const postId=saved.structuredContent.result.post.id;
    const preview=await send("tools/call",{name:"content.actions.preview",arguments:{action:"content.posts.delete",input:{postId},requestId:"modern-optional-preview"}});
    assert.equal(preview.resultType,"complete");
    assert.equal(preview._meta,undefined);
    const exact=preview.structuredContent.result.preview.preview;
    assert.equal(exact.content,"Exact inline review draft");
    assert.equal(exact.accounts[0].displayName,"Fixture Page");
    assert.ok(Array.isArray(exact.media));
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM "SocialPost" WHERE id=$1',[postId])).rows[0].count,1);
    await fixture.pool.query('UPDATE "GrowthOAuthConnection" SET scopes=$1 WHERE id=$2',[["growth:read"],"connection"]);
    const denied=await send("tools/call",{name:"content.posts.delete",arguments:{postId,_requestId:"modern-read-cannot-delete"}},{});
    assert.equal(denied.structuredContent.code,"operation_scope_denied");
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM "SocialPost" WHERE id=$1',[postId])).rows[0].count,1);
    await fixture.pool.query('UPDATE "GrowthOAuthConnection" SET scopes=$1 WHERE id=$2',[["growth:read","growth:draft","growth:manage"],"connection"]);
    const args={postId,_requestId:"modern-direct-delete-once"};
    const accepted=await send("tools/call",{name:"content.posts.delete",arguments:args},{});
    assert.equal(accepted.structuredContent.state,"succeeded");
    assert.equal(accepted.resultType,"complete");
    assert.equal(accepted.inputRequests,undefined);
    assert.equal(accepted._meta,undefined);
    const replay=await send("tools/call",{name:"content.posts.delete",arguments:args},{});
    assert.deepEqual(replay.structuredContent,accepted.structuredContent);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM "SocialPost" WHERE id=$1',[postId])).rows[0].count,0);
    assert.deepEqual((await fixture.pool.query('SELECT state,"decisionSource" FROM "GrowthOperationReview" WHERE "requestKey"=$1',[args._requestId])).rows[0],{state:"succeeded",decisionSource:"requested_action"});
    const retired=await send("tools/call",{name:"content.actions.confirm",arguments:{approved:true}},{});
    assert.equal(retired.isError,true);
    assert.equal(retired.structuredContent.code,"operation_not_found");
  } finally {await app?.close();await fixture.close();}
});
