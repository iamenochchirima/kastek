import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {setupPlatformSchema} from "../src/platform/setup";
import {PlatformStore} from "../src/platform/store";
import {defaultFaqConfiguration,executionGrantSchema} from "../src/platform/contracts";
import {beginOperation} from "../src/platform/execution";
import {MemoryStore} from "../src/platform/memory";
import {TaskArtifactStore} from "../src/platform/task-artifacts";
import {ConnectionVault} from "../src/platform/vault";
import {ConnectionStore} from "../src/platform/connections";
import {ActionService} from "../src/platform/actions";
import {AutomationService} from "../src/platform/automations";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("recursive artifact sources and narrow assigned-reviewer downloads",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,memory:MemoryStore,artifacts:TaskArtifactStore;
 const database=`agents_artifact_sources_${randomUUID().replaceAll("-","")}`,bodies=new Map<string,Uint8Array>();
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
  store=new PlatformStore(pool);memory=new MemoryStore(pool);
  artifacts=new TaskArtifactStore(pool,{async put(k,b){bodies.set(k,Buffer.from(b));},async get(k){const bytes=bodies.get(k);if(!bytes)throw Error("Missing object");return bytes;},async delete(k){bodies.delete(k);}});
 });
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();}});
 async function owner(){
  const account=await store.ensureAccount({issuer:"http://localhost/artifact-sources",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const organization=await store.createOrganization(account.id,"Artifact sources");return{account,organization,scope:{accountId:account.id,organizationId:organization.id}};
 }
 async function manual(){
  const base=await owner(),configuration=defaultFaqConfiguration();configuration.memory.enabled=true;configuration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};configuration.tools=["sandbox.analyze"];
  const agent=await store.createAgent({...base.scope,name:"Researcher",configuration}),version=await store.createVersion({...base.scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:base.organization.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:base.account.issuer,subject:base.account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","memory.read","memory.propose","sandbox.execute","artifact.read","artifact.write"],maxInputBytes:16384,maxOutputTokens:1024,expiresAt:new Date(Date.now()+60000).toISOString(),revokedAt:null});await store.createGrant({accountId:base.account.id,grant});
  const {task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Analyze my approved source"});
  const operationId=`analysis:${task.id}`;await beginOperation(pool,task.id,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{code:"analysis"},reservedTokens:0,reservedMs:240000});
  return{...base,task,agent,operationId,memoryScope:{...base.scope,agentId:agent.id}};
 }
 for(const mode of ["forget","expiry"] as const)it(`denies C derived from B derived from memory-backed A after ${mode}`,async()=>{
  const f=await manual(),candidate=await memory.proposeManaged(f.memoryScope,{operationId:randomUUID(),kind:"semantic",content:"Private selected value 42",...(mode==="expiry"?{expiresAt:new Date(Date.now()+600000).toISOString()}:{})});
  const accepted=await memory.mutate(f.memoryScope,candidate.id,{operationId:randomUUID(),expectedRevision:candidate.revision,action:"accept"}),selected=await memory.list(f.memoryScope);
  const a=await artifacts.put(f.task.id,f.operationId,{name:"A.md",contentType:"text/markdown",content:Buffer.from("Private selected value 42"),sourceReferences:[{kind:"memory_scope",id:selected.scope.id,generation:selected.generation,...(accepted.expiresAt?{expiresAt:Date.parse(accepted.expiresAt)}:{})}]});
  const b=await artifacts.put(f.task.id,f.operationId,{name:"B.md",contentType:"text/markdown",content:Buffer.from("Derived value 42"),sourceReferences:[{kind:"artifact",id:a.id}]});
  const c=await artifacts.put(f.task.id,f.operationId,{name:"C.md",contentType:"text/markdown",content:Buffer.from("Final value 42"),sourceReferences:[{kind:"artifact",id:b.id}]});
  expect(Buffer.from((await artifacts.readForTask(f.task.id,c.id)).content).toString()).toBe("Final value 42");
  expect((await artifacts.download(f.account.id,f.organization.id,f.task.id,c.id)).artifact.id).toBe(c.id);
  if(mode==="forget")await memory.mutate(f.memoryScope,accepted.id,{operationId:randomUUID(),expectedRevision:accepted.revision,action:"forget"});
  else{await pool.query("UPDATE agents_platform.memories SET expires_at=now()-interval '1 second' WHERE id=$1",[accepted.id]);await pool.query("UPDATE agents_platform.memory_scopes SET next_expiry_at=now()-interval '1 second' WHERE id=$1",[selected.scope.id]);}
  await expect(artifacts.readForTask(f.task.id,c.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await expect(artifacts.download(f.account.id,f.organization.id,f.task.id,c.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
 });
 it("permits the current assigned reviewer to download only the selected report",async()=>{
  const f=await owner(),reviewer=await store.ensureAccount({issuer:f.account.issuer,subject:randomUUID(),email:"reviewer@example.test",displayName:"Reviewer"});
  await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.organization.id,reviewer.id]);
  const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),target={id:"reports",label:"Review destination",url:"http://127.0.0.1:19100/deliveries",resource:"reports:test"};
  const connections=new ConnectionStore(pool,vault,[target]),connection=await connections.create(f.scope,{operationId:randomUUID(),name:"Reports",targetId:target.id,apiKey:"local-review-test-scoped-key"});
  const configuration=defaultFaqConfiguration();configuration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};configuration.capabilities.workflows={enabled:true,profileId:"report-delivery-v1",connectionId:connection.id,reportArtifactName:"report.md",title:"Report"};configuration.tools=["sandbox.analyze"];
  const agent=await store.createAgent({...f.scope,name:"Reporter",configuration}),version=await store.createVersion({...f.scope,agentId:agent.id,expectedRevision:1}),automations=new AutomationService(pool);
  const automation=await automations.create(f.scope,randomUUID(),{name:"Reviewed report",versionId:version.id,input:"Generate report",reviewerAccountId:reviewer.id,expiresAt:new Date(Date.now()+3600000).toISOString(),schedule:{kind:"event"}});
  const occurrence=await automations.occur(automation.id,1,"fixture",new Date()),taskId=occurrence.task_id!;
  const operationId=`analysis:${taskId}`;await beginOperation(pool,taskId,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{code:"analysis"},reservedTokens:0,reservedMs:240000});
  const input=await artifacts.put(taskId,operationId,{name:"private-input.md",contentType:"text/markdown",content:Buffer.from("Private research material")});
  const report=await artifacts.put(taskId,operationId,{name:"report.md",contentType:"text/markdown",content:Buffer.from("Exact reviewed report"),sourceReferences:[{kind:"artifact",id:input.id}]});
  await expect(artifacts.download(reviewer.id,f.organization.id,taskId,report.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  const actions=new ActionService(pool,{vault,targets:[target],artifacts});const prepared=await actions.prepare(taskId,`report:${taskId}:deliver`,{connectionId:connection.id,artifactId:report.id,title:"Report"});
  expect(prepared.reviewerAccountId).toBe(reviewer.id);
  expect(Buffer.from((await artifacts.download(reviewer.id,f.organization.id,taskId,report.id)).content).toString()).toBe("Exact reviewed report");
  await expect(artifacts.download(reviewer.id,f.organization.id,taskId,input.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.organization.id,reviewer.id]);
  await expect(artifacts.download(reviewer.id,f.organization.id,taskId,report.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  expect((await artifacts.download(f.account.id,f.organization.id,taskId,input.id)).artifact.id).toBe(input.id);
 });
});
