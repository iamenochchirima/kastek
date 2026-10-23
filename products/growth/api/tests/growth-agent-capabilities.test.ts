import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { readConfig } from "../src/config.js";
import { installErrorHandler } from "../src/error.js";
import { growthAgentSocialFixture } from "./growth-agent-fixture.js";
import { growthAgentDigest } from "../src/agents/security.js";
import { growthCapabilityManifest, growthAgentPresets } from "../src/agents/manifest.js";
import { registerGrowthCapabilityRoutes } from "../src/agents/capability-routes.js";
import { discoverGrowthRecords, readGrowthRecord } from "../src/agents/tools.js";
import type { CoreContext } from "../src/context.js";

test("Growth owns shared capability selections without purpose-specific mandatory tool sequences",()=>{
  assert.equal(new Set(growthAgentPresets.map(p=>p.id)).size,4);
  assert(growthAgentPresets.every(p=>p.operations.includes("content.read")&&p.operations.includes("campaigns.read")));
  assert(growthAgentPresets.find(p=>p.id==="assistant")!.operations.includes("draft.prepare"));
  assert(!growthAgentPresets.find(p=>p.id==="research")!.operations.includes("draft.prepare"));
  const {digest,...content}=growthCapabilityManifest;assert.equal(digest,growthAgentDigest(content));
  assert(growthCapabilityManifest.operations.every(op=>!JSON.stringify(op).includes("https://")));
});

test("real content discovery and continuation retain current tenant, actor, source and exact operation authority",{skip:!process.env.CORE_ORGS_TEST_DATABASE_URL},async()=>{
  const url=process.env.CORE_ORGS_TEST_DATABASE_URL!,schema="growth_caps_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema} -c timezone=UTC`});
  const previous=process.env.KASITEK_BILLING_ENFORCEMENT;process.env.KASITEK_BILLING_ENFORCEMENT="false";
  const app=Fastify();installErrorHandler(app);
  try {
    await pool.query(`CREATE TABLE "Organization"(id text PRIMARY KEY,name text,"reportingTimezone" text,"updatedAt" timestamp DEFAULT now());
      CREATE TABLE "User"(id text PRIMARY KEY,"emailVerified" timestamp);
      CREATE TABLE "OrganizationMember"("orgId" text,"userId" text);
      CREATE TABLE "OrganizationOnboardingProfile"("orgId" text,website text,industry text,"primaryGoal" text,"primaryGoals" text[]);
      INSERT INTO "Organization"(id,name) VALUES('org','Business'),('foreign-org','Foreign');
      INSERT INTO "User" VALUES('user',now()),('outsider',now());
      INSERT INTO "OrganizationMember" VALUES('org','user');`);
    await pool.query(growthAgentSocialFixture);
    await pool.query(`INSERT INTO "SocialPost"(id,"userId","orgId",title,content,channels,status,"createdAt","updatedAt") VALUES
      ('a','user','org','First',$1,'{FACEBOOK}','DRAFT',now(),now()),
      ('b','user','org','Second','Other content','{FACEBOOK}','DRAFT',now(),now()),
      ('c','foreign-user','foreign-org','Secret','Must not appear','{FACEBOOK}','DRAFT',now(),now())`,["Useful content ".repeat(1000)]);
    const keys=await generateKeyPair("RS256",{extractable:true});
    const core={pool,config:readConfig({DATABASE_URL:url,AGENTS_PRODUCT_ACTION_PUBLIC_KEY:await exportSPKI(keys.publicKey)})} as CoreContext;
    const scope={tenantId:"org",actor:{issuer:"https://growth.kasitek.co.za/identity",subject:"user"}};
    const first=await discoverGrowthRecords(core,scope,"content_post",{limit:1});
    assert.equal(first.items[0]!.context.resourceId,"a");assert(first.nextCursor);
    const second=await discoverGrowthRecords(core,scope,"content_post",{limit:1,cursor:first.nextCursor});
    assert.equal(second.items[0]!.context.resourceId,"b");assert.equal(second.nextCursor,null);
    await assert.rejects(discoverGrowthRecords(core,scope,"content_post",{limit:1,cursor:first.nextCursor,search:"changed"}));
    await assert.rejects(discoverGrowthRecords(core,{...scope,actor:{...scope.actor,subject:"outsider"}},"content_post",{}));
    await assert.rejects(discoverGrowthRecords(core,scope,"content_post",{limit:21}));
    const context={kind:"content_post" as const,resourceId:"a"};
    const chunks=[];let current=await readGrowthRecord(core,scope,context,{resourceId:"a"});
    const revision=current.revision;chunks.push((current.data as {text:string}).text);
    while(current.continuation){current=await readGrowthRecord(core,scope,context,{resourceId:"a",continuation:current.continuation});chunks.push((current.data as {text:string}).text);assert.equal(current.revision,revision);}
    assert.equal((JSON.parse(chunks.join("")) as {content:string}).content,"Useful content ".repeat(1000));
    const stale=await readGrowthRecord(core,scope,context,{resourceId:"a"});
    await pool.query('UPDATE "SocialPost" SET content=\'Changed\',"updatedAt"=now() WHERE id=\'a\'');
    await assert.rejects(readGrowthRecord(core,scope,context,{continuation:stale.continuation}),{code:"agent_source_changed"});
    registerGrowthCapabilityRoutes(app,core);
    const descriptor=growthCapabilityManifest.operations.find(o=>o.operation==="content.read")!;
    const command={version:"1",requestId:randomUUID(),operationId:"read-one",taskId:randomUUID(),conversationId:randomUUID(),actor:scope.actor,
      authority:{kind:"product",originProduct:"growth",destinationProduct:"growth",originTenantId:"org",tenantId:"org",mappingRef:"growth:org",policyRevision:"2",
        manifestDigest:growthCapabilityManifest.digest,descriptorDigest:growthAgentDigest(descriptor),handlerRef:descriptor.handlerRef},
      bindingId:randomUUID(),bindingDigest:"a".repeat(64),operation:"content.read",control:"invoke",input:{resourceId:"a"}};
    async function send(body:unknown){const token=await new SignJWT({product:"growth",requestDigest:growthAgentDigest(body)}).setProtectedHeader({alg:"RS256",kid:"agents-v1"})
      .setIssuer("https://agents.kasitek.co.za").setAudience("product-capability-actions").setSubject("agents-worker").setJti(randomUUID()).setIssuedAt().setExpirationTime("60s").sign(keys.privateKey);
      return app.inject({method:"POST",url:"/internal/agents/capabilities",headers:{authorization:"Bearer "+token},payload:body});}
    assert.equal((await send(command)).statusCode,200);
    assert.equal((await send({...command,input:{resourceId:"c"}})).statusCode,404);
    assert.equal((await send({...command,authority:{...command.authority,destinationProduct:"agency"}})).statusCode,403);
    assert.equal((await send({...command,authority:{...command.authority,descriptorDigest:"0".repeat(64)}})).statusCode,403);
    assert.equal((await send({...command,input:{resourceId:"a",url:"https://attacker.test"}})).statusCode,422);
    await pool.query('DELETE FROM "OrganizationMember" WHERE "userId"=\'user\'');
    assert.equal((await send(command)).statusCode,403);
  } finally {
    if(previous===undefined)delete process.env.KASITEK_BILLING_ENFORCEMENT;else process.env.KASITEK_BILLING_ENFORCEMENT=previous;
    await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});
