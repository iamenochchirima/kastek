import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { readConfig } from "../src/config.js";
import { installErrorHandler } from "../src/error.js";
import { growthAgentSocialFixture } from "./growth-agent-fixture.js";
import { growthAgentDigest } from "../src/agents/security.js";
import { growthCapabilityManifest, growthAgentPresets, growthAgentPublication, growthAgentPublicationV2, growthAgentPublicationV4, growthAgentPublicationV5, growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8, growthAgentPublicationV9, growthAgentPublicationV10 } from "../src/agents/manifest.js";
import { registerGrowthCapabilityRoutes } from "../src/agents/capability-routes.js";
import { discoverGrowthRecords, readGrowthRecord } from "../src/agents/tools.js";
import type { CoreContext } from "../src/context.js";

test("Growth owns shared capability selections without purpose-specific mandatory tool sequences",()=>{
  assert.equal(new Set(growthAgentPresets.map(p=>p.id)).size,4);
  assert(growthAgentPresets.every(p=>p.operations.includes("workspace.read")));
  assert(growthAgentPresets.find(p=>p.id==="assistant")!.operations.includes("content.posts.draft.create"));
  assert(!growthAgentPresets.find(p=>p.id==="research")!.operations.includes("content.posts.draft.create"));
  const {digest,...content}=growthCapabilityManifest;assert.equal(digest,growthAgentDigest(content));
  assert(growthCapabilityManifest.operations.every(op=>!JSON.stringify(op).includes("https://")));
});

test("real content discovery and continuation retain current tenant, actor, source and exact operation authority",{skip:!process.env.CORE_ORGS_TEST_DATABASE_URL},async()=>{
  const growthCapabilityManifest=growthAgentPublicationV5.manifest;
  const url=process.env.CORE_ORGS_TEST_DATABASE_URL!,schema="growth_caps_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema} -c timezone=UTC`});
  const app=Fastify();installErrorHandler(app);
  try {
    await pool.query(`CREATE TABLE "Organization"(id text PRIMARY KEY,name text,"reportingTimezone" text,"updatedAt" timestamp DEFAULT now());
      CREATE TABLE "User"(id text PRIMARY KEY,"emailVerified" timestamp);
      CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text DEFAULT 'OWNER');
      CREATE TABLE "OrganizationOnboardingProfile"("orgId" text,website text,industry text,"primaryGoal" text,"primaryGoals" text[]);
      INSERT INTO "Organization"(id,name) VALUES('org','Business'),('foreign-org','Foreign');
      INSERT INTO "User" VALUES('user',now()),('outsider',now());
      INSERT INTO "OrganizationMember"("orgId","userId") VALUES('org','user');`);
    await pool.query(growthAgentSocialFixture);
    await pool.query(`CREATE TABLE "WhatsappConnection"(id text,"phoneDisplayNumber" text,"phoneNumberId" text);
      CREATE TABLE "WhatsappTemplate"(id text,status text);
      CREATE TABLE "WhatsappCampaign"(id text,"orgId" text,"userId" text,"connectionId" text,"templateId" text,name text,description text,
        "templateName" text,"templateLanguage" text,"variableMappings" jsonb,"listLabel" text,"defaultBatchSize" integer,status text,
        "scheduledAt" timestamp,"launchedAt" timestamp,"completedAt" timestamp,"totalRecipients" integer,"sentCount" integer,"deliveredCount" integer,
        "readCount" integer,"failedCount" integer,"blockedCount" integer,"unsubscribedCount" integer,"createdAt" timestamp,"updatedAt" timestamp);`);
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20261023183000_growth_agent_source_handles/migration.sql",import.meta.url),"utf8"));
    await pool.query(`INSERT INTO "SocialPost"(id,"userId","orgId",title,content,channels,status,"createdAt","updatedAt") VALUES
      ('a','user','org','First',$1,'{FACEBOOK}','DRAFT',now(),now()),
      ('b','user','org','Second','Other content','{FACEBOOK}','DRAFT',now(),now()),
      ('c','foreign-user','foreign-org','Secret','Must not appear','{FACEBOOK}','DRAFT',now(),now())`,["Useful content ".repeat(1000)]);
    await pool.query(`INSERT INTO "SocialPublishJob"(id,"userId","orgId","postId","channelConnectionId",platform,status,"createdAt","updatedAt")
      VALUES('pending-job','user','org','a',NULL,'FACEBOOK','PENDING',now(),now())`);
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
    assert(!JSON.stringify(current.data).includes("selectedAccounts"));
    assert(!JSON.stringify(current.data).includes("channel_connection_id"));
    const selectedRevision=current.revision;
    await pool.query(`UPDATE "SocialPublishJob" SET status='QUEUED' WHERE id='pending-job'`);
    const changedJob=await readGrowthRecord(core,scope,context,{resourceId:"a"});assert.notEqual(changedJob.revision,selectedRevision);
    await pool.query(`UPDATE "SocialPublishJob" SET status='PENDING' WHERE id='pending-job'`);
    assert.deepEqual(await readGrowthRecord(core,scope,context,{resourceId:"a",continuation:""}),current);
    const revision=current.revision;chunks.push((current.data as {text:string}).text);
    while(current.continuation){current=await readGrowthRecord(core,scope,context,{resourceId:"a",continuation:current.continuation});chunks.push((current.data as {text:string}).text);assert.equal(current.revision,revision);}
    assert.equal((JSON.parse(chunks.join("")) as {content:string}).content,"Useful content ".repeat(1000));
    const stale=await readGrowthRecord(core,scope,context,{resourceId:"a"});
    await pool.query('UPDATE "SocialPost" SET content=\'Changed\',"updatedAt"=now() WHERE id=\'a\'');
    await assert.rejects(readGrowthRecord(core,scope,context,{continuation:stale.continuation}),{code:"agent_source_changed"});
    registerGrowthCapabilityRoutes(app,core);
    const descriptor=growthCapabilityManifest.operations.find(o=>o.operation==="content.read")!;
    const command={version:"1",requestId:randomUUID(),operationId:"read-one",taskId:randomUUID(),conversationId:randomUUID(),actor:scope.actor,
      authority:{kind:"product",originProduct:"growth",destinationProduct:"growth",originTenantId:"org",tenantId:"org",mappingRef:"growth:org",policyRevision:growthAgentPublicationV5.policy.revision,
        manifestDigest:growthCapabilityManifest.digest,descriptorDigest:growthAgentDigest(descriptor),handlerRef:descriptor.handlerRef},
      bindingId:randomUUID(),bindingDigest:"a".repeat(64),operation:"content.read",control:"invoke",input:{resourceId:"a"}};
    async function send(body:unknown){const token=await new SignJWT({product:"growth",requestDigest:growthAgentDigest(body)}).setProtectedHeader({alg:"RS256",kid:"agents-v1"})
      .setIssuer("https://agents.kasitek.co.za").setAudience("product-capability-actions").setSubject("agents-worker").setJti(randomUUID()).setIssuedAt().setExpirationTime("60s").sign(keys.privateKey);
      return app.inject({method:"POST",url:"/internal/agents/capabilities",headers:{authorization:"Bearer "+token},payload:body});}
    const accepted=await send(command);assert.equal(accepted.statusCode,200);
    for(const operation of ["content.list","campaigns.list"]) {
      const listDescriptor=growthCapabilityManifest.operations.find(value=>value.operation===operation)!;
      const list={...command,operation,input:{limit:1},authority:{...command.authority,descriptorDigest:growthAgentDigest(listDescriptor),handlerRef:listDescriptor.handlerRef}};
      const unfiltered=await send(list);assert.equal(unfiltered.statusCode,200);
      const emptyStatus=await send({...list,input:{limit:1,status:"",search:"",cursor:""}});assert.equal(emptyStatus.statusCode,200);
      assert.deepEqual(emptyStatus.json().value,unfiltered.json().value);
      for(const status of [" ","draft","DRAFT;DROP"])
        assert.equal((await send({...list,input:{status}})).statusCode,400);
      assert.equal((await send({...list,input:{status:null}})).statusCode,422);
      assert.equal((await send({...list,input:{status:"",cursor:"invalid-cursor"}})).statusCode,400);
      assert.equal((await send({...list,actor:{...scope.actor,subject:"outsider"},input:{status:""}})).statusCode,403);
    }
    const emptyStatusFirst=await discoverGrowthRecords(core,scope,"content_post",{limit:1,status:""});
    assert.deepEqual(emptyStatusFirst,await discoverGrowthRecords(core,scope,"content_post",{limit:1}));
    assert.deepEqual(await discoverGrowthRecords(core,scope,"content_post",{limit:1,status:"",cursor:first.nextCursor}),second);
    const workspaceDescriptor=growthCapabilityManifest.operations.find(operation=>operation.operation==="workspace.read")!;
    const workspace={...command,operation:"workspace.read",input:{},authority:{...command.authority,
      descriptorDigest:growthAgentDigest(workspaceDescriptor),handlerRef:workspaceDescriptor.handlerRef}};
    const firstWorkspace=await send(workspace);assert.equal(firstWorkspace.statusCode,200);
    const emptyWorkspace=await send({...workspace,input:{continuation:""}});assert.equal(emptyWorkspace.statusCode,200);
    assert.deepEqual(emptyWorkspace.json().value,firstWorkspace.json().value);
    assert.equal(emptyWorkspace.json().sources[0].id,firstWorkspace.json().sources[0].id);
    for(const continuation of [" ","invalid-cursor"])
      assert.equal((await send({...workspace,input:{continuation}})).statusCode,400);
    assert.equal((await send({...workspace,input:{continuation:null}})).statusCode,422);
    const foreignCursor=Buffer.from(JSON.stringify({scope:growthAgentDigest({tenantId:"foreign-org",actor:scope.actor,context:{kind:"workspace",resourceId:"org"}}),revision:firstWorkspace.json().value.revision,offset:1})).toString("base64url");
    assert.equal((await send({...workspace,input:{continuation:foreignCursor}})).statusCode,409);
    assert.equal((await send({...workspace,actor:{...scope.actor,subject:"outsider"},input:{continuation:""}})).statusCode,403);
    const legacyDescriptor=growthAgentPublicationV2.manifest.operations.find(operation=>operation.operation==="content.read")!;
    const legacy={...command,authority:{...command.authority,policyRevision:"2",manifestDigest:growthAgentPublicationV2.manifest.digest,descriptorDigest:growthAgentDigest(legacyDescriptor)}};
    assert.equal((await send(legacy)).statusCode,200);
    const retainedV4Descriptor=growthAgentPublicationV4.manifest.operations.find(operation=>operation.operation==="content.read")!;
    const retainedV4={...command,authority:{...command.authority,policyRevision:"4",manifestDigest:growthAgentPublicationV4.manifest.digest,descriptorDigest:growthAgentDigest(retainedV4Descriptor)}};
    assert.equal((await send(retainedV4)).statusCode,200);
    for(const publication of [growthAgentPublicationV6,growthAgentPublicationV7,growthAgentPublicationV8,growthAgentPublicationV9,growthAgentPublicationV10,growthAgentPublication]){
      const installed=publication.manifest.operations.find(operation=>operation.operation==="workspace.read")!;
      const canonical={...command,operation:installed.operation,control:"authorize",input:{},authority:{...command.authority,
        policyRevision:publication.policy.revision,manifestDigest:publication.manifest.digest,
        descriptorDigest:growthAgentDigest(installed),handlerRef:installed.handlerRef}};
      const allowed=await send(canonical);
      assert.equal(allowed.statusCode,200,`canonical publication ${publication.policy.revision}: ${allowed.body}`);
      assert.equal(allowed.json().value.authorized,true);
      assert.equal((await send({...canonical,authority:{...canonical.authority,descriptorDigest:"0".repeat(64)}})).statusCode,403);
    }
    assert.equal((await send({...retainedV4,authority:{...retainedV4.authority,manifestDigest:growthCapabilityManifest.digest}})).statusCode,403);
    assert.equal((await send({...legacy,authority:{...legacy.authority,manifestDigest:growthCapabilityManifest.digest}})).statusCode,403);
    const source=accepted.json().sources[0];assert.match(source.id,/^growth-resource:[a-f0-9]{64}$/);
    assert.equal((await send({...command,control:"evidence",input:{source:{id:source.id,revision:source.revision}}})).statusCode,200);
    await pool.query('INSERT INTO "OrganizationMember"("orgId","userId") VALUES(\'org\',\'outsider\')');
    assert.equal((await send({...command,actor:{...scope.actor,subject:"outsider"},control:"evidence",input:{source:{id:source.id,revision:source.revision}}})).statusCode,403);
    await pool.query('UPDATE "SocialPost" SET content=\'New source revision\',"updatedAt"=now() WHERE id=\'a\'');
    assert.equal((await send({...command,control:"evidence",input:{source:{id:source.id,revision:source.revision}}})).statusCode,409);
    assert.equal((await send({...command,input:{resourceId:"c"}})).statusCode,404);
    assert.equal((await send({...command,authority:{...command.authority,destinationProduct:"agency"}})).statusCode,403);
    assert.equal((await send({...command,authority:{...command.authority,descriptorDigest:"0".repeat(64)}})).statusCode,403);
    assert.equal((await send({...command,input:{resourceId:"a",url:"https://attacker.test"}})).statusCode,422);
    await pool.query('DELETE FROM "OrganizationMember" WHERE "userId"=\'user\'');
    assert.equal((await send(command)).statusCode,403);
  } finally {

    await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
});

test("analytics tools send explicit bounded selections to the scoped reporting gateway and keep unavailable gateways honest",async()=>{
  const {createServer}=await import("node:http"),{generateKeyPairSync}=await import("node:crypto");
  const keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  let observed:Record<string,unknown>|undefined;
  const server=createServer((request,response)=>{
    const chunks:Buffer[]=[];request.on("data",chunk=>chunks.push(chunk));request.on("end",()=>{
      response.setHeader("content-type","application/json");
      if(request.url!.startsWith("/internal/reporting/scopes/resolve"))response.end(JSON.stringify({scope_id:17,root_scope_id:17,scope_kind:"core_organization",owning_source_service:"core",external_source_id:"org",parent_scope_id:null,reporting_timezone:"UTC"}));
      else {observed=JSON.parse(Buffer.concat(chunks).toString("utf8"));response.end(JSON.stringify({scope_id:17,metrics:[],value:42}));}
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert(address&&typeof address==="object");
  const config=readConfig({DATABASE_URL:"postgres://unused",ANALYTICS_REPORTING_URL:`http://127.0.0.1:${address.port}`,ANALYTICS_REPORTING_RESOLVER_TOKEN:"fixture-resolver",
    ANALYTICS_REPORTING_PRIVATE_KEY:keys.privateKey.export({type:"pkcs8",format:"pem"}).toString()});
  const core={config,pool:{query:async(sql:string)=>{if(sql.includes('FROM "OrganizationMember"'))return {rows:[{name:"Business"}]};throw Error("Unexpected query");}}} as unknown as CoreContext;
  const scope={tenantId:"org",actor:{issuer:"https://growth.kasitek.co.za/identity",subject:"user"}};
  const report={metrics:["campaign.recipients.sent"],breakdowns:["channel"],filters:{channel:["whatsapp"]}};
  const range={from:"2030-01-01T00:00:00Z",to:"2030-02-01T00:00:00Z",timezone:"UTC"};
  try {
    const result=await readGrowthRecord(core,scope,{kind:"analytics_report",range,report},{range,report});
    assert.equal((JSON.parse((result.data as {text:string}).text) as {value:number}).value,42);
    assert.deepEqual(observed!.metrics,report.metrics);assert.deepEqual(observed!.breakdowns,report.breakdowns);assert.deepEqual(observed!.filters,report.filters);
    assert.equal(observed!.include_descendants,false);assert.equal(observed!.range_start,range.from);
    const unavailable={...core,config:readConfig({DATABASE_URL:"postgres://unused"})};
    await assert.rejects(readGrowthRecord(unavailable,scope,{kind:"analytics_report",range},{}),{code:"service_unavailable"});
  } finally {

    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
