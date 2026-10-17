import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPlatformApp } from "../src/platform/app";
import { loadPlatformConfig } from "../src/platform/config";
import { PlatformStore } from "../src/platform/store";
import { KnowledgeStore } from "../src/platform/knowledge";
import { EvidenceStore } from "../src/platform/evidence";
import { S3PrivateStore } from "../src/platform/artifacts";
import { defaultFaqConfiguration, requestDigest } from "../src/platform/contracts";
import { beginOperation } from "../src/platform/execution";
import { textDigest } from "../src/platform/source-contracts";
import { setupPlatformSchema } from "../src/platform/setup";
import { privateFixtureBucketRequest } from "./support/private-s3-fixture";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl&&process.env.AGENTS_EVIDENCE_HTTP_LIVE==="1"?describe:describe.skip)("Cited passage HTTP with actual PostgreSQL and private S3",()=>{
 const database=`agents_evidence_http_${randomUUID().replaceAll("-","")}`;
 const s3={endpoint:"http://127.0.0.1:19000",region:"us-east-1",bucket:`agents-ingestion-${randomUUID().replaceAll("-","")}`,accessKeyId:"connected-fixture-user",secretAccessKey:"connected-fixture-secret"};
 const objects=new S3PrivateStore(s3);let admin:Pool,pool:Pool,app:Awaited<ReturnType<typeof buildPlatformApp>>,platform:PlatformStore,knowledge:KnowledgeStore,evidence:EvidenceStore,createdBucket=false;
 beforeAll(async()=>{
  for(const key of Object.keys(process.env))if(key.startsWith("AGENTS_CONNECTION_")||key==="AGENTS_DOCUMENT_RUNTIME_ENABLED")vi.stubEnv(key,"");
  for(const[key,value]of Object.entries({AGENTS_S3_ENDPOINT:s3.endpoint,AGENTS_S3_REGION:s3.region,AGENTS_S3_BUCKET:s3.bucket,AGENTS_S3_ACCESS_KEY_ID:s3.accessKeyId,AGENTS_S3_SECRET_ACCESS_KEY:s3.secretAccessKey}))vi.stubEnv(key,value);
  expect((await privateFixtureBucketRequest(s3,"PUT")).ok).toBe(true);createdBucket=true;
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;
  pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);knowledge=new KnowledgeStore(pool,objects);evidence=new EvidenceStore(pool,objects);
  app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:url.href,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"offline-cited-passage-http-only"})});
 });
 afterAll(async()=>{
  await app?.close();if(createdBucket){const xml=await(await privateFixtureBucketRequest(s3,"GET","list-type=2")).text();for(const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g))await objects.delete(match[1]!);expect((await privateFixtureBucketRequest(s3,"DELETE")).ok).toBe(true);}
  await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}vi.unstubAllEnvs();
 });
 it("returns only supplied exact spans and dates, then removes withdrawn passages and denies another same-org account",async()=>{
  const account=await platform.ensureAccount({issuer:"http://localhost:8080/realms/kasitek",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const org=await platform.createOrganization(account.id,"Evidence"),scope={accountId:account.id,organizationId:org.id};
  const text="Decisive tail fact 🧪",acquiredAt="2026-10-17T10:30:00.000Z";
  const job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Guide",contentType:"text/plain",content:Buffer.from(text),parserRelease:"http-fixture-extraction-v1"});
  await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);const chunkId=randomUUID();
  await knowledge.publishExtraction(job.id,{text,acquiredAt,normalizerRelease:"text-v1",chunks:[{id:chunkId,revisionId:job.revisionId,ordinal:0,start:0,end:text.length,page:3,section:"Conclusion",text,digest:textDigest(text),tokens:10}]});
  await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
  const config={...defaultFaqConfiguration(),sourceRevisionIds:[job.revisionId]},agent=await platform.createAgent({...scope,name:"Grounded",configuration:config}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read"] as ("model.reply"|"knowledge.read")[],sourceRevisionIds:[job.revisionId],connectedToolBindingIds:[],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
  await platform.createGrant({accountId:account.id,grant});const{task}=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Find the decisive fact"});
  const operationId=`read:${task.id}`;await beginOperation(pool,task.id,{id:operationId,kind:"tool",name:"knowledge.search",request:{query:"decisive"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const passage=await evidence.recordChunk(task.id,operationId,chunkId),snapshotId=`context:${task.id}:0`,payload={content:`[${passage.label}] ${passage.text}`};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshotId,task.id,requestDigest(payload),payload]);await evidence.supplyContext(task.id,snapshotId,[passage.reference.id]);
  await pool.query("UPDATE agents_platform.tasks SET output=$2 WHERE id=$1",[task.id,`The decisive fact [${passage.label}]`]);
  const session=await platform.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)}),headers={cookie:`agents_session=${session.token}`},url=`/api/organizations/${org.id}/tasks/${task.id}/evidence`;
  const result=await app.inject({url,headers});expect(result.statusCode).toBe(200);expect(result.json()).toEqual({state:"available",passages:[{id:passage.reference.id,label:passage.label,title:"Guide",text,page:3,section:"Conclusion",contentDigest:textDigest(text),acquiredAt}]});
  expect(result.body).not.toMatch(/objectKey|object_key|manifest|operationId|raw_key/);
  const stranger=await platform.ensureAccount({issuer:account.issuer,subject:randomUUID(),email:"other@example.test",displayName:"Other"});await pool.query("INSERT INTO agents_platform.memberships(account_id,organization_id,role) VALUES($1,$2,'member')",[stranger.id,org.id]);
  const otherSession=await platform.createSession({accountId:stranger.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)});expect((await app.inject({url,headers:{cookie:`agents_session=${otherSession.token}`}})).statusCode).toBe(403);
  await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  expect((await app.inject({url,headers})).json()).toEqual({state:"unavailable",code:"EVIDENCE_UNAVAILABLE",passages:[]});
 });
});
