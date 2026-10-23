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
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20261023183000_growth_agent_source_handles/migration.sql",import.meta.url),"utf8"));
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
    const accepted=await send(command);assert.equal(accepted.statusCode,200);
    const source=accepted.json().sources[0];assert.match(source.id,/^growth-resource:[a-f0-9]{64}$/);
    assert.equal((await send({...command,control:"evidence",input:{source:{id:source.id,revision:source.revision}}})).statusCode,200);
    await pool.query('INSERT INTO "OrganizationMember" VALUES(\'org\',\'outsider\')');
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
    if(previous===undefined)delete process.env.KASITEK_BILLING_ENFORCEMENT;else process.env.KASITEK_BILLING_ENFORCEMENT=previous;
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
  const previous=process.env.KASITEK_BILLING_ENFORCEMENT;process.env.KASITEK_BILLING_ENFORCEMENT="false";
  try {
    const result=await readGrowthRecord(core,scope,{kind:"analytics_report",range,report},{range,report});
    assert.equal((JSON.parse((result.data as {text:string}).text) as {value:number}).value,42);
    assert.deepEqual(observed!.metrics,report.metrics);assert.deepEqual(observed!.breakdowns,report.breakdowns);assert.deepEqual(observed!.filters,report.filters);
    assert.equal(observed!.include_descendants,false);assert.equal(observed!.range_start,range.from);
    const unavailable={...core,config:readConfig({DATABASE_URL:"postgres://unused"})};
    await assert.rejects(readGrowthRecord(unavailable,scope,{kind:"analytics_report",range},{}),{code:"service_unavailable"});
  } finally {
    if(previous===undefined)delete process.env.KASITEK_BILLING_ENFORCEMENT;else process.env.KASITEK_BILLING_ENFORCEMENT=previous;
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
