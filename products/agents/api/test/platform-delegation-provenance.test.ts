import { skillPackageCodec } from "../src/capabilities/skills/package";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { connectFixtureModel } from "./model-fixture";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {PlatformStore} from "../src/product/agents/store";
import {defaultBusinessConfiguration,executionGrantSchema,requestDigest} from "../src/contracts/contracts";
import {EvidenceStore,assertCurrentEvidence,assertDelegationInputEvidence,taskEvidenceManifest} from "../src/execution/context/evidence";
import {KnowledgeRuntime} from "../src/platform/knowledge/knowledge-runtime";
import {MemoryStore} from "../src/platform/memory/memory";
import {admitChildren,readChildResults} from "../src/execution/delegation/delegation";
import {beginOperation,finishOperation,loadExecution,settleTask,assertCurrentAuthority} from "../src/execution/lifecycle/execution";
import {setupPlatformSchema} from "../src/composition/setup";
import {buildPlatformApp} from "../src/composition/app";
import {loadPlatformConfig} from "../src/infrastructure/config";
import * as storageModule from "../src/infrastructure/object-store";
import {createDependencyManifest} from "../src/contracts/source-contracts";
import {publishFixtureSource} from "./knowledge-fixture";
import {dropClosedTestDatabase} from "./support/database-cleanup";
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("immutable parent brief dependencies with narrow specialist read scopes",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,evidence:EvidenceStore,memory:MemoryStore,app:Awaited<ReturnType<typeof buildPlatformApp>>;
 const database=`agents_delegation_input_${randomUUID().replaceAll("-","")}`,bodies=new Map<string,Uint8Array>();
 const objects={async put(key:string,value:Uint8Array){bodies.set(key,value);},async get(key:string){const value=bodies.get(key);if(!value)throw Error("Missing private fixture body");return value;},async delete(key:string){bodies.delete(key);}};
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);evidence=new EvidenceStore(pool,objects);memory=new MemoryStore(pool, skillPackageCodec);vi.spyOn(storageModule,"privateStoreFromEnvironment").mockReturnValue(objects);app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:target.href,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"delegation-input-private-test-only"})});});
 afterAll(async()=>{await app?.close();vi.restoreAllMocks();await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(kind:"source"|"memory",metadataOnly=false){
  const contextEvidence=metadataOnly?new EvidenceStore(pool):evidence;
  const account=await store.ensureAccount({issuer:"http://localhost:8080/realms/kasitek",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await store.createOrganization(account.id,"Brief origin"),scope={accountId:account.id,organizationId:org.id};
  await connectFixtureModel(pool,account.id,org.id);
  const source=kind==="source"?await publishFixtureSource(pool,{...scope,title:"Private guide",content:"Parent-only secret fact.",visibility:"private"},objects):undefined;
  const child=await store.createAgent({...scope,name:"Narrow specialist",configuration:defaultBusinessConfiguration()}),childVersion=await store.createVersion({...scope,agentId:child.id,expectedRevision:1});
  const configuration=defaultBusinessConfiguration();configuration.sourceRevisionIds=source?[source.id]:[];configuration.memory={enabled:kind==="memory"};configuration.tools=["agents.delegate"];configuration.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"narrow",versionId:childVersion.id,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:8000,maxActiveMs:120000}]};
  const agent=await store.createAgent({...scope,name:"Parent",configuration}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","delegation.execute",...(kind==="memory"?["memory.read","memory.propose"]:[])],sourceRevisionIds:configuration.sourceRevisionIds,maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(configuration),expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null});await store.createGrant({...scope,grant});const{task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Delegate the known fact"});
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[task.id]);
  const id=`context:${task.id}:0`;let ids:string[]=[],references:unknown[]=[],memoryScope:any,item:Awaited<ReturnType<MemoryStore["mutate"]>>|undefined;
  if(source){const op=`read:${task.id}`;await beginOperation(pool,task.id,{id:op,kind:"tool",name:"knowledge.search",request:{query:"secret"},reservedTokens:0,reservedMs:1000,retrySafe:true});const chunk=(await pool.query("SELECT id FROM agents_platform.source_chunks WHERE revision_id=$1",[source.id])).rows[0];const passage=await evidence.recordChunk(task.id,op,chunk.id);ids=[passage.reference.id];await finishOperation(pool,task.id,op,"completed",{},null,0);}
  else{const managed={...scope,agentId:agent.id},candidate=await memory.proposeManaged(managed,{operationId:randomUUID(),kind:"semantic",content:"Parent-only secret fact."});item=await memory.mutate(managed,candidate.id,{operationId:randomUUID(),expectedRevision:1,action:"accept"});memoryScope=(await pool.query("SELECT * FROM agents_platform.memory_scopes WHERE organization_id=$1 AND agent_id=$2",[org.id,agent.id])).rows[0];references=[{id:item.id,kind:"memory",revision:item.revision}];}
  const label=ids.length?(await pool.query("SELECT citation_label FROM agents_platform.evidence_references WHERE id=$1",ids)).rows[0].citation_label:"",payload={messages:[{role:"user",content:`Parent-only secret fact. [${label}]`}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,source_references,memory_scope_id,memory_generation,history_cutoff) VALUES($1,$2,0,$3,$4,$5,$6,$7,0)",[id,task.id,requestDigest(payload),payload,JSON.stringify(references),memoryScope?.id??null,memoryScope?.generation??null]);await contextEvidence.supplyContext(task.id,id,ids);
  const children=await admitChildren(pool,task.id,`delegate:${task.id}`,{requests:[{bindingId:"narrow",brief:"Use the parent-only secret fact."},{bindingId:"narrow",brief:"Another derived secret brief."}]});
  const first=children[0]!,second=children[1]!,childPayload={messages:[{role:"user",content:"Use the parent-only secret fact."}]},snapshot=`context:${first.taskId}:0`;await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,first.taskId,requestDigest(childPayload),childPayload]);await contextEvidence.supplyContext(first.taskId,snapshot,[]);await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[first.taskId]);await contextEvidence.derive(first.taskId,"child_result",first.taskId);await settleTask(pool,first.taskId,{state:"completed",output:"Derived parent-only secret fact."});
  const session=await store.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)}),headers={cookie:`agents_session=${session.token}`};
  return{account,scope,source,item,agent,child,childVersion,authority,grant,task,children,first,second,headers,async invalidate(){if(source)await source.knowledge.setPolicy(scope,source.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});else await memory.mutate({...scope,agentId:agent.id},item!.id,{operationId:randomUUID(),expectedRevision:item!.revision,action:"forget"});}};
 }
 it.each(["source","memory"] as const)("fences parent-only %s briefs at claims, joins, immutable snapshots and HTTP input/output",async kind=>{
  const f=await fixture(kind),path=`/api/organizations/${f.scope.organizationId}/tasks/${f.first.taskId}`;
  const before=await app.inject({url:path,headers:f.headers});expect(before.statusCode,before.body).toBe(200);expect(before.json().task.output).toContain("Derived parent-only");expect((await readChildResults(pool,f.task.id,[f.first])).children[0]?.state).toBe("completed");
  const execution=await loadExecution(pool,f.second.taskId);expect(execution.configuration.sourceRevisionIds).toEqual([]);expect(execution.configuration.memory.enabled).toBe(false);
  await expect(pool.query("UPDATE agents_platform.delegations SET input_manifest='{}' WHERE child_task_id=$1",[f.first.taskId])).rejects.toMatchObject({code:"23514"});
  await f.invalidate();await expect(assertCurrentAuthority(pool,await loadExecution(pool,f.second.taskId))).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});await expect(beginOperation(pool,f.second.taskId,{id:`model:${f.second.taskId}`,kind:"model",name:"model.generate",request:{},reservedTokens:100,reservedMs:1000})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});expect((await pool.query("SELECT count(*) FROM agents_platform.operations WHERE task_id=$1",[f.second.taskId])).rows[0].count).toBe("0");await expect(readChildResults(pool,f.task.id,[f.first])).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await settleTask(pool,f.second.taskId,{state:"completed",output:"Must not publish derived secret"});expect((await pool.query("SELECT state,output,error_code FROM agents_platform.tasks WHERE id=$1",[f.second.taskId])).rows[0]).toMatchObject({state:"incomplete",output:null,error_code:"EVIDENCE_UNAVAILABLE"});
  const hidden=(await app.inject({url:path,headers:f.headers})).json().task;expect(hidden).toMatchObject({input:null,output:null,inputAvailability:"unavailable",outputAvailability:"unavailable"});
  const root=(await app.inject({url:`/api/organizations/${f.scope.organizationId}/tasks/${f.task.id}`,headers:f.headers})).json();expect(root.children.find((child:any)=>child.id===f.first.taskId).output).toBeNull();
 });
 it("joins only the explicitly selected child evidence and permits only follow-up ancestry",async()=>{
  const f=await fixture("source"),firstNodes=(await pool.query("SELECT id FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='child_result'",[f.first.taskId])).rows;
  const resultOp=`result:${f.task.id}`;await beginOperation(pool,f.task.id,{id:resultOp,kind:"tool",name:"agents.result",request:{taskId:f.first.taskId},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const joined=await evidence.joinChild(f.task.id,resultOp,f.first.taskId);
  expect(firstNodes).toHaveLength(1);expect(joined.parents).toEqual(firstNodes.map(node=>node.id));
  await expect(evidence.joinChild(f.task.id,resultOp,f.second.taskId)).rejects.toMatchObject({code:"CHILD_OUTCOME_PENDING"});
  await expect(evidence.joinChild(f.task.id,resultOp,randomUUID())).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await finishOperation(pool,f.task.id,resultOp,"completed",{},null,0);
  const [next]=await admitChildren(pool,f.task.id,`followup:${f.task.id}`,{requests:[{bindingId:"narrow",brief:"Revise the first result."}]},{priorTaskId:f.first.taskId});
  expect(next).toBeDefined();const prior=(await evidence.checkHistory(next!.taskId,[f.first.taskId]))[0];expect(prior?.eligible).toBe(true);
  await expect(evidence.checkHistory(next!.taskId,[f.second.taskId])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await expect(evidence.checkHistory(next!.taskId,[f.task.id])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  const snapshot=`context:${next!.taskId}:0`,payload={historyGroupIds:[f.first.taskId],messages:[{role:"assistant",content:"Derived parent-only secret fact."}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,1)",[snapshot,next!.taskId,requestDigest(payload),payload]);
  const inherited=await evidence.inheritHistory(next!.taskId,snapshot,[f.first.taskId]);expect(inherited.manifest.dependencies.some(dependency=>dependency.kind==="delegation_input")).toBe(true);
  await evidence.supplyContext(next!.taskId,snapshot,[]);
  await f.invalidate();await expect(assertCurrentAuthority(pool,await loadExecution(pool,next!.taskId))).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });
 it("retains reviewed memory and inherited brief fences without any object storage",async()=>{
  const f=await fixture("memory",true),manifest=await taskEvidenceManifest(pool,f.first.taskId);
  expect(manifest.dependencies.some(dependency=>dependency.kind==="delegation_input")).toBe(true);
  const parentManifest=await taskEvidenceManifest(pool,f.task.id);expect(parentManifest.dependencies.some(dependency=>dependency.kind==="memory")).toBe(true);
  const metadataEvidence=new EvidenceStore(pool),operation=`memory-search:${f.task.id}`;
  await beginOperation(pool,f.task.id,{id:operation,kind:"tool",name:"memory.search",request:{query:"secret"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const passage=await metadataEvidence.recordMemory(f.task.id,operation,f.item!.id);await finishOperation(pool,f.task.id,operation,"completed",{},null,0);
  expect((await metadataEvidence.readPassage(f.task.id,passage.reference.id)).text).toBe("Parent-only secret fact.");
  const payload={messages:[{role:"user",content:`${passage.text} [${passage.label}]`}]},snapshot=`context:${f.task.id}:1`;
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,1,$3,$4,0)",[snapshot,f.task.id,requestDigest(payload),payload]);await metadataEvidence.supplyContext(f.task.id,snapshot,[passage.reference.id]);
  expect((await metadataEvidence.validateCitations(f.task.id,`Remembered [${passage.label}]`))[0]?.text).toBe(passage.text);
  expect((await pool.query("SELECT inline_content,object_key FROM agents_platform.evidence_contents WHERE reference_id=$1",[passage.reference.id])).rows[0]).toEqual({inline_content:passage.text,object_key:null});
  await expect(pool.query("UPDATE agents_platform.evidence_contents SET inline_content='tampered' WHERE reference_id=$1",[passage.reference.id])).rejects.toMatchObject({code:"23514"});
  vi.mocked(storageModule.privateStoreFromEnvironment).mockReturnValue(undefined);
  const metadataApp=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:url!,AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"metadata-only-private-test"})});
  try{
   const path=`/api/organizations/${f.scope.organizationId}/tasks/${f.first.taskId}`;
   expect((await metadataApp.inject({url:path,headers:f.headers})).json().task.output).toContain("Derived parent-only");
   await f.invalidate();await expect(metadataEvidence.readPassage(f.task.id,passage.reference.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});await expect(assertCurrentAuthority(pool,await loadExecution(pool,f.second.taskId))).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
   expect((await metadataApp.inject({url:path,headers:f.headers})).json().task).toMatchObject({input:null,output:null,inputAvailability:"unavailable",outputAvailability:"unavailable"});
  }finally{await metadataApp.close();vi.mocked(storageModule.privateStoreFromEnvironment).mockReturnValue(objects);}
 });
 it("rejects forged inherited digests, recursive references and another same-workspace actor",async()=>{
  const f=await fixture("source"),origin=await taskEvidenceManifest(pool,f.first.taskId);
  await expect(assertCurrentEvidence(pool,f.task.id,createDependencyManifest([{kind:"delegation_input",referenceId:f.first.taskId,manifestDigest:"0".repeat(64)}]))).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  await expect(assertDelegationInputEvidence(pool,f.first.taskId,undefined,[f.first.taskId])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  const account=await store.ensureAccount({issuer:f.account.issuer,subject:randomUUID(),email:"other@example.test",displayName:"Other"});await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.scope.organizationId,account.id]);
  const scope={organizationId:f.scope.organizationId,accountId:account.id},agent=await store.createAgent({...scope,name:"Other actor",configuration:defaultBusinessConfiguration()}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1}),authority={...f.authority,resourceId:agent.id,principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}},grant=executionGrantSchema.parse({...f.grant,...authority,id:randomUUID(),versionId:version.id,sourceRevisionIds:[],operations:["model.reply"]});await store.createGrant({...scope,grant});const{task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Cannot import another actor's brief"});
  await expect(assertCurrentEvidence(pool,task.id,origin)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
 });
 it("carries a child-derived memory into a later root while preserving narrow reads and revoking its original parent source",async()=>{
  const f=await fixture("source"),managed={...f.scope,agentId:f.child.id};
  const search=`search:${f.second.taskId}`;await beginOperation(pool,f.second.taskId,{id:search,kind:"tool",name:"knowledge.search",request:{query:"secret"},reservedTokens:0,reservedMs:1000,retrySafe:true});expect((await new KnowledgeRuntime(pool,evidence).search(f.second.taskId,search,"secret")).passages).toEqual([]);await finishOperation(pool,f.second.taskId,search,"completed",{},null,0);
  const candidate=await memory.proposeManaged(managed,{operationId:randomUUID(),kind:"semantic",content:"Remember the derived parent-only secret fact.",sourceTaskId:f.first.taskId}),saved=await memory.mutate(managed,candidate.id,{operationId:randomUUID(),expectedRevision:1,action:"accept"});await settleTask(pool,f.second.taskId,{state:"cancelled"});await settleTask(pool,f.task.id,{state:"completed",output:"Parent finished"});
  const configuration={...defaultBusinessConfiguration(),memory:{enabled:true}};await store.updateDraft({...f.scope,agentId:f.child.id,configuration,expectedRevision:1});const version=await store.createVersion({...f.scope,agentId:f.child.id,expectedRevision:2}),authority={...f.authority,resourceId:f.child.id},grant=executionGrantSchema.parse({...f.grant,...authority,id:randomUUID(),versionId:version.id,sourceRevisionIds:[],operations:["model.reply","memory.read","memory.propose"]});await store.createGrant({...f.scope,grant});const{task}=await store.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Continue from reviewed memory"});
  expect((await evidence.checkMemories(task.id,[saved.id]))[0]?.eligible).toBe(true);const origin=await taskEvidenceManifest(pool,f.first.taskId);expect(origin.dependencies.some(dependency=>dependency.kind==="delegation_input")).toBe(true);await f.invalidate();expect((await evidence.checkMemories(task.id,[saved.id]))[0]?.eligible).toBe(false);await expect(assertCurrentEvidence(pool,task.id,origin)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });
});
