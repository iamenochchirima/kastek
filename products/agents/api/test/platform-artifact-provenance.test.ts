import { skillPackageCodec } from "../src/capabilities/skills/package";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {PlatformStore} from "../src/product/agents/store";
import {defaultBusinessConfiguration,executionGrantSchema,requestDigest} from "../src/contracts/contracts";
import {beginOperation,finishOperation,settleTask} from "../src/execution/lifecycle/execution";
import {continueWorkInTransaction} from "../src/execution/lifecycle/work-continuation";
import {transaction} from "../src/infrastructure/database";
import {assertCurrentEvidence,taskEvidenceManifest} from "../src/execution/context/evidence";
import {EvidenceStore} from "../src/execution/context/evidence";
import {publishFixtureSource} from "./knowledge-fixture";
import {readHistory,searchHistory} from "../src/execution/context/journal";
import {validateBuiltinArguments,validateBuiltinResult} from "../src/capabilities/tool-contracts";
import {MemoryStore} from "../src/platform/memory/memory";
import {TaskArtifactStore} from "../src/execution/artifacts/task-artifacts";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ConnectionStore} from "../src/product/connections/connections";
import {ActionService} from "../src/workflows/report-delivery/actions";
import {AutomationService} from "../src/product/automations/automations";
import {orchestrationTools} from "../src/contracts/orchestration";
import {admitChildren} from "../src/execution/delegation/delegation";
import {followupSpecialist,startSpecialist} from "../src/execution/delegation/adaptive";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("recursive artifact sources and narrow assigned-reviewer downloads",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,memory:MemoryStore,artifacts:TaskArtifactStore;
 const database=`agents_artifact_sources_${randomUUID().replaceAll("-","")}`,bodies=new Map<string,Uint8Array>();
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
  store=new PlatformStore(pool);memory=new MemoryStore(pool, skillPackageCodec);
  artifacts=new TaskArtifactStore(pool,{async put(k,b){bodies.set(k,Buffer.from(b));},async get(k){const bytes=bodies.get(k);if(!bytes)throw Error("Missing object");return bytes;},async delete(k){bodies.delete(k);}});
 });
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function owner(){
  const account=await store.ensureAccount({issuer:"http://localhost/artifact-sources",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const organization=await store.createOrganization(account.id,"Artifact sources");await connectFixtureModel(pool,account.id,organization.id);return{account,organization,scope:{accountId:account.id,organizationId:organization.id}};
 }
 async function manual(withSource=false,withSecondSource=false){
  const base=await owner(),configuration=defaultBusinessConfiguration();
  const source=withSource?await publishFixtureSource(pool,{...base.scope,title:"Later source",content:"A separate revocable detail.",visibility:"private"}):undefined;
  const secondSource=withSecondSource?await publishFixtureSource(pool,{...base.scope,title:"Independent source",content:"A retained independent detail.",visibility:"private"}):undefined;
  configuration.memory.enabled=true;configuration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};configuration.tools=["sandbox.analyze",...(source?["knowledge.read" as const]:[])];configuration.sourceRevisionIds=[...(source?[source.id]:[]),...(secondSource?[secondSource.id]:[])];
  const agent=await store.createAgent({...base.scope,name:"Researcher",configuration}),version=await store.createVersion({...base.scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:base.organization.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:base.account.issuer,subject:base.account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","memory.read","memory.propose","sandbox.execute","artifact.read","artifact.write"],sourceRevisionIds:configuration.sourceRevisionIds,maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),expiresAt:new Date(Date.now()+60000).toISOString(),revokedAt:null});await store.createGrant({accountId:base.account.id,grant});
  const {task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Analyze my approved source"});
  const operationId=`analysis:${task.id}`;await beginOperation(pool,task.id,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{code:"analysis"},reservedTokens:0,reservedMs:240000});
  return{...base,task,agent,version,configuration,source,secondSource,authority,grant,operationId,memoryScope:{...base.scope,agentId:agent.id}};
 }
 it("hands only explicitly selected artifacts to a specialist before dispatch",async()=>{
  const f=await owner(),source=await publishFixtureSource(pool,{...f.scope,title:"Launch source",content:"Confirmed launch is Tuesday.",visibility:"private"});
  const specialistConfig=defaultBusinessConfiguration();specialistConfig.sourceRevisionIds=[source.id];specialistConfig.tools=["knowledge.read"];
  const specialist=await store.createAgent({...f.scope,name:"Research",configuration:specialistConfig});
  const specialistVersion=await store.createVersion({...f.scope,agentId:specialist.id,expectedRevision:1});
  const producerConfig=defaultBusinessConfiguration();producerConfig.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};producerConfig.tools=["sandbox.analyze"];
  const producer=await store.createAgent({...f.scope,name:"Producer",configuration:producerConfig});
  const producerVersion=await store.createVersion({...f.scope,agentId:producer.id,expectedRevision:1});
  const configuration=defaultBusinessConfiguration();configuration.program={id:"tool-directed",version:"4"};
  configuration.sourceRevisionIds=[source.id];configuration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};
  configuration.tools=["knowledge.read","sandbox.analyze",...orchestrationTools];
  configuration.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"research",versionId:specialistVersion.id,tools:["knowledge.read"],sourceRevisionIds:[source.id],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null},{id:"producer",versionId:producerVersion.id,tools:["sandbox.analyze"],sourceRevisionIds:[],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null}]};
  const agent=await store.createAgent({...f.scope,name:"Coordinator",configuration}),version=await store.createVersion({...f.scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:f.organization.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:f.account.issuer,subject:f.account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","delegation.execute","sandbox.execute","artifact.read","artifact.write"],sourceRevisionIds:[source.id],maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null});
  await store.createGrant({accountId:f.account.id,grant});
  const {task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Review the report"});
  const evidence=new EvidenceStore(pool,source.storage),sourceOp={id:`artifact-source:${task.id}`,kind:"tool" as const,name:"knowledge.read",request:{},reservedTokens:0,reservedMs:1000};
  const read=await beginOperation(pool,task.id,sourceOp);if(read.waiting)throw Error("Unexpected capacity wait");
  const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[source.id])).rows[0],passage=await evidence.recordChunk(task.id,sourceOp.id,chunk.id);
  await finishOperation(pool,task.id,sourceOp.id,"completed",{},null,0,read.operation.attempt_id);
  const snapshot=`artifact-handoff:${task.id}`,payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,task.id,requestDigest(payload),payload]);
  await evidence.supplyContext(task.id,snapshot,[passage.reference.id]);
  const analysis=`artifact-create:${task.id}`;await beginOperation(pool,task.id,{id:analysis,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});
  const content="x".repeat(5000)+" Final exact wording.",selected=await artifacts.put(task.id,analysis,{name:"plan.md",contentType:"text/markdown",content:Buffer.from(content)});
  const privateArtifact=await artifacts.put(task.id,analysis,{name:"private.md",contentType:"text/markdown",content:Buffer.from("Not selected")});
  await finishOperation(pool,task.id,analysis,"completed",{},null,0);
  const operation={id:`artifact-start:${task.id}`,kind:"delegation" as const,name:"agents.start",request:{},reservedTokens:0,reservedMs:1000};
  await beginOperation(pool,task.id,operation);
  const request={requests:[{bindingId:"research",brief:"Review the plan",artifactIds:[selected.id]},{bindingId:"research",brief:"Review independently"}]};
  const children=(await startSpecialist(pool,task.id,operation.id,request,evidence,artifacts)).children;
  expect((await startSpecialist(pool,task.id,operation.id,request,evidence,artifacts)).children.map(child=>child.taskId)).toEqual(children.map(child=>child.taskId));
  const child=children[0]!,sibling=children[1]!,row=(await pool.query("SELECT input,grant_id FROM agents_platform.tasks WHERE id=$1",[child.taskId])).rows[0];
  expect(row.input).toContain(selected.id);expect(row.input).toContain(child.taskId);expect(row.input).not.toContain("Final exact wording");
  expect((await pool.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[row.grant_id])).rows[0].operations).toContain("artifact.read");
  expect((await pool.query("SELECT artifact_id,target_task_id FROM agents_platform.task_artifact_transfers WHERE target_task_id=ANY($1::uuid[])",[[child.taskId,sibling.taskId]])).rows).toEqual([{artifact_id:selected.id,target_task_id:child.taskId}]);
  const reader=(id:string,origin:string,artifactId:string)=>artifacts.readRetainedForTask(id,origin,artifactId);
  const first=await readHistory(pool,child.taskId,{taskId:child.taskId,artifactId:selected.id},artifacts.evidence!,`artifact-read:${child.taskId}`,reader);
  expect(first.nextOffset).not.toBeNull();
  const last=await readHistory(pool,child.taskId,{taskId:child.taskId,artifactId:selected.id,offset:first.nextOffset},artifacts.evidence!,`artifact-read:${child.taskId}`,reader);
  expect(first.content+last.content).toBe(content);
  await expect(artifacts.readForTask(child.taskId,privateArtifact.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await expect(artifacts.readForTask(sibling.taskId,selected.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[child.taskId]);
  await settleTask(pool,child.taskId,{state:"completed",output:"Reviewed"});
  const followupId=`artifact-followup:${task.id}`;await beginOperation(pool,task.id,{...operation,id:followupId,name:"agents.followup"});
  const followup=(await followupSpecialist(pool,task.id,followupId,{taskId:child.taskId,brief:"Check the report again",artifactIds:[selected.id]},evidence,artifacts)).children[0]!;
  expect(followup.conversationId).toBe(child.conversationId);
  expect(Buffer.from((await artifacts.readForTask(followup.taskId,selected.id)).content).toString()).toBe(content);
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[sibling.taskId]);
  await settleTask(pool,sibling.taskId,{state:"completed",output:"Independent review"});
  const producerOp=`artifact-producer:${task.id}`;await beginOperation(pool,task.id,{...operation,id:producerOp});
  const producing=(await startSpecialist(pool,task.id,producerOp,{requests:[{bindingId:"producer",brief:"Prepare the draft"}]},evidence,artifacts)).children[0]!;
  const childAnalysis=`artifact-child-create:${producing.taskId}`;await beginOperation(pool,producing.taskId,{id:childAnalysis,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});
  const childArtifact=await artifacts.put(producing.taskId,childAnalysis,{name:"draft.md",contentType:"text/markdown",content:Buffer.from("Specialist-produced draft")});
  await finishOperation(pool,producing.taskId,childAnalysis,"completed",{},null,0);
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[producing.taskId]);
  await settleTask(pool,producing.taskId,{state:"completed",output:"Draft prepared"});
  const reviewOp=`artifact-review:${task.id}`;await beginOperation(pool,task.id,{...operation,id:reviewOp});
  const reviewer=(await startSpecialist(pool,task.id,reviewOp,{requests:[{bindingId:"research",brief:"Review the draft",artifactIds:[childArtifact.id]}]},evidence,artifacts)).children[0]!;
  expect(Buffer.from((await artifacts.readForTask(reviewer.taskId,childArtifact.id)).content).toString()).toBe("Specialist-produced draft");
  await source.knowledge.setPolicy(f.scope,source.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  await expect(artifacts.readForTask(followup.taskId,selected.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await expect(artifacts.readForTask(reviewer.taskId,childArtifact.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 },30000);
 it("hands an exact retained artifact to a later specialist without opening another conversation",async()=>{
  const f=await owner(),source=await publishFixtureSource(pool,{...f.scope,title:"Earlier source",content:"The verified launch is Tuesday.",visibility:"private"}),leafConfig=defaultBusinessConfiguration();
  leafConfig.sourceRevisionIds=[source.id];leafConfig.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};leafConfig.tools=["knowledge.read","sandbox.analyze"];
  const leaf=await store.createAgent({...f.scope,name:"Analyst",configuration:leafConfig});
  const leafVersion=await store.createVersion({...f.scope,agentId:leaf.id,expectedRevision:1});
  const specialistConfig=defaultBusinessConfiguration();specialistConfig.program={id:"tool-directed",version:"4"};specialistConfig.sourceRevisionIds=[source.id];specialistConfig.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};specialistConfig.tools=["knowledge.read","sandbox.analyze",...orchestrationTools];
  specialistConfig.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"analyst",versionId:leafVersion.id,tools:["knowledge.read","sandbox.analyze"],sourceRevisionIds:[source.id],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null}]};
  const specialist=await store.createAgent({...f.scope,name:"Research",configuration:specialistConfig});
  const specialistVersion=await store.createVersion({...f.scope,agentId:specialist.id,expectedRevision:1});
  const configuration=defaultBusinessConfiguration();configuration.program={id:"tool-directed",version:"4"};
  configuration.sourceRevisionIds=[source.id];configuration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};configuration.tools=["knowledge.read","sandbox.analyze",...orchestrationTools];
  configuration.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"research",versionId:specialistVersion.id,tools:["knowledge.read","sandbox.analyze"],sourceRevisionIds:[source.id],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null}]};
  const agent=await store.createAgent({...f.scope,name:"Coordinator",configuration}),version=await store.createVersion({...f.scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:f.organization.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:f.account.issuer,subject:f.account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","delegation.execute","sandbox.execute","artifact.read","artifact.write"],sourceRevisionIds:[source.id],maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null});
  await store.createGrant({accountId:f.account.id,grant});
  const prior=(await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Prepare a report"})).task;
  const sourceEvidence=new EvidenceStore(pool,source.storage),sourceOp=`retained-source:${prior.id}`;
  const sourceRead=await beginOperation(pool,prior.id,{id:sourceOp,kind:"tool",name:"knowledge.read",request:{},reservedTokens:0,reservedMs:1000});if(sourceRead.waiting)throw Error("Unexpected capacity wait");
  const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[source.id])).rows[0],passage=await sourceEvidence.recordChunk(prior.id,sourceOp,chunk.id);
  await finishOperation(pool,prior.id,sourceOp,"completed",{},null,0,sourceRead.operation.attempt_id);
  const snapshot=`retained-artifact-context:${prior.id}`,payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,prior.id,requestDigest(payload),payload]);
  await sourceEvidence.supplyContext(prior.id,snapshot,[passage.reference.id]);
  const analysis=`earlier-artifact:${prior.id}`;await beginOperation(pool,prior.id,{id:analysis,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});
  const content=`Older approved report [${passage.label}]. `+"x".repeat(5000),artifact=await artifacts.put(prior.id,analysis,{name:"earlier.md",contentType:"text/markdown",content:Buffer.from(content)});
  await finishOperation(pool,prior.id,analysis,"completed",{},null,0);
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[prior.id]);
  await settleTask(pool,prior.id,{state:"completed",output:"Report prepared"});
  const next=(await store.admitTask({authority,grantId:grant.id,versionId:version.id,conversationId:prior.conversation_id,requestKey:randomUUID(),input:"Get a second opinion on the report"})).task;
  const searchId=`retained-search:${next.id}`;await beginOperation(pool,next.id,{id:searchId,kind:"tool",name:"history.search",request:{part:"artifacts"},reservedTokens:0,reservedMs:1000});
  const search=await searchHistory(pool,next.id,{part:"artifacts"},artifacts.evidence!,searchId);
  expect(search.results).toEqual(expect.arrayContaining([expect.objectContaining({taskId:prior.id,artifactId:artifact.id,metadataOnly:true})]));
  await finishOperation(pool,next.id,searchId,"completed",search,null,0);
  const op={id:`retained-delegation:${next.id}`,kind:"delegation" as const,name:"agents.start",request:{},reservedTokens:0,reservedMs:1000};
  await beginOperation(pool,next.id,op);
  const request={requests:[{bindingId:"research",brief:"Review the report",artifactReferences:[{taskId:prior.id,artifactId:artifact.id}]}]};
  const child=(await startSpecialist(pool,next.id,op.id,request,artifacts.evidence,artifacts)).children[0]!;
  expect((await startSpecialist(pool,next.id,op.id,request,artifacts.evidence,artifacts)).children[0]!.taskId).toBe(child.taskId);
  expect(child.taskId).not.toBe(prior.id);expect(child.conversationId).not.toBe(prior.conversation_id);
  const reader=(id:string,origin:string,artifactId:string)=>artifacts.readRetainedForTask(id,origin,artifactId);
  const first=await readHistory(pool,child.taskId,{taskId:child.taskId,artifactId:artifact.id},artifacts.evidence!,`retained-read:${child.taskId}`,reader);
  const last=await readHistory(pool,child.taskId,{taskId:child.taskId,artifactId:artifact.id,offset:first.nextOffset},artifacts.evidence!,`retained-read:${child.taskId}`,reader);
  expect(first.content+last.content).toBe(content);
  expect((await sourceEvidence.validateCitations(child.taskId,`Finding [${passage.label}]`)).map(value=>value.text)).toEqual([passage.text]);
  await expect(sourceEvidence.readPassage(child.taskId,passage.reference.id)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  expect((await taskEvidenceManifest(pool,child.taskId)).dependencies).toContainEqual(expect.objectContaining({kind:"artifact",referenceId:artifact.id,contentDigest:artifact.contentDigest}));
  const nestedId=`retained-nested:${child.taskId}`;await beginOperation(pool,child.taskId,{id:nestedId,kind:"delegation",name:"agents.start",request:{},reservedTokens:0,reservedMs:1000});
  const nested=(await startSpecialist(pool,child.taskId,nestedId,{requests:[{bindingId:"analyst",brief:"Check the report",artifactReferences:[{taskId:child.taskId,artifactId:artifact.id}]}]},artifacts.evidence,artifacts)).children[0]!;
  expect(Buffer.from((await artifacts.readForTask(nested.taskId,artifact.id)).content).toString()).toBe(content);
  expect((await sourceEvidence.validateCitations(nested.taskId,`Finding [${passage.label}]`)).map(value=>value.text)).toEqual([passage.text]);
  const derivedId=`retained-derived:${nested.taskId}`;await beginOperation(pool,nested.taskId,{id:derivedId,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});
  const derivedText=`Derived report [${passage.label}]`,derived=await artifacts.put(nested.taskId,derivedId,{name:"derived.md",contentType:"text/markdown",content:Buffer.from(derivedText),sourceReferences:[{kind:"artifact",id:artifact.id}]});
  expect(Buffer.from((await artifacts.readForTask(nested.taskId,derived.id)).content).toString()).toBe(derivedText);
  await finishOperation(pool,nested.taskId,derivedId,"completed",{},null,0);
  await finishOperation(pool,child.taskId,nestedId,"completed",{},null,0);
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[nested.taskId]);
  await settleTask(pool,nested.taskId,{state:"completed",output:"Checked"});
  const wrongConversation=(await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Another conversation"})).task;
  await expect(startSpecialist(pool,wrongConversation.id,`foreign-artifact:${wrongConversation.id}`,request,artifacts.evidence,artifacts)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await expect(startSpecialist(pool,next.id,`old-contract:${next.id}`,{requests:[{bindingId:"research",brief:"Review",artifactIds:[artifact.id]}]},artifacts.evidence,artifacts)).rejects.toMatchObject({code:"ARTIFACT_HANDOFF_UNAVAILABLE"});
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[child.taskId]);
  await settleTask(pool,child.taskId,{state:"completed",output:"Reviewed"});
  const followupId=`retained-followup:${next.id}`;await beginOperation(pool,next.id,{...op,id:followupId,name:"agents.followup"});
  const followup=(await followupSpecialist(pool,next.id,followupId,{taskId:child.taskId,brief:"Check again",artifactReferences:[{taskId:prior.id,artifactId:artifact.id}]},artifacts.evidence,artifacts)).children[0]!;
  expect(followup.conversationId).toBe(child.conversationId);
  expect(Buffer.from((await artifacts.readForTask(followup.taskId,artifact.id)).content).toString()).toBe(content);
  await pool.query("UPDATE agents_platform.artifacts SET state='deleted' WHERE id=$1",[artifact.id]);
  await expect(assertCurrentEvidence(pool,followup.taskId,await taskEvidenceManifest(pool,followup.taskId),{requireActiveTask:false})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await expect(assertCurrentEvidence(pool,nested.taskId,await taskEvidenceManifest(pool,nested.taskId),{requireActiveTask:false})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 },30000);
 for(const mode of ["forget","expiry"] as const)it(`denies C derived from B derived from memory-backed A after ${mode}`,async()=>{
  const f=await manual(),candidate=await memory.proposeManaged(f.memoryScope,{operationId:randomUUID(),kind:"semantic",content:"Private selected value 42",...(mode==="expiry"?{expiresAt:new Date(Date.now()+600000).toISOString()}:{})});
  const accepted=await memory.mutate(f.memoryScope,candidate.id,{operationId:randomUUID(),expectedRevision:candidate.revision,action:"accept"}),selected=await memory.list(f.memoryScope);
  const a=await artifacts.put(f.task.id,f.operationId,{name:"A.md",contentType:"text/markdown",content:Buffer.from("Private selected value 42"),sourceReferences:[{kind:"memory_scope",id:selected.scope.id,generation:selected.generation,...(accepted.expiresAt?{expiresAt:Date.parse(accepted.expiresAt)}:{})}]});
  const b=await artifacts.put(f.task.id,f.operationId,{name:"B.md",contentType:"text/markdown",content:Buffer.from("Derived value 42"),sourceReferences:[{kind:"artifact",id:a.id}]});
  let c=await artifacts.put(f.task.id,f.operationId,{name:"C.md",contentType:"text/markdown",content:Buffer.from("Final value 42"),sourceReferences:[{kind:"artifact",id:b.id}]});
  if(mode==="forget"){
   await finishOperation(pool,f.task.id,f.operationId,"completed",{},null,0);
   for(let index=0;index<65;index++){
    const operationId=`retained:${index}:${f.task.id}`;
    await beginOperation(pool,f.task.id,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{index},reservedTokens:0,reservedMs:1000});
    c=await artifacts.put(f.task.id,operationId,{name:`retained-${index}.md`,contentType:"text/markdown",content:Buffer.from("Final value 42"),sourceReferences:[{kind:"artifact",id:c.id}]});
    await finishOperation(pool,f.task.id,operationId,"completed",{},null,0);
   }
  }
  expect(Buffer.from((await artifacts.readForTask(f.task.id,c.id)).content).toString()).toBe("Final value 42");
  expect((await new TaskArtifactStore(pool).inspectForTask(f.task.id,c.id)).id).toBe(c.id);
  expect((await artifacts.download(f.account.id,f.organization.id,f.task.id,c.id)).artifact.id).toBe(c.id);
  let recoveredTaskId:string|undefined,derivedId:string|undefined;
  if(mode==="forget"){
   await settleTask(pool,f.task.id,{state:"incomplete",errorCode:"ORCHESTRATION_STALLED",output:"Analysis retained"});
   const continued=await transaction(pool,db=>continueWorkInTransaction(db,store,{priorTaskId:f.task.id,authority:f.authority,grantId:f.grant.id,requestKey:randomUUID()}));
   expect(continued.task.root_task_id).not.toBe(f.task.root_task_id);
   await expect(artifacts.readForTask(continued.task.id,a.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
   expect(Buffer.from((await artifacts.readRetainedForTask(continued.task.id,f.task.id,a.id)).content).toString()).toBe("Private selected value 42");
   expect((await artifacts.readForTask(continued.task.id,a.id)).artifact.id).toBe(a.id);
   const operationId=`derive-recovered:${continued.task.id}`;
   await beginOperation(pool,continued.task.id,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});
   const derived=await artifacts.put(continued.task.id,operationId,{name:"recovered.md",contentType:"text/markdown",content:Buffer.from("Derived from retained source"),sourceReferences:[{kind:"artifact",id:a.id}]});
   await finishOperation(pool,continued.task.id,operationId,"completed",{},null,0);
   expect((await artifacts.readForTask(continued.task.id,derived.id)).artifact.id).toBe(derived.id);
   await settleTask(pool,continued.task.id,{state:"completed",output:"Recovered analysis"});
   const next=await store.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.version.id,conversationId:f.task.conversation_id,requestKey:randomUUID(),input:"Reopen that analysis"});
   expect(Buffer.from((await artifacts.readRetainedForTask(next.task.id,f.task.id,a.id)).content).toString()).toBe("Private selected value 42");
   recoveredTaskId=next.task.id;derivedId=derived.id;
   const unrelated=await store.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.version.id,requestKey:randomUUID(),input:"Unrelated private conversation"});
   await expect(artifacts.readRetainedForTask(unrelated.task.id,f.task.id,a.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  }
  if(mode==="forget")await memory.mutate(f.memoryScope,accepted.id,{operationId:randomUUID(),expectedRevision:accepted.revision,action:"forget"});
  else{await pool.query("UPDATE agents_platform.memories SET expires_at=now()-interval '1 second' WHERE id=$1",[accepted.id]);await pool.query("UPDATE agents_platform.memory_scopes SET next_expiry_at=now()-interval '1 second' WHERE id=$1",[selected.scope.id]);}
  await expect(artifacts.readForTask(f.task.id,c.id)).rejects.toMatchObject({code:mode==="forget"?"TASK_SETTLED":"ARTIFACT_NOT_FOUND"});
  await expect(new TaskArtifactStore(pool).inspectForTask(f.task.id,c.id)).rejects.toMatchObject({code:mode==="forget"?"TASK_SETTLED":"ARTIFACT_NOT_FOUND"});
  await expect(artifacts.download(f.account.id,f.organization.id,f.task.id,c.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  if(recoveredTaskId){
   await expect(artifacts.readRetainedForTask(recoveredTaskId,f.task.id,a.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
   await expect(assertCurrentEvidence(pool,recoveredTaskId,await taskEvidenceManifest(pool,recoveredTaskId))).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
   await expect(artifacts.download(f.account.id,f.organization.id,(await pool.query("SELECT task_id FROM agents_platform.artifacts WHERE id=$1",[derivedId])).rows[0].task_id,derivedId!)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  }
 },60000);
 it("recovers an exact earlier artifact while unrelated withdrawn history remains unavailable",async()=>{
  const f=await manual(true,true),evidence=new EvidenceStore(pool,f.source!.storage),citations=[];
  for(let index=0;index<2;index++){
   const id=`earlier-source:${index}:${f.task.id}`,operation=await beginOperation(pool,f.task.id,{id,kind:"tool",name:"knowledge.read",request:{},reservedTokens:0,reservedMs:1000});
   if(operation.waiting)throw Error("Unexpected wait");
   const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[f.secondSource!.id])).rows[0];
   const passage=await evidence.recordChunk(f.task.id,id,chunk.id);citations.push(passage);
   await finishOperation(pool,f.task.id,id,"completed",{},null,0,operation.operation.attempt_id);
  }
  const before=`context:${f.task.id}:0`,firstPayload={messages:[{role:"user",content:citations.map(passage=>`${passage.text} [${passage.label}]`).join("\n")}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[before,f.task.id,requestDigest(firstPayload),firstPayload]);
  await evidence.supplyContext(f.task.id,before,citations.map(passage=>passage.reference.id));
  const original="\uFEFF"+"Report without the later source. 🦉\n".repeat(240)+`Only the selected citation [${citations[0]!.label}]`;
  const safe=await artifacts.put(f.task.id,f.operationId,{name:"safe.md",contentType:"text/markdown",content:Buffer.from(original)});
  // Accepted retained fixtures share the exact published bytes and frozen source graph.
  const archived=(await pool.query(`WITH source AS (
    SELECT a.*,n.evidence_ids,n.parents,n.manifest,n.request_digest AS node_digest FROM agents_platform.artifacts a
    JOIN agents_platform.evidence_nodes n ON n.task_id=a.task_id AND n.kind='artifact' AND n.owner_id=a.id::text WHERE a.id=$1
  ), generated AS (
    SELECT source.*,gen_random_uuid() AS artifact_id,gen_random_uuid() AS node_id,series FROM source CROSS JOIN generate_series(1,100) series
  ), published AS (
    INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,operation_id,request_digest,object_key,content_type,bytes,content_digest,state,task_id,root_task_id,name,source_references,created_at)
    SELECT artifact_id,organization_id,agent_id,account_id,operation_id||':archive:'||series,request_digest,object_key||':archive:'||series,content_type,bytes,content_digest,state,task_id,root_task_id,'archive-'||series||'.md',
      jsonb_build_array(jsonb_build_object('kind','evidence','id',node_id,'digest',manifest->>'digest')),created_at+series*interval '1 microsecond' FROM generated RETURNING id,object_key,created_at
  ), nodes AS (
    INSERT INTO agents_platform.evidence_nodes(id,organization_id,root_task_id,task_id,kind,owner_id,evidence_ids,parents,manifest,request_digest)
    SELECT node_id,organization_id,root_task_id,task_id,'artifact',artifact_id::text,evidence_ids,parents,manifest,node_digest FROM generated JOIN published ON published.id=generated.artifact_id RETURNING owner_id
  ) SELECT published.* FROM published JOIN nodes ON nodes.owner_id=published.id::text ORDER BY published.created_at,published.id`,[safe.id])).rows;
  for(const artifact of archived)bodies.set(artifact.object_key,Buffer.from(original));
  const read={id:`later-source:${f.task.id}`,kind:"tool" as const,name:"knowledge.read",request:{},reservedTokens:0,reservedMs:1000};
  const admitted=await beginOperation(pool,f.task.id,read);if(admitted.waiting)throw Error("Unexpected wait");
  const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[f.source!.id])).rows[0],passage=await evidence.recordChunk(f.task.id,read.id,chunk.id);
  await finishOperation(pool,f.task.id,read.id,"completed",{},null,0,admitted.operation.attempt_id);
  const snapshot=`context:${f.task.id}:1`,payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,1,$3,$4,0)",[snapshot,f.task.id,requestDigest(payload),payload]);
  await evidence.supplyContext(f.task.id,snapshot,[passage.reference.id]);
  const withdrawn=await artifacts.put(f.task.id,f.operationId,{name:"withdrawn.md",contentType:"text/markdown",content:Buffer.from("Report using the separate detail.")});
  await finishOperation(pool,f.task.id,f.operationId,"completed",{},null,0);await settleTask(pool,f.task.id,{state:"completed",output:"Reports created"});
  await f.source!.knowledge.setPolicy(f.scope,f.source!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  const configuration={...f.configuration,sourceRevisionIds:[f.secondSource!.id],tools:["sandbox.analyze" as const,"knowledge.read" as const]};
  await store.updateDraft({...f.scope,agentId:f.agent.id,configuration,expectedRevision:1});const version=await store.createVersion({...f.scope,agentId:f.agent.id,expectedRevision:2});
  const grant=executionGrantSchema.parse({...f.grant,id:randomUUID(),versionId:version.id,sourceRevisionIds:configuration.sourceRevisionIds});await store.createGrant({accountId:f.account.id,grant});
  const next=await store.admitTask({authority:f.authority,grantId:grant.id,versionId:version.id,conversationId:f.task.conversation_id,configurationMode:"current",requestKey:randomUUID(),input:"Reopen the earlier report"});
  expect((await evidence.checkHistory(next.task.id,[f.task.id]))[0]?.eligible).toBe(false);
  expect((await artifacts.listForRoot(f.task.id)).map(artifact=>artifact.id)).not.toContain(archived.at(-1)!.id);
  const discovered=[];let beforeArtifactId:string|undefined;
  do{
   const input={part:"artifacts",limit:20,...(beforeArtifactId?{beforeArtifactId}:{})},operationId=`discover:${discovered.length}:${next.task.id}`;
   expect(()=>validateBuiltinArguments("history.search",input,"1")).toThrow("capability contract");
   await beginOperation(pool,next.task.id,{id:operationId,kind:"tool",name:"history.search",request:input,reservedTokens:0,reservedMs:1000});
   const page=await searchHistory(pool,next.task.id,input,evidence,operationId);validateBuiltinResult("history.search",page,"2");
   expect(page.results.every(result=>result.metadataOnly===true&&result.complete===false)).toBe(true);
   discovered.push(...page.results);beforeArtifactId="nextBeforeArtifactId" in page?page.nextBeforeArtifactId??undefined:undefined;
   await finishOperation(pool,next.task.id,operationId,"completed",page,null,0);
  }while(beforeArtifactId);
  expect(new Set(discovered.map(result=>result.artifactId)).size).toBe(101);
  expect(discovered.at(-1)?.artifactId).toBe(safe.id);
  expect(discovered.some(result=>result.artifactId===withdrawn.id)).toBe(false);
  await expect(evidence.validateCitations(next.task.id,original)).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
  await expect(artifacts.readForTask(next.task.id,safe.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  const searchInput={part:"artifacts",query:"safe",since:safe.createdAt.toISOString(),before:new Date(safe.createdAt.getTime()+1000).toISOString()},searchId=`discover:query:${next.task.id}`;
  await beginOperation(pool,next.task.id,{id:searchId,kind:"tool",name:"history.search",request:searchInput,reservedTokens:0,reservedMs:1000});
  const matching=await searchHistory(pool,next.task.id,searchInput,evidence,searchId);
  expect(matching.results.map(result=>result.artifactId)).toEqual([safe.id]);
  await finishOperation(pool,next.task.id,searchId,"completed",matching,null,0);
  const reader=(taskId:string,originTaskId:string,artifactId:string)=>artifacts.readRetainedForTask(taskId,originTaskId,artifactId);
  const handle=discovered.find(result=>result.artifactId===safe.id)!;
  let offset=0,full="",pages=0;
  while(true){
   const input={taskId:handle.taskId,artifactId:handle.artifactId,offset},operationId=`history:artifact:${pages++}:${next.task.id}`;
   const admitted=await beginOperation(pool,next.task.id,{id:operationId,kind:"tool",name:"history.read",request:input,reservedTokens:0,reservedMs:1000});if(admitted.waiting)throw Error("Unexpected wait");
   const page=await readHistory(pool,next.task.id,input,evidence,operationId,reader);validateBuiltinResult("history.read",page,"2");
   expect(page).toMatchObject({artifactId:safe.id,encoding:"utf8",digest:createHash("sha256").update(Buffer.from(original)).digest("hex"),totalBytes:Buffer.byteLength(original)});
   expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(4096);full+=page.content;
   await finishOperation(pool,next.task.id,operationId,"completed",page,null,0,admitted.operation.attempt_id);
   if(page.nextOffset===null)break;offset=page.nextOffset;
  }
  expect(pages).toBeGreaterThan(1);expect(Buffer.from(full)).toEqual(Buffer.from(original));
  expect((await evidence.validateCitations(next.task.id,full)).map(passage=>passage.reference.id)).toEqual([citations[0]!.reference.id]);
  await expect(evidence.validateCitations(next.task.id,`Unselected [${citations[1]!.label}]`)).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
  await expect(evidence.readPassage(next.task.id,citations[0]!.reference.id)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  expect((await pool.query("SELECT evidence_ids FROM agents_platform.evidence_nodes WHERE task_id=$1",[next.task.id])).rows.flatMap(row=>row.evidence_ids)).not.toContain(citations[0]!.reference.id);
  const deriveId=`derive-cited:${next.task.id}`,derivedText=`Derived report [${citations[0]!.label}]`;
  await beginOperation(pool,next.task.id,{id:deriveId,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});
  const derived=await artifacts.put(next.task.id,deriveId,{name:"derived-cited.md",contentType:"text/markdown",content:Buffer.from(derivedText),sourceReferences:[{kind:"artifact",id:safe.id}]});
  await finishOperation(pool,next.task.id,deriveId,"completed",{},null,0);
  expect((await evidence.validateReport(next.task.id,derived.id,derivedText)).map(passage=>passage.reference.id)).toEqual([citations[0]!.reference.id]);
  const unrelated=await store.admitTask({authority:f.authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Another conversation"});
  const foreignSearchId=`discover:foreign:${unrelated.task.id}`;
  await beginOperation(pool,unrelated.task.id,{id:foreignSearchId,kind:"tool",name:"history.search",request:{part:"artifacts"},reservedTokens:0,reservedMs:1000});
  expect((await searchHistory(pool,unrelated.task.id,{part:"artifacts"},evidence,foreignSearchId)).results).toEqual([]);
  await expect(searchHistory(pool,unrelated.task.id,{part:"artifacts",beforeArtifactId:safe.id},evidence,foreignSearchId)).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
  await finishOperation(pool,unrelated.task.id,foreignSearchId,"completed",{},null,0);
  await expect(readHistory(pool,unrelated.task.id,{taskId:f.task.id,artifactId:safe.id},evidence,"foreign:artifact",reader)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await expect(artifacts.readRetainedForTask(next.task.id,f.task.id,withdrawn.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await expect(evidence.validateCitations(unrelated.task.id,full)).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
  await f.secondSource!.knowledge.setPolicy(f.scope,f.secondSource!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  await expect(evidence.validateCitations(next.task.id,full)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await expect(artifacts.download(f.account.id,f.organization.id,next.task.id,derived.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 },30000);
 it("permits the current assigned reviewer to download only the selected report",async()=>{
  const f=await owner(),reviewer=await store.ensureAccount({issuer:f.account.issuer,subject:randomUUID(),email:"reviewer@example.test",displayName:"Reviewer"});
  await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.organization.id,reviewer.id]);
  const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),target={id:"reports",label:"Review destination",url:"http://127.0.0.1:19100/deliveries",resource:"reports:test"};
  const connections=new ConnectionStore(pool,vault,[target]),connection=await connections.create(f.scope,{operationId:randomUUID(),name:"Reports",targetId:target.id,apiKey:"local-review-test-scoped-key"});
  const specialistConfiguration=defaultBusinessConfiguration();specialistConfiguration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};specialistConfiguration.tools=["sandbox.analyze"];
  const specialist=await store.createAgent({...f.scope,name:"Analyst",configuration:specialistConfiguration}),specialistVersion=await store.createVersion({...f.scope,agentId:specialist.id,expectedRevision:1});
  const configuration=defaultBusinessConfiguration();configuration.program={id:"tool-directed",version:"4"};configuration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};configuration.capabilities.workflows={enabled:true,profileId:"report-delivery-v1",connectionId:connection.id,reportArtifactName:"report.md",title:"Report"};configuration.tools=["sandbox.analyze",...orchestrationTools];
  configuration.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:null,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"analyst",versionId:specialistVersion.id,tools:["sandbox.analyze"],sourceRevisionIds:[],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null}]};
  const agent=await store.createAgent({...f.scope,name:"Reporter",configuration}),version=await store.createVersion({...f.scope,agentId:agent.id,expectedRevision:1}),automations=new AutomationService(pool);
  const automation=await automations.create(f.scope,randomUUID(),{name:"Reviewed report",versionId:version.id,input:"Generate report",reviewerAccountId:reviewer.id,expiresAt:new Date(Date.now()+3600000).toISOString(),schedule:{kind:"event"}});
  const occurrence=await automations.occur(automation.id,1,"fixture",new Date()),taskId=occurrence.task_id!;
  const operationId=`analysis:${taskId}`;await beginOperation(pool,taskId,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{code:"analysis"},reservedTokens:0,reservedMs:240000});
  const input=await artifacts.put(taskId,operationId,{name:"private-input.md",contentType:"text/markdown",content:Buffer.from("Private research material")});
  await pool.query(`INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,operation_id,request_digest,object_key,content_type,bytes,content_digest,state,task_id,root_task_id,name,source_references,created_at)
    SELECT gen_random_uuid(),organization_id,agent_id,account_id,operation_id||':decoy:'||series,request_digest,object_key||':decoy:'||series,content_type,bytes,content_digest,state,task_id,root_task_id,'decoy-'||series||'.md',source_references,created_at-interval '1 hour'
    FROM agents_platform.artifacts CROSS JOIN generate_series(1,100) series WHERE id=$1`,[input.id]);
  const report=await artifacts.put(taskId,operationId,{name:"report.md",contentType:"text/markdown",content:Buffer.from("Exact reviewed report"),sourceReferences:[{kind:"artifact",id:input.id}]});
  await finishOperation(pool,taskId,operationId,"completed",{},null,0);
  expect((await artifacts.listForRoot(taskId)).map(artifact=>artifact.id)).not.toContain(report.id);
  expect(await artifacts.prepareReport(taskId,"report.md","Unused generated text")).toEqual({id:report.id});
  const currentSearchId=`discover:current:${taskId}`,currentSearch={part:"artifacts",query:"report",since:report.createdAt.toISOString()};
  await beginOperation(pool,taskId,{id:currentSearchId,kind:"tool",name:"history.search",request:currentSearch,reservedTokens:0,reservedMs:1000});
  const current=await searchHistory(pool,taskId,currentSearch,artifacts.evidence!,currentSearchId);validateBuiltinResult("history.search",current,"2");
  expect(current.results).toEqual([expect.objectContaining({taskId,artifactId:report.id,metadataOnly:true})]);
  await finishOperation(pool,taskId,currentSearchId,"completed",current,null,0);
  const currentReadId=`read:current:${taskId}`;
  await beginOperation(pool,taskId,{id:currentReadId,kind:"tool",name:"history.read",request:{taskId,artifactId:report.id},reservedTokens:0,reservedMs:1000});
  const currentPage=await readHistory(pool,taskId,{taskId,artifactId:report.id},artifacts.evidence!,currentReadId,(taskId,originTaskId,artifactId)=>artifacts.readRetainedForTask(taskId,originTaskId,artifactId));
  expect(currentPage.content).toBe("Exact reviewed report");validateBuiltinResult("history.read",currentPage,"2");
  await finishOperation(pool,taskId,currentReadId,"completed",currentPage,null,0);
  const children=await admitChildren(pool,taskId,"reports:children",{requests:[{bindingId:"analyst",brief:"Prepare a focused report."},{bindingId:"analyst",brief:"Prepare an independent report."}]},{adaptive:true});
  const childReports=[];
  for(const child of children){
   const operationId=`analysis:${child.taskId}`,operation=await beginOperation(pool,child.taskId,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});if(operation.waiting)throw Error("Unexpected wait");
   childReports.push(await artifacts.put(child.taskId,operationId,{name:"child-report.md",contentType:"text/markdown",content:Buffer.from(`Report for ${child.taskId}`)}));
   await finishOperation(pool,child.taskId,operationId,"completed",{},null,0);
  }
  const child=children[0]!,sibling=children[1]!,childReport=childReports[0]!,siblingReport=childReports[1]!;
  expect(await artifacts.prepareReport(child.taskId,"child-report.md","Unused generated text")).toEqual({id:childReport.id});
  await expect(artifacts.readForTask(child.taskId,siblingReport.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await expect(artifacts.prepareReport(taskId,"child-report.md","Unused generated text")).rejects.toMatchObject({code:"REPORT_ARTIFACT_AMBIGUOUS"});
  const siblingOperationId=`sibling-only:${sibling.taskId}`,siblingOperation=await beginOperation(pool,sibling.taskId,{id:siblingOperationId,kind:"resource",name:"sandbox.analyze",request:{},reservedTokens:0,reservedMs:1000});if(siblingOperation.waiting)throw Error("Unexpected wait");
  const siblingOnly=await artifacts.put(sibling.taskId,siblingOperationId,{name:"sibling-only.md",contentType:"text/markdown",content:Buffer.from("Sibling-only report")});
  await finishOperation(pool,sibling.taskId,siblingOperationId,"completed",{},null,0);
  await expect(artifacts.prepareReport(child.taskId,"sibling-only.md","Unused generated text")).rejects.toMatchObject({code:"REPORT_ARTIFACT_MISSING"});
  await artifacts.transfer(taskId,child.taskId,siblingOnly.id);
  expect((await artifacts.readForTask(child.taskId,siblingOnly.id)).artifact.id).toBe(siblingOnly.id);
  await expect(artifacts.prepareReport(child.taskId,"sibling-only.md","Unused generated text")).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  await expect(artifacts.download(reviewer.id,f.organization.id,taskId,report.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  const actions=new ActionService(pool,{vault,targets:[target],artifacts});const prepared=await actions.prepare(taskId,`report:${taskId}:deliver`,{connectionId:connection.id,artifactId:report.id,title:"Report"});
  await expect(actions.prepare(child.taskId,`report:${child.taskId}:deliver`,{connectionId:connection.id,artifactId:childReport.id,title:"Report"})).rejects.toMatchObject({code:"ACTION_SCOPE_DENIED"});
  expect(prepared.reviewerAccountId).toBe(reviewer.id);
  expect(Buffer.from((await artifacts.download(reviewer.id,f.organization.id,taskId,report.id)).content).toString()).toBe("Exact reviewed report");
  await expect(artifacts.download(reviewer.id,f.organization.id,taskId,input.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.organization.id,reviewer.id]);
  await expect(artifacts.download(reviewer.id,f.organization.id,taskId,report.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  expect((await artifacts.download(f.account.id,f.organization.id,taskId,input.id)).artifact.id).toBe(input.id);
 });
});
