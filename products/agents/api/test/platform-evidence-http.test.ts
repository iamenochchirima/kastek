import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPlatformApp } from "../src/platform/app";
import { loadPlatformConfig } from "../src/platform/config";
import { PlatformStore } from "../src/platform/store";
import { KnowledgeStore } from "../src/platform/knowledge";
import { EvidenceStore } from "../src/platform/evidence";
import { S3PrivateStore } from "../src/platform/artifacts";
import { defaultFaqConfiguration, requestDigest } from "../src/platform/contracts";
import { admitChildren } from "../src/platform/delegation";
import { beginOperation } from "../src/platform/execution";
import { textDigest } from "../src/platform/source-contracts";
import { AutomationService } from "../src/platform/automations";
import { actionsFromEnvironment } from "../src/platform/actions";
import { TaskArtifactStore } from "../src/platform/task-artifacts";
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
  const childAgent=await platform.createAgent({...scope,name:"Specialist",configuration:{...defaultFaqConfiguration(),sourceRevisionIds:[job.revisionId]}}),childVersion=await platform.createVersion({...scope,agentId:childAgent.id,expectedRevision:1});
  const config={...defaultFaqConfiguration(),sourceRevisionIds:[job.revisionId],tools:["agents.delegate"],capabilities:{...defaultFaqConfiguration().capabilities,delegation:{enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"child",versionId:childVersion.id,sourceRevisionIds:[job.revisionId],connectedToolBindingIds:[],tools:[],maxTokens:8000,maxActiveMs:120000}]}}},agent=await platform.createAgent({...scope,name:"Grounded",configuration:config}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","delegation.execute"] as ("model.reply"|"knowledge.read"|"delegation.execute")[],sourceRevisionIds:[job.revisionId],connectedToolBindingIds:[],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
  await platform.createGrant({accountId:account.id,grant});const{task}=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Find the decisive fact"});
  const operationId=`read:${task.id}`;await beginOperation(pool,task.id,{id:operationId,kind:"tool",name:"knowledge.search",request:{query:"decisive"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const passage=await evidence.recordChunk(task.id,operationId,chunkId),snapshotId=`context:${task.id}:0`,payload={content:`[${passage.label}] ${passage.text}`};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshotId,task.id,requestDigest(payload),payload]);await evidence.supplyContext(task.id,snapshotId,[passage.reference.id]);
  await pool.query("UPDATE agents_platform.tasks SET output=$2 WHERE id=$1",[task.id,`${text} [${passage.label}]`]);
  const child=(await admitChildren(pool,task.id,`delegation:${task.id}`,{requests:[{bindingId:"child",brief:"decisive"}]}))[0]!;
  const childOperation=`child-read:${child.taskId}`;await beginOperation(pool,child.taskId,{id:childOperation,kind:"tool",name:"knowledge.search",request:{query:"decisive"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const childPassage=await evidence.recordChunk(child.taskId,childOperation,chunkId),childPayload={content:`[${childPassage.label}] ${childPassage.text}`},childSnapshot=`context:${child.taskId}:0`;
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[childSnapshot,child.taskId,requestDigest(childPayload),childPayload]);await evidence.supplyContext(child.taskId,childSnapshot,[childPassage.reference.id]);
  await pool.query("UPDATE agents_platform.tasks SET output=$2 WHERE id=$1",[child.taskId,`CHILD_PRIVATE_DERIVED ${text} [${childPassage.label}]`]);
  const session=await platform.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)}),headers={cookie:`agents_session=${session.token}`},url=`/api/organizations/${org.id}/tasks/${task.id}/evidence`;
  const result=await app.inject({url,headers});expect(result.statusCode).toBe(200);expect(result.json()).toEqual({state:"available",passages:[{id:passage.reference.id,label:passage.label,title:"Guide",text,page:3,section:"Conclusion",contentDigest:textDigest(text),acquiredAt}]});
  expect(result.body).not.toMatch(/objectKey|object_key|manifest|operationId|raw_key/);
  const stranger=await platform.ensureAccount({issuer:account.issuer,subject:randomUUID(),email:"other@example.test",displayName:"Other"});await pool.query("INSERT INTO agents_platform.memberships(account_id,organization_id,role) VALUES($1,$2,'member')",[stranger.id,org.id]);
  const otherSession=await platform.createSession({accountId:stranger.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)});expect((await app.inject({url,headers:{cookie:`agents_session=${otherSession.token}`}})).statusCode).toBe(403);
  const before=await app.inject({url:url.replace("/evidence",""),headers});expect(before.statusCode).toBe(200);expect(before.json().task.output).toContain(text);expect(before.json().children[0].output).toContain("CHILD_PRIVATE_DERIVED");
  await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  expect((await app.inject({url,headers})).json()).toEqual({state:"unavailable",code:"EVIDENCE_UNAVAILABLE",passages:[]});
  const after=await app.inject({url:url.replace("/evidence",""),headers});expect(after.statusCode).toBe(200);expect(after.json().task.output).toBeNull();expect(after.json().task.outputAvailability).toBe("unavailable");expect(after.json().children[0].output).toBeNull();expect(after.json().children[0].outputAvailability).toBe("unavailable");expect(after.body).not.toContain(text);expect(after.body).not.toContain("CHILD_PRIVATE_DERIVED");
  const history=await app.inject({url:`/api/organizations/${org.id}/conversations/${task.conversation_id}`,headers});expect(history.statusCode).toBe(200);expect(history.json().tasks[0].output).toBeNull();expect(history.body).not.toContain(text);

 });
 it("gives a designated automation reviewer only the exact prepared report and denies arbitrary child reads",async()=>{
  vi.stubEnv("AGENTS_CONNECTION_ACTIVE_KEY","v1");vi.stubEnv("AGENTS_CONNECTION_KEYS",JSON.stringify({v1:randomBytes(32).toString("base64")}));
  vi.stubEnv("AGENTS_REPORT_DELIVERY_TARGETS",JSON.stringify([{id:"reports",label:"Reports",url:"http://127.0.0.1:19099/deliveries",resource:"reports:privacy"}]));
  const artifactStore=new TaskArtifactStore(pool,objects),services=actionsFromEnvironment(pool,artifactStore)!;
  const owner=await platform.ensureAccount({issuer:"http://localhost:8080/realms/kasitek",subject:randomUUID(),email:"owner-review@example.test",displayName:"Owner"}),reviewer=await platform.ensureAccount({issuer:owner.issuer,subject:randomUUID(),email:"reviewer@example.test",displayName:"Reviewer"});
  const org=await platform.createOrganization(owner.id,"Review privacy"),scope={accountId:owner.id,organizationId:org.id};await pool.query("INSERT INTO agents_platform.memberships(account_id,organization_id,role) VALUES($1,$2,'member')",[reviewer.id,org.id]);
  const childAgent=await platform.createAgent({...scope,name:"Private specialist",configuration:defaultFaqConfiguration()}),childVersion=await platform.createVersion({...scope,agentId:childAgent.id,expectedRevision:1});
  const connection=await services.connections.create(scope,{operationId:randomUUID(),name:"Reports",targetId:"reports",apiKey:"explicit-fixture-only-never-sent"});
  const configuration={...defaultFaqConfiguration(),instructions:"OWNER_PRIVATE_INSTRUCTIONS",tools:["agents.delegate"],capabilities:{...defaultFaqConfiguration().capabilities,workflows:{enabled:true,profileId:"report-delivery-v1",connectionId:connection.id,reportArtifactName:"report.md"},delegation:{enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"child",versionId:childVersion.id,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:8000,maxActiveMs:120000}]}}};
  const agent=await platform.createAgent({...scope,name:"Reporter",configuration}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1}),automations=new AutomationService(pool);
  const automation=await automations.create(scope,randomUUID(),{name:"Private automated research",versionId:version.id,reviewerAccountId:reviewer.id,input:"OWNER_SECRET_ROOT_INPUT",expiresAt:new Date(Date.now()+86400000).toISOString(),maxOccurrencesPerDay:1,schedule:{kind:"interval",anchor:new Date(Date.now()-60000).toISOString(),everySeconds:60}});
  const occurrence=await automations.occur(automation.id,1,"review-privacy",new Date()),taskId=occurrence.task_id;
  const child=(await admitChildren(pool,taskId,`delegate:${taskId}`,{requests:[{bindingId:"child",brief:"OWNER_SECRET_CHILD_BRIEF"}]}))[0]!;
  await pool.query("UPDATE agents_platform.tasks SET output='UNCITED_PRIVATE_CHILD_OUTPUT',state='completed' WHERE id=$1",[child.taskId]);
  const operationId=`report-prepare:${taskId}`;await beginOperation(pool,taskId,{id:operationId,kind:"tool",name:"report.prepare",request:{},reservedTokens:0,reservedMs:30000,retrySafe:true});
  const artifact=await artifactStore.put(taskId,operationId,{name:"report.md",contentType:"text/markdown",content:Buffer.from("Approved prepared summary.")}),action=await services.actions.prepare(taskId,`report:${taskId}:deliver`,{connectionId:connection.id,artifactId:artifact.id});
  await pool.query("UPDATE agents_platform.tasks SET output='OWNER_UNPREPARED_ROOT_OUTPUT',state='waiting_review' WHERE id=$1",[taskId]);
  await pool.query("INSERT INTO agents_platform.task_events(task_id,event_key,kind,payload) VALUES($1,'privacy-marker','private-event',$2)",[taskId,{value:"OWNER_PRIVATE_EVENT"}]);
  const session=await platform.createSession({accountId:reviewer.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)}),headers={cookie:`agents_session=${session.token}`};
  const configUrl=new URL(databaseUrl!);configUrl.pathname=`/${database}`;const reviewApp=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:configUrl.href,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"offline-review-privacy-test"})});
  try{
   const response=await reviewApp.inject({url:`/api/organizations/${org.id}/tasks/${taskId}`,headers});expect(response.statusCode).toBe(200);const data=response.json();
   expect(data.task).toEqual({id:taskId,state:"waiting_review",output:null,errorCode:null});expect(data.canControl).toBe(false);expect(data.actions[0].id).toBe(action.id);expect(data.actions[0].preview.content).toBe("Approved prepared summary.");expect(data.artifacts.map((item:any)=>item.id)).toEqual([artifact.id]);
   for(const key of ["events","operations","children","resources"])expect(data[key]).toEqual([]);
   for(const marker of ["OWNER_SECRET_ROOT_INPUT","OWNER_PRIVATE_INSTRUCTIONS","OWNER_UNPREPARED_ROOT_OUTPUT","OWNER_SECRET_CHILD_BRIEF","UNCITED_PRIVATE_CHILD_OUTPUT","OWNER_PRIVATE_EVENT"])expect(response.body).not.toContain(marker);
   for(const suffix of [`${child.taskId}`,`${child.taskId}/evidence`,`${taskId}/evidence`])expect((await reviewApp.inject({url:`/api/organizations/${org.id}/tasks/${suffix}`,headers})).statusCode).toBe(404);
   const report=await reviewApp.inject({url:`/api/organizations/${org.id}/tasks/${taskId}/artifacts/${artifact.id}`,headers});expect(report.statusCode).toBe(200);expect(report.body).toBe("Approved prepared summary.");
  }finally{await reviewApp.close();}
 });
});
