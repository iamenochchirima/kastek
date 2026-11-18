import { skillPackageCodec } from "../src/capabilities/skills/package";
import { contextGrantCeiling } from "../src/execution/models/settings";
import {connectFixtureModel} from "./model-fixture";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import * as compositionCompiler from "../src/execution/lifecycle/validated-composition";
import {EvidenceStore,citationLabels,assertCurrentEvidence} from "../src/execution/context/evidence";
import {PlatformStore} from "../src/product/agents/store";
import {KnowledgeStore} from "../src/platform/knowledge/knowledge";
import {defaultBusinessConfiguration,requestDigest} from "../src/contracts/contracts";
import {beginOperation,finishOperation,settleTask} from "../src/execution/lifecycle/execution";
import {setupPlatformSchema} from "../src/composition/setup";
import {ConnectionStore} from "../src/product/connections/connections";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ConnectedCatalogStore} from "../src/capabilities/connected-tools/connected-catalog-store";
import {createCatalog,digestToolSchema,ExecutableAdapterRegistry} from "../src/contracts/capability-catalog";
import {TaskArtifactStore} from "../src/execution/artifacts/task-artifacts";
import {ActionService} from "../src/workflows/report-delivery/actions";
import {createReportReceiver,initializeReportReceiver} from "../src/acceptance/report-receiver";
import {ArtifactStore} from "../src/execution/artifacts/artifacts";
import {MemoryStore} from "../src/execution/memory/memory";
import {textDigest} from "../src/contracts/source-contracts";

it("parses only the explicit citation convention, preserving first occurrence",()=>{
 expect(citationLabels("[E2] [draft] [E1] [E2] [E0] [E10000] [e3]")).toEqual(["E2","E1","E0","E10000"]);
});
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("server-issued evidence with real PostgreSQL",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,knowledge:KnowledgeStore,evidence:EvidenceStore,taskArtifacts:TaskArtifactStore,reportConnections:ConnectionStore,actions:ActionService,receiver:ReturnType<typeof createReportReceiver>;
 let loseDelivery=false;const reportKey="fixture_evidence_report_key",vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")});
 let target:{id:string;label:string;resource:string;url:string};
 const database=`agents_evidence_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>();
 beforeAll(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
  const scoped=new URL(url!);scoped.pathname=`/${database}`;pool=new Pool({connectionString:scoped.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
  const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("missing fixture object");return value;},async delete(key:string){objects.delete(key);}};
  knowledge=new KnowledgeStore(pool,storage);evidence=new EvidenceStore(pool,storage);taskArtifacts=new TaskArtifactStore(pool,storage);
  await initializeReportReceiver(pool);receiver=createReportReceiver({pool,keys:[{apiKey:reportKey,resource:"reports:evidence"}],afterAccept:async()=>{if(loseDelivery)throw Error("fixture lost response");}});const address=await receiver.listen({host:"127.0.0.1",port:0});target={id:"evidence-reports",label:"Fixture receiver",resource:"reports:evidence",url:address+"/deliveries"};
  reportConnections=new ConnectionStore(pool,vault,[target]);actions=new ActionService(pool,{vault,targets:[target],artifacts:taskArtifacts});
 });
 afterAll(async()=>{
  await receiver?.close();await pool?.end();
  if(admin){
   await dropClosedTestDatabase(admin,database);await admin.end();
  }
 });
 async function fixture(memoryEnabled=false,connected=false,effects=false){
  const account=await platform.ensureAccount({issuer:"http://localhost/evidence",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const org=await platform.createOrganization(account.id,"Evidence"),scope={accountId:account.id,organizationId:org.id};
  await connectFixtureModel(pool,account.id,org.id);
  const text="First passage. Decisive tail passage 🧪";
  const job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Guide",contentType:"text/markdown",content:Buffer.from(text),parserRelease:"document-v1"});
  await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);
  const chunkId=randomUUID();await knowledge.publishExtraction(job.id,{text,acquiredAt:new Date().toISOString(),normalizerRelease:"text-v1",chunks:[{id:chunkId,revisionId:job.revisionId,ordinal:0,start:0,end:text.length,page:2,section:"Tail",text,digest:textDigest(text),tokens:20}]});
  await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
  let lateJob:Awaited<ReturnType<KnowledgeStore["admitUpload"]>>|undefined,lateChunkId:string|undefined;
  if(effects){const lateText="Late uncited source influencing report selection";lateJob=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Late source",contentType:"text/markdown",content:Buffer.from(lateText),parserRelease:"document-v1"});
   await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[lateJob.id]);lateChunkId=randomUUID();
   await knowledge.publishExtraction(lateJob.id,{text:lateText,acquiredAt:new Date().toISOString(),normalizerRelease:"text-v1",chunks:[{id:lateChunkId,revisionId:lateJob.revisionId,ordinal:0,start:0,end:lateText.length,page:null,section:null,text:lateText,digest:textDigest(lateText),tokens:20}]});
   await knowledge.setPolicy(scope,lateJob.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:lateJob.revisionId});}
  let connectedFixture: {connections:ConnectionStore;connection:Awaited<ReturnType<ConnectionStore["create"]>>;binding:Awaited<ReturnType<ConnectedCatalogStore["selectBindings"]>>[number]}|undefined;
  if(connected){
   const connections=new ConnectionStore(pool,new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),[]);
   const connection=await connections.create(scope,{operationId:randomUUID(),profileId:"github-public-read-v1",targetId:"provider:github",name:"Public reads",apiKey:"github_pat_evidence_fixture_only",expiresAt:new Date(Date.now()+86400000).toISOString(),selections:[{owner:"approved",repository:"public",ref:"main"}]});
   const registry=new ExecutableAdapterRegistry<unknown>(),adapter=registry.register({schemaVersion:1,id:"github-read",release:"1.0.0",executableDigest:"a".repeat(64),transports:["native_http"],protocolVersions:[],boundedSchemaValidation:true},{});
   const catalogs=new ConnectedCatalogStore(pool,connections,registry),schema={type:"object",properties:{},additionalProperties:false};
   const catalog=createCatalog({schemaVersion:1,id:randomUUID(),organizationId:org.id,connectionId:connection.id,revision:1,transport:"native_http",protocolVersion:null,adapter,tools:[{providerOperation:"get_repository",description:"Read repository",inputSchema:schema,inputDigest:digestToolSchema(schema),outputSchema:null,outputDigest:null}]});
   await catalogs.saveCandidate(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,catalog});
   const bindings=await catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,catalogId:catalog.id,selections:[{providerOperation:"get_repository",resources:connection.resources}]});
   connectedFixture={connections,connection,binding:bindings[0]!};
  }
  const reportConnection=effects?await reportConnections.create(scope,{operationId:randomUUID(),name:"Reports",targetId:target.id,apiKey:reportKey}):undefined;
  const config={...defaultBusinessConfiguration(),connectedToolBindingIds:connectedFixture?[connectedFixture.binding.id]:[],sourceRevisionIds:[job.revisionId,...(lateJob?[lateJob.revisionId]:[])],memory:{enabled:memoryEnabled}};
  if(reportConnection){config.capabilities.workflows={enabled:true,profileId:"report-delivery-v1",connectionId:reportConnection.id,reportArtifactName:"report.md",title:"Evidence report"};}
  const agent=await platform.createAgent({...scope,name:"Grounded",configuration:config});
  const version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant={...authority,id:randomUUID(),versionId:version.id,operations:(effects?["model.reply","knowledge.read","artifact.read","artifact.write","effect.deliver"]:connected?["model.reply","knowledge.read","connected.read"]:memoryEnabled?["model.reply","knowledge.read","memory.read","memory.propose"]:["model.reply","knowledge.read"]) as ("model.reply"|"knowledge.read"|"memory.read"|"memory.propose"|"connected.read"|"artifact.read"|"artifact.write"|"effect.deliver")[],sourceRevisionIds:config.sourceRevisionIds,connectedToolBindingIds:config.connectedToolBindingIds,maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(config),rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
  await platform.createGrant({accountId:account.id,grant});const{task}=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Answer with sources"});
  const operationId=`knowledge:${task.id}:initial`;
  await beginOperation(pool,task.id,{id:operationId,kind:"tool",name:"knowledge.search",request:{query:"tail"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  return{scope,job,text,chunkId,task,operationId,grant,connectedFixture,authority,version,reportConnection,lateJob,lateChunkId};
 }
 async function context(f:Awaited<ReturnType<typeof fixture>>,passage:Awaited<ReturnType<EvidenceStore["recordChunk"]>>,step=0){
  const id=`context:${f.task.id}:${step}`,payload={messages:[{role:"system",content:`[${passage.label}] ${passage.text}`}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,$3,$4,$5,0)",[id,f.task.id,step,textDigest(JSON.stringify(payload)),payload]);
  return evidence.supplyContext(f.task.id,id,[passage.reference.id]);
 }
 it("mints exact tail spans with actual-operation identity, stable labels, and immutable provenance",async()=>{
  const f=await fixture(),start=f.text.indexOf("Decisive"),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId,{start,end:f.text.length});
  expect(p.text).toBe("Decisive tail passage 🧪");expect(p.reference.start).toBe(start);expect(p.label).toMatch(/^E[a-f0-9]{32}$/);
  expect((await evidence.recordChunk(f.task.id,f.operationId,f.chunkId,{start,end:f.text.length})).reference.id).toBe(p.reference.id);
  await expect(evidence.recordChunk(f.task.id,"invented",f.chunkId)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await expect(pool.query("UPDATE agents_platform.evidence_references SET citation_label='E9' WHERE id=$1",[p.reference.id])).rejects.toThrow("immutable");
 });
 it("permits only actually supplied citations and preserves all dependencies through summary and artifact derivation",async()=>{
  const f=await fixture(),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);
  await expect(evidence.validateCitations(f.task.id,`Fact [${p.label}]`)).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
  const node=await context(f,p),summary=await evidence.derive(f.task.id,"summary","summary:0"),artifact=await evidence.derive(f.task.id,"artifact",randomUUID());
  expect(summary.parents).toContain(node.id);expect(artifact.manifest).toEqual(p.reference.manifest);
  expect((await evidence.validateCitations(f.task.id,`Fact [${p.label}]`))[0]?.text).toBe(f.text);
  expect(await evidence.verifyQuote(f.task.id,p.reference.id,"Decisive tail")).toBe(true);
  expect(await evidence.verifyQuote(f.task.id,p.reference.id,"invented quotation")).toBe(false);
  await expect(evidence.validateCitations(f.task.id,"Fact [E2]")).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
  const retainedDigest=requestDigest({ids:node.evidenceIds,parentIds:[],manifest:node.manifest});
  await pool.query(`INSERT INTO agents_platform.evidence_nodes(id,organization_id,root_task_id,task_id,kind,owner_id,evidence_ids,parents,manifest,request_digest)
    SELECT gen_random_uuid(),organization_id,root_task_id,task_id,'summary','retained:parallel:'||n,evidence_ids,'{}',manifest,$2
    FROM agents_platform.evidence_nodes CROSS JOIN generate_series(1,1030)n WHERE id=$1`,[node.id,retainedDigest]);
  const joined=await evidence.derive(f.task.id,"summary","retained:joined");
  expect(joined.parents.length).toBeGreaterThan(1024);expect(joined.manifest).toEqual(p.reference.manifest);
  expect((await evidence.validateCitations(f.task.id,`Retained fact [${p.label}]`))[0]?.text).toBe(f.text);
 });
 it("fails closed on forged snapshots, unpinned grants, visibility changes, and withdrawal of hidden influences",async()=>{
  const f=await fixture(),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);
  const id=`context:${f.task.id}:0`;await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[id,f.task.id,"x",{content:`[${p.label}] forged text`}]);
  await expect(evidence.supplyContext(f.task.id,id,[p.reference.id])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  await pool.query("UPDATE agents_platform.execution_grants SET source_revision_ids='{}' WHERE id=$1",[f.grant.id]);
  await expect(assertCurrentEvidence(pool,f.task.id,p.reference.manifest)).rejects.toMatchObject({code:"GRANT_CAPABILITY_DENIED"});
  const second=await fixture(),p2=await evidence.recordChunk(second.task.id,second.operationId,second.chunkId);await context(second,p2);await evidence.derive(second.task.id,"summary","compact");
  await knowledge.setPolicy(second.scope,second.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"visibility",visibility:"public"});
  await expect(evidence.derive(second.task.id,"artifact",randomUUID())).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });
 it("blocks unrelated task references and stale replay after source withdrawal",async()=>{
  const a=await fixture(),b=await fixture(),p=await evidence.recordChunk(a.task.id,a.operationId,a.chunkId);
  const id=`context:${b.task.id}:0`;await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[id,b.task.id,"x",{content:`[${p.label}] ${p.text}`}]);
  await expect(evidence.supplyContext(b.task.id,id,[p.reference.id])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await knowledge.setPolicy(a.scope,a.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  await expect(evidence.recordChunk(a.task.id,a.operationId,a.chunkId)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });
 it("carries accepted personal memory generation into derived output and blocks it after Forget",async()=>{
  const f=await fixture(true),memory=new MemoryStore(pool, skillPackageCodec),managed={...f.scope,agentId:f.task.resource_id};
  const candidate=await memory.proposeManaged(managed,{operationId:randomUUID(),kind:"semantic",content:"Prefer concise answers"});
  const accepted=await memory.mutate(managed,candidate.id,{operationId:randomUUID(),expectedRevision:candidate.revision,action:"accept"});
  const op=`memory:${f.task.id}:0`;await beginOperation(pool,f.task.id,{id:op,kind:"tool",name:"memory.search",request:{query:"preferences"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const p=await evidence.recordMemory(f.task.id,op,accepted.id);await context(f,p);
  const summary=await evidence.derive(f.task.id,"summary","memory-summary");expect(summary.manifest.dependencies[0]?.kind).toBe("memory");
  await memory.mutate(managed,accepted.id,{operationId:randomUUID(),expectedRevision:accepted.revision,action:"forget"});
  await expect(evidence.derive(f.task.id,"artifact",randomUUID())).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });

 it("omits unavailable historical releases without relaxing current execution or history scope",async()=>{
  const f=await fixture(),passage=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);await context(f,passage);
  await finishOperation(pool,f.task.id,f.operationId,"completed",{},null,0);
  await pool.query("UPDATE agents_platform.tasks SET state='completed',output=$2 WHERE id=$1",[f.task.id,`Known fact [${passage.label}]`]);
  const {task:staleCurrent}=await platform.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.version.id,conversationId:f.task.conversation_id,requestKey:randomUUID(),input:"Accepted before the release change"});
  const configuration=structuredClone(f.version.configuration);configuration.instructions+=" Current release instructions.";
  const draft=await platform.updateDraft({...f.scope,agentId:f.version.agent_id,expectedRevision:1,configuration});
  const version=await platform.createVersion({...f.scope,agentId:f.version.agent_id,expectedRevision:draft.draft_revision});
  const grant={...f.grant,id:randomUUID(),versionId:version.id};await platform.createGrant({accountId:f.scope.accountId,grant});
  const {task:current}=await platform.admitTask({authority:f.authority,grantId:grant.id,versionId:version.id,conversationId:f.task.conversation_id,configurationMode:"current",requestKey:randomUUID(),input:"Continue on the current release"});
  const unrelated=await fixture(),compile=compositionCompiler.compileValidatedComposition;
  const changed=vi.spyOn(compositionCompiler,"compileValidatedComposition").mockImplementation((config,...args)=>{
   const composition=compile(config,...args);if(config.instructions!==f.version.configuration.instructions)return composition;
   const {digest:_digest,...content}=composition;
   const drifted={...content,program:{...content.program,digest:requestDigest("replacement trusted program release")}};
   return {...drifted,digest:requestDigest(drifted)};
  });
  try{
   expect((await evidence.checkHistory(current.id,[f.task.id]))[0]).toMatchObject({taskId:f.task.id,eligible:false,omissionCode:"PROGRAM_RELEASE_UNAVAILABLE",evidenceIds:[],originNodeIds:[]});
   await expect(evidence.checkHistory(current.id,[unrelated.task.id])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
   await expect(evidence.checkHistory(staleCurrent.id,[])).rejects.toMatchObject({code:"PROGRAM_RELEASE_UNAVAILABLE"});
   await expect(assertCurrentEvidence(pool,current.id,await evidence.taskManifest(current.id))).resolves.toBeUndefined();
  }finally{changed.mockRestore();}
 });

 it("omits a candidate beyond32 history origins while preserving strict consumed-provenance fencing",async()=>{
  const f=await fixture(),passage=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);await context(f,passage);await finishOperation(pool,f.task.id,f.operationId,"completed",{},null,0);
  async function complete(id:string){await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1 AND state='accepted'",[id]);await settleTask(pool,id,{state:"completed",output:`Known fact [${passage.label}]`});}
  await complete(f.task.id);let previous=f.task;
  for(let originCount=1;originCount<=32;originCount++){
    const{task}=await platform.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.version.id,conversationId:f.task.conversation_id,requestKey:randomUUID(),input:"Continue the same confirmed fact"});
    expect((await evidence.checkHistory(task.id,[previous.id]))[0]?.eligible).toBe(true);
    const id=`context:${task.id}:0`,payload={historyGroupIds:[previous.id],messages:[{role:"assistant",content:`Known fact [${passage.label}]`}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,$5)",[id,task.id,textDigest(JSON.stringify(payload)),payload,originCount]);
    await evidence.inheritHistory(task.id,id,[previous.id]);await assertCurrentEvidence(pool,task.id,await evidence.taskManifest(task.id));await complete(task.id);previous=task;
  }
  const{task:fresh}=await platform.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.version.id,conversationId:f.task.conversation_id,requestKey:randomUUID(),input:"Start with fresh context if the old candidate cannot fit"});
  expect((await evidence.checkHistory(fresh.id,[previous.id]))[0]).toMatchObject({taskId:previous.id,eligible:false,omissionCode:"EVIDENCE_LIMIT",evidenceIds:[],originNodeIds:[]});
  await expect(assertCurrentEvidence(pool,fresh.id,await evidence.taskManifest(fresh.id))).resolves.toBeUndefined();
  const id=`context:${fresh.id}:0`,payload={historyGroupIds:[],messages:[{role:"user",content:"Fresh context without the omitted history"}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,33)",[id,fresh.id,textDigest(JSON.stringify(payload)),payload]);await evidence.inheritHistory(fresh.id,id,[]);await evidence.supplyContext(fresh.id,id,[]);
  const origin=(await pool.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='input'",[previous.id])).rows[0],nodeId=randomUUID();
  // Seed already-consumed provenance to exercise the dispatch fence independently of eligibility.
  await pool.query("INSERT INTO agents_platform.evidence_nodes(id,organization_id,root_task_id,task_id,kind,owner_id,evidence_ids,parents,manifest,request_digest) VALUES($1,$2,$3,$3,'input','consumed-over-limit',$4,$5,$6,$7)",[nodeId,f.scope.organizationId,fresh.id,origin.evidence_ids,[],origin.manifest,requestDigest({ids:origin.evidence_ids,parentIds:[],manifest:origin.manifest})]);
  await pool.query("INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids) VALUES($1,$2,$3)",[nodeId,previous.id,[origin.id]]);
  await expect(assertCurrentEvidence(pool,fresh.id,await evidence.taskManifest(fresh.id))).rejects.toMatchObject({code:"EVIDENCE_LIMIT"});
  const modelId=`model:${fresh.id}:blocked`;await expect(beginOperation(pool,fresh.id,{id:modelId,kind:"model",name:"model.generate",request:{},reservedTokens:100,reservedMs:1000,evidenceManifest:await evidence.taskManifest(fresh.id)})).rejects.toMatchObject({code:"EVIDENCE_LIMIT"});
  expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.operations WHERE id=$1",[modelId])).rows[0].count).toBe(0);
 },30000);

 it("links only already-supplied exact checkpoint evidence metadata with bounded omissions",async()=>{
  const f=await fixture(),first=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId,{start:0,end:14}),second=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId,{start:15,end:f.text.length});
  await context(f,first,0);await context(f,second,1);
  const index=await evidence.suppliedEvidence(f.task.id,1);expect(index.items).toHaveLength(1);expect(index.omittedCount).toBe(1);
  const all=await evidence.suppliedEvidence(f.task.id),ids=all.items.map(item=>item.id);expect(all.items.map(item=>item.kind)).toEqual(["source","source"]);
  async function snapshot(step:number,items:typeof all.items){const id=`context:${f.task.id}:${step}`,payload={messages:[{role:"system",content:JSON.stringify({evidence:items})}],continuationEvidenceIds:items.map(item=>item.id),continuation:{checkpoint:{evidence:items}}};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,$3,$4,$5,0)",[id,f.task.id,step,textDigest(JSON.stringify(payload)),payload]);return id;}
  const id=await snapshot(2,all.items);expect((await evidence.supplyContext(f.task.id,id,[],ids)).evidenceIds).toEqual([...ids].sort());
  expect((await evidence.supplyContext(f.task.id,id,[],ids)).ownerId).toBe(id);
  await expect(evidence.supplyContext(f.task.id,id,[])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  const changed=structuredClone(all.items);changed[0]!.citation="[E0]";await expect(evidence.supplyContext(f.task.id,await snapshot(3,changed),[],ids)).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  const unsupplied=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId,{start:0,end:f.text.length});const unseen=[{id:unsupplied.reference.id,citation:`[${unsupplied.label}]`,operationId:f.operationId,kind:"source" as const}];
  await expect(evidence.supplyContext(f.task.id,await snapshot(4,unseen),[],[unseen[0]!.id])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  await expect(evidence.suppliedEvidence(f.task.id,13)).rejects.toMatchObject({code:"EVIDENCE_LIMIT"});
 });

 it("pins connected resource/catalog receipts, permits credential rotation, and invalidates derived evidence on revoke",async()=>{
  const f=await fixture(false,true),c=f.connectedFixture!,op=`tool:${f.task.id}:connected`;
  await beginOperation(pool,f.task.id,{id:op,kind:"tool",name:c.binding.alias,request:{},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const input={bindingId:c.binding.id,resource:c.connection.resources[0]!,text:"Repository release notes",title:"Public repository",acquiredAt:new Date().toISOString(),receiptDigest:"b".repeat(64)};
  const p=await evidence.recordConnected(f.task.id,op,input);expect(p.reference.manifest.dependencies[0]?.kind).toBe("connection");await context(f,p);
  await c.connections.mutate(f.scope,c.connection.id,{operationId:randomUUID(),expectedRevision:1,apiKey:"github_pat_rotated_fixture_only"},"rotate");
  expect((await evidence.recordConnected(f.task.id,op,input)).reference.id).toBe(p.reference.id);
  await expect(evidence.recordConnected(f.task.id,op,{...input,resource:{kind:"github.repository",id:"unapproved/other"}})).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await c.connections.mutate(f.scope,c.connection.id,{operationId:randomUUID(),expectedRevision:2},"revoke");
  await expect(evidence.derive(f.task.id,"artifact",randomUUID())).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });

 it("validates connected JSON evidence inside tool and compaction envelopes without accepting missing text or citations",async()=>{
  const f=await fixture(false,true),c=f.connectedFixture!,op=`tool:${f.task.id}:connected-json`;
  await beginOperation(pool,f.task.id,{id:op,kind:"tool",name:c.binding.alias,request:{},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const text=JSON.stringify({repository:"approved/public",ref:"main",sha:"a".repeat(40),note:'a "quoted" value\nnext line'},null,2);
  const p=await evidence.recordConnected(f.task.id,op,{bindingId:c.binding.id,resource:c.connection.resources[0]!,text,title:"Resolved public ref",acquiredAt:new Date().toISOString(),receiptDigest:"c".repeat(64)});
  const observation={status:"ok",content:p.text,evidence:{id:p.reference.id,label:p.label,citation:`[${p.label}]`}};
  const messages=[{role:"assistant",content:null,tool_calls:[{id:"resolve",type:"function",function:{name:c.binding.alias,arguments:"{}"}}]},{role:"tool",tool_call_id:"resolve",content:JSON.stringify(observation)}];
  async function save(id:string,step:number,content:unknown){const payload={messages:content};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,$3,$4,$5,0)",[id,f.task.id,step,textDigest(JSON.stringify(payload)),payload]);return evidence.supplyContext(f.task.id,id,[p.reference.id]);}
  expect((await save(`context:${f.task.id}:normal`,0,messages)).evidenceIds).toContain(p.reference.id);
  const compact=[{role:"user",content:JSON.stringify({groupId:"connected-read",records:messages})}];
  const compactNode=await save(`context:${f.task.id}:compact`,1,compact);expect(compactNode.evidenceIds).toContain(p.reference.id);
  expect((await evidence.supplyContext(f.task.id,`context:${f.task.id}:compact`,[p.reference.id])).id).toBe(compactNode.id);
  const changed=structuredClone(observation);changed.content="different provider result";
  await expect(save(`context:${f.task.id}:missing-text`,2,[{role:"user",content:JSON.stringify({records:[{role:"tool",content:JSON.stringify(changed)}]})}])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  const unquoted={...observation,content:p.text.replaceAll('"','')};
  await expect(save(`context:${f.task.id}:missing-quotes`,4,[{role:"user",content:JSON.stringify({records:[{role:"tool",content:JSON.stringify(unquoted)}]})}])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  let overEncoded=JSON.stringify(observation);for(let i=0;i<8;i++)overEncoded=JSON.stringify(overEncoded);
  await expect(save(`context:${f.task.id}:decode-bound`,5,[{role:"user",content:overEncoded}])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  const uncited={...observation,evidence:{id:p.reference.id,label:p.label}};
  await expect(save(`context:${f.task.id}:missing-citation`,3,[{role:"user",content:JSON.stringify({records:[{role:"tool",content:JSON.stringify(uncited)}]})}])).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
 });

 it("inherits actual selected conversation turns across roots with globally distinct citation handles and omits invalidated turns",async()=>{
  const f=await fixture(),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);await context(f,p);await evidence.derive(f.task.id,"artifact","old-report");
  await pool.query("UPDATE agents_platform.tasks SET state='completed',output=$2 WHERE id=$1",[f.task.id,`Known fact [${p.label}]`]);
  const{task:next}=await platform.admitTask({authority:f.authority,grantId:f.grant.id,versionId:f.version.id,conversationId:f.task.conversation_id,requestKey:randomUUID(),input:"Follow up"});
  expect((await evidence.checkHistory(next.id,[f.task.id]))[0]?.eligible).toBe(true);
  const id=`context:${next.id}:0`,payload={historyGroupIds:[f.task.id],messages:[{role:"assistant",content:`Known fact [${p.label}]`}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,1)",[id,next.id,textDigest(JSON.stringify(payload)),payload]);
  await evidence.inheritHistory(next.id,id,[f.task.id]);
  expect((await evidence.validateCitations(next.id,`Follow up [${p.label}]`))[0]?.reference.id).toBe(p.reference.id);
  await expect(evidence.validateCitations(next.id,"Invented old label [E1]")).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
  const unrelated=await fixture();await expect(evidence.checkHistory(next.id,[unrelated.task.id])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  const selection=(await evidence.checkHistory(next.id,[f.task.id]))[0];expect(selection?.eligible).toBe(false);expect(selection?.omissionCode).toBe("EVIDENCE_UNAVAILABLE");
  await expect(evidence.derive(next.id,"artifact",randomUUID())).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });

 it("binds report citations to exact artifact bytes and limits a separate reviewer to cited passages",async()=>{
  const f=await fixture(),first=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId,{start:0,end:14});await context(f,first);
  const hidden=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId,{start:15,end:f.text.length});await context(f,hidden,1);
  const text=`Report statement [${first.label}]`,storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){return objects.get(key)!;},async delete(key:string){objects.delete(key);}};
  const artifact=await new ArtifactStore(pool,storage).put({...f.scope,agentId:f.task.resource_id},{operationId:randomUUID(),contentType:"text/markdown",content:Buffer.from(text)});
  await pool.query("UPDATE agents_platform.artifacts SET task_id=$2,root_task_id=$2,name='report.md' WHERE id=$1",[artifact.id,f.task.id]);
  await expect(evidence.validateReport(f.task.id,artifact.id,text+" changed")).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  await evidence.validateReport(f.task.id,artifact.id,text);await evidence.derive(f.task.id,"artifact",artifact.id);
  const reviewer=await platform.ensureAccount({issuer:"http://localhost/evidence",subject:randomUUID(),email:"reviewer@example.test",displayName:"Reviewer"});
  const outsider=await platform.ensureAccount({issuer:"http://localhost/evidence",subject:randomUUID(),email:"other@example.test",displayName:"Other"});
  for(const member of [reviewer,outsider])await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.scope.organizationId,member.id]);
  const connections=new ConnectionStore(pool,new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),[{id:"reports",label:"Reports",resource:"reports:fixture",url:"http://127.0.0.1:9999/deliveries"}]);
  const connection=await connections.create(f.scope,{operationId:randomUUID(),name:"Reports",targetId:"reports",apiKey:"fixture_report_key"});
  const reviewActionId=randomUUID(),reviewNode=await evidence.derive(f.task.id,"artifact",`review:${reviewActionId}`);
  await pool.query(`INSERT INTO agents_platform.actions(id,organization_id,account_id,reviewer_account_id,task_id,root_task_id,operation_id,connection_id,connection_revision,target_id,target_digest,binding_digest,artifact_id,artifact_digest,title,request_digest,payload,payload_digest,review_digest,state,expires_at,evidence_node_id)
    VALUES($1,$2,$3,$4,$5,$5,'review-operation',$6,1,'reports',$7,$7,$8,$9,'Report',$7,'{}',$7,$7,'pending_review',$10,$11)`,[reviewActionId,f.scope.organizationId,f.scope.accountId,reviewer.id,f.task.id,connection.id,"a".repeat(64),artifact.id,textDigest(text),new Date(Date.now()+60000),reviewNode.id]);
  const preview=await evidence.reviewerPassages({organizationId:f.scope.organizationId,accountId:reviewer.id},f.task.id,artifact.id);
  expect(preview.map(passage=>passage.reference.id)).toEqual([first.reference.id]);expect(preview[0]?.text).not.toContain("Decisive");
  await expect(evidence.reviewerPassages({organizationId:f.scope.organizationId,accountId:outsider.id},f.task.id,artifact.id)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  await expect(evidence.reviewerPassages({organizationId:f.scope.organizationId,accountId:reviewer.id},f.task.id,artifact.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });

 async function reportFixture(content?:(label:string)=>string){
  const f=await fixture(false,false,true),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);await context(f,p);
  const op=`report:${f.task.id}:prepare`;await beginOperation(pool,f.task.id,{id:op,kind:"resource",name:"report.prepare",request:{},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const text=content?content(p.label):`A sourced report [${p.label}]`;
  const artifact=await taskArtifacts.put(f.task.id,op,{name:"report.md",contentType:"text/markdown",content:Buffer.from(text)});
  return{...f,p,op,artifact,text};
 }
 it("creates evidence-bound report artifacts on one leased connection and refuses withdrawn source policy",async()=>{
  const f=await fixture(false,false,true),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);await context(f,p);
  const op=`report:${f.task.id}:single`;await beginOperation(pool,f.task.id,{id:op,kind:"resource",name:"report.prepare",request:{},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const scoped=new URL(url!);scoped.pathname=`/${database}`;
  const single=new Pool({connectionString:scoped.href,max:1,connectionTimeoutMillis:150,statement_timeout:2000,query_timeout:2500});
  const artifacts=new TaskArtifactStore(single,taskArtifacts.objects),content=Buffer.from(`Sourced report [${p.label}]`);
  try{
   const artifact=await artifacts.put(f.task.id,op,{name:"single.md",contentType:"text/markdown",content});
   expect(Buffer.from((await artifacts.download(f.scope.accountId,f.scope.organizationId,f.task.id,artifact.id)).content)).toEqual(content);
   await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
   await expect(artifacts.put(f.task.id,op,{name:"withdrawn.md",contentType:"text/markdown",content})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
   await expect(artifacts.download(f.scope.accountId,f.scope.organizationId,f.task.id,artifact.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  }finally{await single.end();}
 });
 it("invalidates approval, claims and previews from every influencing source, including uncited facts",async()=>{
  for(const approved of [false,true]){
   const f=await reportFixture(approved?()=>"A report whose source influenced the model but was not cited":undefined);
   const action=await actions.prepare(f.task.id,`deliver:${f.task.id}`,{connectionId:f.reportConnection!.id,artifactId:f.artifact.id});
   if(approved)await actions.decide(f.scope,f.task.id,action.id,{operationId:randomUUID(),decision:"approve",expectedDigest:action.reviewDigest});
   await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
   if(approved)await expect(actions.execute(f.task.id,action.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
   else await expect(actions.decide(f.scope,f.task.id,action.id,{operationId:randomUUID(),decision:"approve",expectedDigest:action.reviewDigest})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
   const preview=(await actions.listForTask(f.scope,f.task.id))[0];expect(preview?.preview.content).toBe("[Report source unavailable]");expect(preview?.citedPassages).toEqual([]);
   await expect(taskArtifacts.download(f.scope.accountId,f.scope.organizationId,f.task.id,f.artifact.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
   expect((await pool.query("SELECT count(*) AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[action.id])).rows[0].count).toBe("0");
  }
 });
 it("blocks false citations before review and preserves postclaim lost-response reconciliation after withdrawal",async()=>{
  const invalid=await reportFixture(()=>"Invented citation [E1]");
  await expect(actions.prepare(invalid.task.id,`deliver:${invalid.task.id}`,{connectionId:invalid.reportConnection!.id,artifactId:invalid.artifact.id})).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
  expect((await pool.query("SELECT count(*) AS count FROM agents_platform.actions WHERE task_id=$1",[invalid.task.id])).rows[0].count).toBe("0");
  const f=await reportFixture(),action=await actions.prepare(f.task.id,`deliver:${f.task.id}`,{connectionId:f.reportConnection!.id,artifactId:f.artifact.id});
  await actions.decide(f.scope,f.task.id,action.id,{operationId:randomUUID(),decision:"approve",expectedDigest:action.reviewDigest});
  loseDelivery=true;try{expect((await actions.execute(f.task.id,action.id)).state).toBe("uncertain");}finally{loseDelivery=false;}
  await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  const recovered=await new ActionService(pool,{vault,targets:[target],artifacts:taskArtifacts}).reconcile(action.id);expect(recovered.state).toBe("delivered");expect(recovered.receipt?.payloadDigest).toBe(action.payloadDigest);
  expect((await pool.query("SELECT count(*) AS count FROM report_delivery_receiver.deliveries WHERE id=$1",[action.id])).rows[0].count).toBe("1");
 });
 it("omits stale sourced memories and atomically refuses candidate acceptance after source withdrawal",async()=>{
  const f=await fixture(true),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);await context(f,p);
  const memory=new MemoryStore(pool, skillPackageCodec),managed={...f.scope,agentId:f.task.resource_id};
  const proposed=await memory.proposeManaged(managed,{operationId:randomUUID(),kind:"semantic",content:"Remember sourced preference",sourceTaskId:f.task.id});
  const accepted=await memory.mutate(managed,proposed.id,{operationId:randomUUID(),expectedRevision:proposed.revision,action:"accept"});
  const candidate=await memory.proposeManaged(managed,{operationId:randomUUID(),kind:"semantic",content:"Another sourced preference",sourceTaskId:f.task.id});
  expect((await evidence.checkMemories(f.task.id,[accepted.id]))[0]?.eligible).toBe(true);
  const memoryScope=(await pool.query("SELECT * FROM agents_platform.memory_scopes WHERE organization_id=$1 AND agent_id=$2",[f.scope.organizationId,f.task.resource_id])).rows[0];
  const id=`context:${f.task.id}:1`,payload={messages:[{role:"user",content:accepted.content}]};
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,source_references,memory_scope_id,memory_generation,history_cutoff) VALUES($1,$2,1,'fixture',$3,$4,$5,$6,0)",[id,f.task.id,payload,JSON.stringify([{kind:"memory",id:accepted.id,revision:accepted.revision}]),memoryScope.id,memoryScope.generation]);
  const node=await evidence.supplyContext(f.task.id,id,[]);expect(node.manifest.dependencies.map(dependency=>dependency.kind).sort()).toEqual(["memory","source"]);
  await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  expect((await evidence.checkMemories(f.task.id,[accepted.id]))[0]?.eligible).toBe(false);
  await expect(memory.mutate(managed,candidate.id,{operationId:randomUUID(),expectedRevision:candidate.revision,action:"accept"})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await expect(evidence.derive(f.task.id,"artifact",randomUUID())).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });

 it("reserves task-private artifact metadata before upload and refuses publication when withdrawal races storage",async()=>{
  const f=await fixture(false,false,true),p=await evidence.recordChunk(f.task.id,f.operationId,f.chunkId);await context(f,p);
  const op=`report:${f.task.id}:race`;await beginOperation(pool,f.task.id,{id:op,kind:"resource",name:"report.prepare",request:{},reservedTokens:0,reservedMs:1000,retrySafe:true});
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const racing=new TaskArtifactStore(pool,{async put(key,value){objects.set(key,Buffer.from(value));entered();await gate;},async get(key){return objects.get(key)!;},async delete(key){objects.delete(key);}});
  const pending=racing.put(f.task.id,op,{name:"report.md",contentType:"text/markdown",content:Buffer.from("Race report")});
  await ready;const row=(await pool.query("SELECT * FROM agents_platform.artifacts WHERE task_id=$1",[f.task.id])).rows[0];expect(row.state).toBe("pending");expect(row.root_task_id).toBe(f.task.id);
  expect(await new ArtifactStore(pool,racing.objects).list({...f.scope,agentId:f.task.resource_id})).toEqual([]);
  const rejection=expect(pending).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});release();await rejection;
  expect((await pool.query("SELECT state FROM agents_platform.artifacts WHERE id=$1",[row.id])).rows[0].state).toBe("deleted");expect(objects.has(row.object_key)).toBe(false);
 });

 it("binds a reviewed action to late uncited influences without rewriting the earlier immutable artifact",async()=>{
  const f=await reportFixture(),op=`knowledge:${f.task.id}:late`;
  await beginOperation(pool,f.task.id,{id:op,kind:"tool",name:"knowledge.search",request:{query:"late"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const late=await evidence.recordChunk(f.task.id,op,f.lateChunkId!);await context(f,late,1);
  const action=await actions.prepare(f.task.id,`deliver:${f.task.id}`,{connectionId:f.reportConnection!.id,artifactId:f.artifact.id});
  await knowledge.setPolicy(f.scope,f.lateJob!.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  expect(Buffer.from((await taskArtifacts.download(f.scope.accountId,f.scope.organizationId,f.task.id,f.artifact.id)).content).toString()).toBe(f.text);
  await expect(actions.decide(f.scope,f.task.id,action.id,{operationId:randomUUID(),decision:"approve",expectedDigest:action.reviewDigest})).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });

});
