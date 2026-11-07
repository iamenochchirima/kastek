import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import {generateKeyPair,exportSPKI,SignJWT} from "jose";
import {readConfig} from "../src/config.js";
import {installPgTimestampParsers} from "../src/db.js";
import {installErrorHandler} from "../src/error.js";
import {growthAgentPublication} from "../src/agents/manifest.js";
import {growthAgentDigest} from "../src/agents/security.js";
import {registerGrowthCapabilityRoutes} from "../src/agents/capability-routes.js";
import {growthReadResources} from "../src/operations/read-access.js";
import {growthAgentSocialFixture} from "./growth-agent-fixture.js";
import type {CoreContext} from "../src/context.js";

test("read access captures pre-chunk resources and treats unavailable source identities honestly",()=>{
  const post={id:"post",primaryChannel:null,variants:[{id:"variant",post_id:"post"}],media:[{id:"link",post_id:"post",asset_id:"asset"}],publishJobs:[]};
  const selected=growthReadResources("content.posts.list",{}, {posts:[post],pagination:{}});
  assert.deepEqual(selected.resources.map(value=>value.kind),["media","post","post_media","post_variant"]);
  const broadPosts=Array.from({length:100},(_,index)=>({id:`post-${index}`,primaryChannel:null,
    variants:Array.from({length:20},(_,variant)=>({id:`variant-${index}-${variant}`,post_id:`post-${index}`})),media:[],publishJobs:[]}));
  assert.equal(growthReadResources("content.posts.list",{}, {posts:broadPosts,pagination:{}}).resources.length,2100);
  const plan=growthReadResources("content.posts.publish_batch.preflight",{postId:"post"},{postId:"post",targets:[]},
    {preflight:{post,targets:[{jobId:"job",channelConnectionId:"account"}]}});
  assert(plan.resources.some(value=>value.kind==="post_job_account"&&value.id==="job"&&value.parent==="account"));
  const batch=growthReadResources("content.posts.publish_batch.status",{batchId:"batch"},{batchId:"batch",postId:"post"},
    {batch:{batchId:"batch",postId:"post",targets:[{access_item_id:"item",access_job_id:"job",access_channel_id:"account"}]}});
  assert(batch.resources.some(value=>value.kind==="batch_item"&&value.parent==="batch"));
  assert(batch.resources.some(value=>value.kind==="batch_account"&&value.parent==="account"));
  const expiry=Math.floor(Date.now()/1000)+900,url=`https://example.test/${"a".repeat(500)}?expires=${expiry}&signature=test`;
  assert.equal(growthReadResources("content.media.preview",{assetId:"asset"},{asset:{id:"asset"},previewUrl:url}).expiresAt,expiry*1000);
  assert.throws(()=>growthReadResources("content.media.preview",{assetId:"asset"},{asset:{id:"asset"},previewUrl:"https://example.test/?expires=1"}));
  assert.throws(()=>growthReadResources("inbox.conversations.list",{}, {conversations:[{id:"conversation"}]},{inbox:[]}));
  const inbox=growthReadResources("inbox.conversations.list",{}, {conversations:[{id:"conversation"}]},
    {inbox:[{conversationId:"conversation",messageId:"message",connectionId:"account",connectionKind:"social",externalConnectionId:"external"}]});
  assert(inbox.resources.some(value=>value.kind==="message"&&value.parent==="conversation"));
  assert(inbox.resources.some(value=>value.kind==="conversation_external"&&value.parent==="external"));
  assert.throws(()=>growthReadResources("analytics.read",{}, {report:{}}));
  assert.throws(()=>growthReadResources("inbox.messages.list",{conversationId:"conversation"},{messages:[{id:"message",conversationId:"conversation",deletedAt:null,attachments:[],reactions:[],reference:{messageId:null,previewText:"Not attributable"}}]}));
});


test("content library reads preserve scoped media/template custody",()=>{
  assert.deepEqual(growthReadResources("content.media.list",{},{assets:[{id:"asset"}]}).resources,[{kind:"media",id:"asset"}]);
  const template=growthReadResources("content.templates.get",{templateId:"template"},{template:{id:"template",media:[{assetId:"asset"}]}});
  assert(template.resources.some(resource=>resource.kind==="content_template_media"&&resource.id==="asset"&&resource.parent==="template"));
  const usage=growthReadResources("content.media.usage",{assetId:"asset"},{assetId:"asset",usage:[{type:"post",id:"post"},{type:"template",id:"template"}]});
  assert(usage.resources.some(resource=>resource.kind==="media_usage_post"&&resource.id==="post"&&resource.parent==="asset"));
  assert(usage.resources.some(resource=>resource.kind==="media_usage_template"&&resource.id==="template"&&resource.parent==="asset"));
  assert.throws(()=>growthReadResources("content.templates.get",{templateId:"expected"},{template:{id:"other",media:[]}}));
});
const database=process.env.CORE_GROWTH_ACCESS_TEST_DATABASE_URL;
test("negotiated Growth read access binds the exact receipt and rechecks current scope",{skip:!database,timeout:30000},async()=>{
  installPgTimestampParsers();
  const name=`growth_read_access_${randomUUID().replaceAll("-","")}`,admin=new pg.Pool({connectionString:database});
  await admin.query(`CREATE DATABASE "${name}"`);
  const target=new URL(database!);target.pathname=`/${name}`;
  const pool=new pg.Pool({connectionString:target.href,options:"-c timezone=UTC"});
  const app=Fastify();installErrorHandler(app);
  try {
    await pool.query(`CREATE TYPE "OrganizationSubscriptionStatus" AS ENUM ('TRIAL','ACTIVE','GRACE');
      CREATE TABLE "Organization"(id text PRIMARY KEY,name text,slug text,logo text,"ownerId" text,"reportingTimezone" text,"createdAt" timestamp,"updatedAt" timestamp);
      CREATE TABLE "User"(id text PRIMARY KEY,"emailVerified" timestamp);
      CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);
      CREATE TABLE "OrganizationOnboardingProfile"("orgId" text,website text,industry text,"primaryGoal" text,"primaryGoals" text[]);
      CREATE TABLE "OrganizationEntitlementGrant"("orgId" text,key text,value jsonb,"startsAt" timestamp,"endsAt" timestamp);
      CREATE TABLE "OrganizationSubscription"("orgId" text,"planId" text,status "OrganizationSubscriptionStatus");
      CREATE TABLE "PlanEntitlement"("planId" text,key text,value jsonb);
      CREATE TABLE "PublicApiRequest"(id text,"orgId" text,"principalType" text,"principalId" text,route text,method text,"statusCode" int,"correlationId" text,action text,"createdAt" timestamptz,"updatedAt" timestamptz);
      CREATE TABLE "UsageEvent"(id text,"orgId" text,"productKey" text,"metricKey" text,quantity int,"sourceType" text,"sourceId" text,"idempotencyKey" text,metadata jsonb);
      CREATE TABLE "ExternalConnection"(id text,"orgId" text,"sourceType" text,"sourceId" text,"displayName" text,handle text);
      CREATE TABLE "WhatsappConnection"(id text,"orgId" text,"phoneDisplayNumber" text,"phoneNumberId" text);
      CREATE TABLE "Conversation"(id text,"orgId" text,channel text,"customerIdentifier" text,"customerName" text,status text,"lastMessageAt" timestamp,"lastReadAt" timestamp,"unreadCount" int,starred boolean,"externalConnectionId" text,"createdAt" timestamp,"updatedAt" timestamp);
      CREATE TABLE "Message"(id text,"conversationId" text,content text,timestamp timestamp,"deletedAt" timestamp,"providerMetadata" jsonb);
      CREATE TABLE "GrowthMediaTransfer"(id text PRIMARY KEY,"orgId" text,"userId" text,"principalId" text,"principalKind" text,"requestKey" text,"fileName" text,"mimeType" text,"byteSize" bigint,"expectedChecksum" text,checksum text,"storageKey" text,state text DEFAULT 'PENDING',"assetId" text,"expiresAt" timestamptz,"updatedAt" timestamptz DEFAULT now());
      INSERT INTO "Organization" VALUES('org','Business','business',NULL,'user','UTC',NOW(),NOW()),('foreign-org','Foreign','foreign',NULL,'other','UTC',NOW(),NOW());
      INSERT INTO "User" VALUES('user',NOW()),('other',NOW());
      INSERT INTO "OrganizationMember" VALUES('org','user','OWNER'),('org','other','MEMBER');
      INSERT INTO "OrganizationEntitlementGrant" VALUES('org','feature.agents.manage','true',NOW()-interval '1 hour',NULL),('org','feature.content.manage','true',NOW()-interval '1 hour',NULL),('org','feature.inbox.access','true',NOW()-interval '1 hour',NULL);
      INSERT INTO "WhatsappConnection" VALUES('wa','org','number','phone');
      INSERT INTO "Conversation" VALUES('conversation','org','whatsapp','wa:wa:+123','Customer','OPEN',NOW(),NULL,1,false,NULL,NOW(),NOW());
      INSERT INTO "Message" VALUES('message','conversation','Private message',NOW(),NULL,NULL);`);
    await pool.query(growthAgentSocialFixture);
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20261023183000_growth_agent_source_handles/migration.sql",import.meta.url),"utf8"));
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20261103100000_growth_read_access_handles/migration.sql",import.meta.url),"utf8"));
    await pool.query(`INSERT INTO "SocialPost"(id,"userId","orgId",title,content,channels,status,"createdAt","updatedAt")
      VALUES('post','user','org','Post',$1,'{FACEBOOK}','DRAFT',NOW(),NOW())`,["Retained original ".repeat(900)]);
    const keys=await generateKeyPair("RS256",{extractable:true});
    const core={pool,config:readConfig({DATABASE_URL:database!,ENVIRONMENT:"test",GROWTH_AGENT_ACCESS_ENABLED:"true",AGENTS_PRODUCT_ACTION_PUBLIC_KEY:await exportSPKI(keys.publicKey)})} as CoreContext;
    registerGrowthCapabilityRoutes(app,core);
    const descriptor=growthAgentPublication.manifest.operations.find(value=>value.operation==="content.posts.get")!;
    const actor={issuer:"https://growth.kasitek.co.za/identity",subject:"user"};
    const command={version:"1",requestId:randomUUID(),operationId:"read-one",taskId:randomUUID(),conversationId:randomUUID(),actor,
      authority:{kind:"product",originProduct:"growth",destinationProduct:"growth",originTenantId:"org",tenantId:"org",mappingRef:"growth:org",policyRevision:growthAgentPublication.policy.revision,
        manifestDigest:growthAgentPublication.manifest.digest,descriptorDigest:growthAgentDigest(descriptor),handlerRef:descriptor.handlerRef},
      bindingId:randomUUID(),bindingDigest:"a".repeat(64),operation:descriptor.operation,control:"invoke",input:{postId:"post"}};
    async function send(body:unknown){const token=await new SignJWT({product:"growth",requestDigest:growthAgentDigest(body)}).setProtectedHeader({alg:"RS256",kid:"agents-v1"})
      .setIssuer("https://agents.kasitek.co.za").setAudience("product-capability-actions").setSubject("agents-worker").setJti(randomUUID()).setIssuedAt().setExpirationTime("60s").sign(keys.privateKey);
      return app.inject({method:"POST",url:"/internal/agents/capabilities",headers:{authorization:`Bearer ${token}`},payload:body});}
    const legacy=await send(command);assert.equal(legacy.statusCode,200,legacy.body);assert.equal(legacy.json().access,undefined);
    const observed=await send({...command,observation:"access-v1"});assert.equal(observed.statusCode,200,observed.body);
    const payload=observed.json(),access=payload.access;assert.deepEqual(payload.value,legacy.json().value);
    assert.equal(access.version,"1");assert.match(access.reference,/^growth-read-access:/);assert.match(access.scopeReference,/^growth-read-scope:/);
    assert.equal(payload.value.result.encoding,"json");
    const repeat=await send({...command,observation:"access-v1"});assert.equal(repeat.statusCode,200,repeat.body);assert.deepEqual(repeat.json().access,access);
    const later=await send({...command,taskId:randomUUID(),operationId:"read-two",observation:"access-v1"});assert.equal(later.statusCode,200,later.body);
    assert.notEqual(later.json().access.reference,access.reference);assert.equal(later.json().access.scopeReference,access.scopeReference);
    await pool.query(`INSERT INTO "SocialPost"(id,"userId","orgId",title,content,channels,status,"createdAt","updatedAt") VALUES('short','user','org','Short','A real selected post.','{FACEBOOK}','DRAFT',NOW(),NOW())`);
    const short=await send({...command,operationId:"short-read",input:{postId:"short"},observation:"access-v1"});assert.equal(short.statusCode,200,short.body);
    const evidence={...command,control:"evidence",operationId:"check-one",input:{source:{id:access.scopeReference}}};
    assert.deepEqual((await send(evidence)).json().value,{authorized:true,scopeReference:access.scopeReference});
    const exact={...evidence,input:{source:{id:access.reference,revision:access.resultDigest,operationId:command.operationId}}};
    assert.deepEqual((await send(exact)).json().value,{authorized:true,revision:access.resultDigest});
    assert.equal((await send({...exact,input:{source:{...exact.input.source,operationId:"wrong"}}})).statusCode,409);
    assert.equal((await send({...evidence,conversationId:randomUUID()})).statusCode,409);
    assert.equal((await send({...evidence,actor:{...actor,subject:"other"}})).statusCode,409);
    assert.equal((await send({...evidence,bindingDigest:"b".repeat(64)})).statusCode,409);
    const inboxDescriptor=growthAgentPublication.manifest.operations.find(value=>value.operation==="inbox.conversations.list")!;
    const inbox={...command,operation:inboxDescriptor.operation,operationId:"inbox-read",bindingId:randomUUID(),input:{},observation:"access-v1",
      authority:{...command.authority,descriptorDigest:growthAgentDigest(inboxDescriptor),handlerRef:inboxDescriptor.handlerRef}};
    const inboxResponse=await send(inbox);assert.equal(inboxResponse.statusCode,200,inboxResponse.body);
    assert.equal(inboxResponse.json().value.result.conversations[0].lastMessage,"Private message");
    assert(!JSON.stringify(inboxResponse.json().value).includes("access_message_id"));
    const {observation:_observation,...inboxBase}=inbox;
    const inboxEvidence={...inboxBase,control:"evidence",operationId:"check-inbox",input:{source:{id:inboxResponse.json().access.scopeReference}}};
    assert.equal((await send(inboxEvidence)).statusCode,200);
    await pool.query(`UPDATE "Message" SET "deletedAt"=NOW() WHERE id='message'`);
    assert.equal((await send(inboxEvidence)).statusCode,409);
    const stageDescriptor=growthAgentPublication.manifest.operations.find(value=>value.operation==="content.media.transfer.prepare")!;
    const stage={...command,operation:stageDescriptor.operation,operationId:"stage-one",bindingId:randomUUID(),input:{mimeType:"image/png",byteSize:512},observation:"access-v1",
      authority:{...command.authority,descriptorDigest:growthAgentDigest(stageDescriptor),handlerRef:stageDescriptor.handlerRef}};
    const staged=await send(stage);assert.equal(staged.statusCode,200,staged.body);
    const transfer=staged.json().value.result,stageAccess=staged.json().access;
    assert.equal(transfer.requiresAuthentication,true);assert.equal(stageAccess.resultDigest,growthAgentDigest(staged.json().value));
    const {observation:_stageObservation,...stageBase}=stage;
    const stageEvidence={...stageBase,control:"evidence",operationId:"check-stage",input:{source:{id:stageAccess.scopeReference}}};
    assert.equal((await send(stageEvidence)).statusCode,200);
    assert.equal((await send({...stageEvidence,actor:{...actor,subject:"other"}})).statusCode,409);
    await pool.query(`UPDATE "GrowthMediaTransfer" SET state='FAILED' WHERE id=$1`,[transfer.transferId]);
    assert.equal((await send(stageEvidence)).statusCode,409);
    await pool.query(`UPDATE "GrowthMediaTransfer" SET state='PENDING',"expiresAt"=now()-interval '1 second' WHERE id=$1`,[transfer.transferId]);
    assert.equal((await send(stageEvidence)).statusCode,410);
    await pool.query(`UPDATE "SocialPost" SET content='changed' WHERE id='post'`);
    assert.equal((await send({...command,observation:"access-v1"})).statusCode,409);
    assert.equal((await send(evidence)).statusCode,200);
    await pool.query(`UPDATE "OrganizationEntitlementGrant" SET value='false' WHERE key='feature.content.manage'`);
    assert.equal((await send(evidence)).statusCode,403);
    await pool.query(`UPDATE "OrganizationEntitlementGrant" SET value='true' WHERE key='feature.content.manage'`);
    await pool.query(`DELETE FROM "SocialPost" WHERE id='post'`);
    assert.equal((await send(evidence)).statusCode,409);
    await pool.query(`DELETE FROM "OrganizationMember" WHERE "orgId"='org' AND "userId"='user'`);
    assert.equal((await send(evidence)).statusCode,403);
  } finally {
    await app.close();await pool.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();

  }
});
