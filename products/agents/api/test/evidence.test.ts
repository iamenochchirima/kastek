import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {EvidenceStore,citationLabels,assertCurrentEvidence} from "../src/platform/evidence";
import {PlatformStore} from "../src/platform/store";
import {KnowledgeStore} from "../src/platform/knowledge";
import {defaultFaqConfiguration} from "../src/platform/contracts";
import {beginOperation} from "../src/platform/execution";
import {setupPlatformSchema} from "../src/platform/setup";
import {ConnectionStore} from "../src/platform/connections";
import {ConnectionVault} from "../src/platform/vault";
import {ConnectedCatalogStore} from "../src/platform/connected-catalog-store";
import {createCatalog,digestToolSchema,ExecutableAdapterRegistry} from "../src/platform/capability-catalog";
import {ArtifactStore} from "../src/platform/artifacts";
import {MemoryStore} from "../src/platform/memory";
import {textDigest} from "../src/platform/source-contracts";

it("parses only the explicit citation convention, preserving first occurrence",()=>{
 expect(citationLabels("[E2] [draft] [E1] [E2] [E0] [E10000] [e3]")).toEqual(["E2","E1","E0","E10000"]);
});
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("server-issued evidence with real PostgreSQL",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,knowledge:KnowledgeStore,evidence:EvidenceStore;
 const database=`agents_evidence_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>();
 beforeAll(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
  const scoped=new URL(url!);scoped.pathname=`/${database}`;pool=new Pool({connectionString:scoped.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
  const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("missing fixture object");return value;},async delete(key:string){objects.delete(key);}};
  knowledge=new KnowledgeStore(pool,storage);evidence=new EvidenceStore(pool,storage);
 });
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}});
 async function fixture(memoryEnabled=false,connected=false){
  const account=await platform.ensureAccount({issuer:"http://localhost/evidence",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const org=await platform.createOrganization(account.id,"Evidence"),scope={accountId:account.id,organizationId:org.id};
  const text="First passage. Decisive tail passage 🧪";
  const job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Guide",contentType:"text/markdown",content:Buffer.from(text),parserRelease:"document-v1"});
  await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);
  const chunkId=randomUUID();await knowledge.publishExtraction(job.id,{text,acquiredAt:new Date().toISOString(),normalizerRelease:"text-v1",chunks:[{id:chunkId,revisionId:job.revisionId,ordinal:0,start:0,end:text.length,page:2,section:"Tail",text,digest:textDigest(text),tokens:20}]});
  await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
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
  const config={...defaultFaqConfiguration(),connectedToolBindingIds:connectedFixture?[connectedFixture.binding.id]:[],sourceRevisionIds:[job.revisionId],memory:{enabled:memoryEnabled}},agent=await platform.createAgent({...scope,name:"Grounded",configuration:config});
  const version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant={...authority,id:randomUUID(),versionId:version.id,operations:(connected?["model.reply","knowledge.read","connected.read"]:memoryEnabled?["model.reply","knowledge.read","memory.read","memory.propose"]:["model.reply","knowledge.read"]) as ("model.reply"|"knowledge.read"|"memory.read"|"memory.propose"|"connected.read")[],knowledgeIds:[],sourceRevisionIds:[job.revisionId],connectedToolBindingIds:config.connectedToolBindingIds,maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
  await platform.createGrant({accountId:account.id,grant});const{task}=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Answer with sources"});
  const operationId=`knowledge:${task.id}:initial`;
  await beginOperation(pool,task.id,{id:operationId,kind:"tool",name:"knowledge.search",request:{query:"tail"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  return{scope,job,text,chunkId,task,operationId,grant,connectedFixture,authority,version};
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
  const f=await fixture(true),memory=new MemoryStore(pool),managed={...f.scope,agentId:f.task.resource_id};
  const candidate=await memory.proposeManaged(managed,{operationId:randomUUID(),kind:"semantic",content:"Prefer concise answers"});
  const accepted=await memory.mutate(managed,candidate.id,{operationId:randomUUID(),expectedRevision:candidate.revision,action:"accept"});
  const op=`memory:${f.task.id}:0`;await beginOperation(pool,f.task.id,{id:op,kind:"tool",name:"memory.search",request:{query:"preferences"},reservedTokens:0,reservedMs:1000,retrySafe:true});
  const p=await evidence.recordMemory(f.task.id,op,accepted.id);await context(f,p);
  const summary=await evidence.derive(f.task.id,"summary","memory-summary");expect(summary.manifest.dependencies[0]?.kind).toBe("memory");
  await memory.mutate(managed,accepted.id,{operationId:randomUUID(),expectedRevision:accepted.revision,action:"forget"});
  await expect(evidence.derive(f.task.id,"artifact",randomUUID())).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
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
  await pool.query(`INSERT INTO agents_platform.actions(id,organization_id,account_id,reviewer_account_id,task_id,root_task_id,operation_id,connection_id,connection_revision,target_id,target_digest,binding_digest,artifact_id,artifact_digest,title,request_digest,payload,payload_digest,review_digest,state,expires_at)
    VALUES($1,$2,$3,$4,$5,$5,'review-operation',$6,1,'reports',$7,$7,$8,$9,'Report',$7,'{}',$7,$7,'pending_review',$10)`,[randomUUID(),f.scope.organizationId,f.scope.accountId,reviewer.id,f.task.id,connection.id,"a".repeat(64),artifact.id,textDigest(text),new Date(Date.now()+60000)]);
  const preview=await evidence.reviewerPassages({organizationId:f.scope.organizationId,accountId:reviewer.id},f.task.id,artifact.id);
  expect(preview.map(passage=>passage.reference.id)).toEqual([first.reference.id]);expect(preview[0]?.text).not.toContain("Decisive");
  await expect(evidence.reviewerPassages({organizationId:f.scope.organizationId,accountId:outsider.id},f.task.id,artifact.id)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});
  await expect(evidence.reviewerPassages({organizationId:f.scope.organizationId,accountId:reviewer.id},f.task.id,artifact.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });

});
