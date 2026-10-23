import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateKeyPair,exportPKCS8,exportSPKI,SignJWT,decodeJwt } from "jose";
import pg from "pg";
import Fastify from "fastify";
import { readConfig } from "../src/config.js";
import { ApiError,installErrorHandler } from "../src/error.js";
import { enqueueGrowthAgentSetup,ensureGrowthAgentSetup,currentGrowthAgentSetup,backfillGrowthAgentSetup,retryGrowthAgentSetup,readGrowthAgentSetup,readGrowthAgentSetupMetrics } from "../src/agents/setup.js";
import { claimGrowthAgentSetups,finishGrowthAgentSetup,processGrowthAgentSetupBatch,growthAgentSetupRequest,growthAgentSetupRetryDelay } from "../src/workers/growth-agent-setup.js";
import { provisionGrowthAgents } from "../src/agents/provisioning-client.js";
import { registerGrowthAgentProvisioningRoutes } from "../src/agents/provisioning-routes.js";
import { growthAgentDigest } from "../src/agents/security.js";
const log={info(){},warn(){},error(){}};
const target={version:"1" as const,tenantId:"org",requestId:randomUUID(),defaultsRevision:"1" as const,modelProfileId:"growth-default",modelProfileRevision:"1"};
const ready={version:"1" as const,tenantId:target.tenantId,defaultsRevision:target.defaultsRevision,modelProfileId:target.modelProfileId,modelProfileRevision:target.modelProfileRevision,state:"ready" as const};

test("provisioning uses a separate service identity and rejects mismatched results, without leaking response details",async()=>{
 const keys=await generateKeyPair("RS256",{extractable:true});const privateKey=await exportPKCS8(keys.privateKey);
 const config=readConfig({DATABASE_URL:"postgres://unused",AGENTS_PRODUCT_API_URL:"http://localhost:4100",GROWTH_AGENTS_PROVISION_PRIVATE_KEY:privateKey});
 let captured:Record<string,unknown>|undefined;
 const deliver:typeof fetch=async (_url,init)=>{
  captured=decodeJwt(String((init!.headers as Record<string,string>).authorization).slice(7));
  assert.deepEqual(JSON.parse(String(init!.body)),target);
  return new Response(JSON.stringify(ready));
 };
 assert.equal((await provisionGrowthAgents(config,target,{fetch:deliver})).state,"ready");
 assert.equal(captured!.sub,"growth-provisioner");assert.equal(captured!.aud,"agents-product-provisioning");assert.equal(captured!.product,"growth");assert.equal(captured!.requestDigest,growthAgentDigest(target));
 await assert.rejects(provisionGrowthAgents(config,target,{fetch:async()=>new Response(JSON.stringify({...ready,tenantId:"foreign"}))}),{code:"AGENT_SETUP_SCOPE_INVALID"});
 await assert.rejects(provisionGrowthAgents(config,target,{fetch:async()=>new Response("private provider response",{status:401})}),{code:"AGENT_SETUP_AUTHORITY_DENIED"});
 await assert.rejects(provisionGrowthAgents(readConfig({DATABASE_URL:"postgres://unused",AGENTS_PRODUCT_API_URL:"http://localhost:4100",GROWTH_AGENTS_SIGNING_PRIVATE_KEY:privateKey}),target),{code:"AGENT_SETUP_CONFIGURATION_MISSING"});
 assert.ok(growthAgentSetupRetryDelay(99,1)<=375000);
});

test("PostgreSQL setup queue: concurrent claims, expired fencing, retries, cancellation, deletion, backfill and lifecycle authority",{skip:!process.env.CORE_ORGS_TEST_DATABASE_URL},async()=>{
 const url=process.env.CORE_ORGS_TEST_DATABASE_URL!,schema=`agent_setup_${randomUUID().replaceAll("-","")}`;
 const admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema} -c timezone=UTC`});
 try {
  await pool.query('CREATE TABLE "Organization"(id text PRIMARY KEY);INSERT INTO "Organization" VALUES(\'org\'),(\'other\')');
  await pool.query(await readFile(new URL("../../database/prisma/migrations/20261023170000_growth_agent_setup/migration.sql",import.meta.url),"utf8"));
  const keys=await generateKeyPair("RS256",{extractable:true});const publicKey=await exportSPKI(keys.publicKey);
  const core={pool,config:readConfig({DATABASE_URL:url,AGENTS_PRODUCT_ACTION_PUBLIC_KEY:publicKey})};
  await Promise.all([ensureGrowthAgentSetup(core,"org"),ensureGrowthAgentSetup(core,"org")]);
  assert.equal((await pool.query('SELECT count(*) FROM "GrowthAgentSetup"')).rows[0].count,"1");
  const claimed=await Promise.all([claimGrowthAgentSetups(core,"a"),claimGrowthAgentSetups(core,"b")]);
  const claims=claimed.flat();assert.equal(claims.length,1);const stale=claims[0]!;
  const request=growthAgentSetupRequest(stale);assert.equal(await currentGrowthAgentSetup(core,request),true);
  assert.equal(await currentGrowthAgentSetup(core,{...request,modelProfileRevision:"foreign"}),false);
  await pool.query('UPDATE "GrowthAgentSetup" SET "leaseExpiresAt"=NOW()-INTERVAL \'1 second\'');
  assert.equal(await finishGrowthAgentSetup(core,stale,"ready",null),false);
  const replacement=(await claimGrowthAgentSetups(core,"replacement"))[0]!;
  assert.deepEqual(growthAgentSetupRequest(replacement),request);
  assert.equal(await finishGrowthAgentSetup(core,stale,"ready",null),false);
  assert.equal(await finishGrowthAgentSetup(core,replacement,"ready",null),true);
  await ensureGrowthAgentSetup(core,"org");assert.equal((await readGrowthAgentSetup(pool,"org"))!.state,"ready");
  assert.equal(await retryGrowthAgentSetup(core,"org"),false);
  assert.equal(await backfillGrowthAgentSetup(core,1),1);assert.equal(await backfillGrowthAgentSetup(core,1),0);
  let deliveryAttempts=0;let firstRequest:unknown;
  await processGrowthAgentSetupBatch(core,log,{deliver:async body=>{firstRequest=body;deliveryAttempts++;throw new Error("network acknowledgement lost");}});
  assert.equal((await readGrowthAgentSetup(pool,"other"))!.state,"pending");
  await pool.query('UPDATE "GrowthAgentSetup" SET "nextAttemptAt"=NOW() WHERE "orgId"=\'other\'');
  await processGrowthAgentSetupBatch(core,log,{deliver:async body=>{assert.deepEqual(body,firstRequest);deliveryAttempts++;return {...ready,tenantId:body.tenantId};}});
  assert.equal(deliveryAttempts,2);assert.equal((await readGrowthAgentSetup(pool,"other"))!.state,"ready");
  await pool.query('UPDATE "GrowthAgentSetup" SET status=\'pending\',"nextAttemptAt"=NOW() WHERE "orgId"=\'other\'');
  await processGrowthAgentSetupBatch(core,log,{deliver:async()=>{throw new ApiError(503,"AGENT_SETUP_CONFIGURATION_MISSING","private details");}});
  assert.equal((await readGrowthAgentSetup(pool,"other"))!.state,"blocked");
  assert.equal(await retryGrowthAgentSetup(core,"other"),true);
  const retry=(await claimGrowthAgentSetups(core,"retry"))[0]!;assert.deepEqual(growthAgentSetupRequest(retry),firstRequest);
  await pool.query('UPDATE "GrowthAgentSetup" SET status=\'cancelled\',generation=generation+1 WHERE "orgId"=\'other\'');
  assert.equal(await finishGrowthAgentSetup(core,retry,"ready",null),false);assert.equal(await retryGrowthAgentSetup(core,"other"),false);
  assert.equal(await currentGrowthAgentSetup(core,growthAgentSetupRequest(retry)),false);
  assert.equal(await backfillGrowthAgentSetup(core),0);
  const measurements=await readGrowthAgentSetupMetrics(pool);
  assert.equal(measurements.find(row=>row.state==="cancelled")!.count,1);
  assert.ok(measurements.find(row=>row.state==="ready")!.averageSetupDurationSeconds!==null);
  await pool.query('INSERT INTO "Organization" VALUES(\'exhausted\')');
  await ensureGrowthAgentSetup(core,"exhausted");
  await pool.query('UPDATE "GrowthAgentSetup" SET attempts=8,status=\'running\',"leaseExpiresAt"=NOW()-INTERVAL \'1 second\' WHERE "orgId"=\'exhausted\'');
  assert.equal((await claimGrowthAgentSetups(core,"after-restart")).length,0);
  assert.equal((await readGrowthAgentSetup(pool,"exhausted"))!.state,"failed");
  await pool.query('DELETE FROM "Organization" WHERE id=\'exhausted\'');

  const app=Fastify();installErrorHandler(app);registerGrowthAgentProvisioningRoutes(app,core);
  const sign=async(body:unknown,subject="agents-provisioner",audience="growth-agent-provisioning-lifecycle",iat=Math.floor(Date.now()/1000))=>new SignJWT({requestDigest:growthAgentDigest(body)})
   .setProtectedHeader({alg:"RS256",kid:"agents-v1"}).setIssuer("https://agents.kasitek.co.za").setSubject(subject).setAudience(audience).setIssuedAt(iat).setExpirationTime(iat+60).setJti(randomUUID()).sign(keys.privateKey);
  const invoke=async(body:unknown,token?:string)=>app.inject({method:"POST",url:"/internal/agents/provisioning-check",headers:token?{authorization:`Bearer ${token}`}:{},payload:body});
  try {
   assert.equal((await invoke(request,await sign(request))).json().active,true);
   assert.equal((await invoke(request)).statusCode,401);
   assert.equal((await invoke(request,await sign(request,"agents-worker","growth-agent-actions"))).statusCode,401);
   assert.equal((await invoke({...request,tenantId:"other"},await sign(request))).statusCode,401);
   assert.equal((await invoke(request,await sign(request,"agents-provisioner","growth-agent-provisioning-lifecycle",Math.floor(Date.now()/1000)-600))).statusCode,401);
   await pool.query('DELETE FROM "Organization" WHERE id=\'org\'');
   assert.equal((await invoke(request,await sign(request))).json().active,false);
   assert.equal((await pool.query('SELECT count(*) FROM "GrowthAgentSetup" WHERE "orgId"=\'org\'')).rows[0].count,"0");
   await enqueueGrowthAgentSetup(pool,"missing",core.config);assert.equal((await pool.query('SELECT count(*) FROM "GrowthAgentSetup"')).rows[0].count,"1");
  } finally {await app.close();}
 } finally {await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
