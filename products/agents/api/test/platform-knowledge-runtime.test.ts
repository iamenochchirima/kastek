import { dropClosedTestDatabase } from "./support/database-cleanup";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { connectFixtureModel } from "./model-fixture";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {KnowledgeStore} from "../src/platform/knowledge/knowledge";
import {KnowledgeRuntime} from "../src/platform/knowledge/knowledge-runtime";
import {EvidenceStore} from "../src/execution/context/evidence";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {beginOperation,assertCurrentAuthority,loadExecution} from "../src/execution/lifecycle/execution";
import {defaultBusinessConfiguration,executionGrantSchema,requestDigest} from "../src/contracts/contracts";
import {textDigest} from "../src/contracts/source-contracts";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("knowledge runtime evidence and bounded source reads with PostgreSQL",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,knowledge:KnowledgeStore,evidence:EvidenceStore,runtime:KnowledgeRuntime;
 const database=`agents_knowledge_runtime_${randomUUID().replaceAll("-","")}`,bodies=new Map<string,Uint8Array>();
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
  const objects={async put(key:string,bytes:Uint8Array){bodies.set(key,bytes);},async get(key:string){const bytes=bodies.get(key);if(!bytes)throw Error("Missing private fixture");return bytes;},async delete(key:string){bodies.delete(key);}};knowledge=new KnowledgeStore(pool,objects);evidence=new EvidenceStore(pool,objects);runtime=new KnowledgeRuntime(pool,evidence);
 });
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(hybrid=false,passages?:string[]){
  const account=await platform.ensureAccount({issuer:"http://knowledge/runtime",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(account.id,"Knowledge runtime"),scope={organizationId:org.id,accountId:account.id};
  // Long unknown words exercise byte/span handling without exceeding a tokenizer's wordpiece count.
  const values=passages??[("x".repeat(250)+" ").repeat(20),"Ordinary background information.",("y".repeat(250)+" ").repeat(20)+" Zircon refrigeration requires four degrees Celsius. Café São Tomé. "+"🧪".repeat(1200)+" End of the policy."];
  const text=values.join("\n\n"),release="document-processing-v1@"+"a".repeat(64),job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Laboratory guide",contentType:"text/plain",content:Buffer.from(text),parserRelease:"fixture-parser-v1",...(hybrid?{embeddingRelease:release}:{})});
  let start=0;const chunks=values.map((value,ordinal)=>{const chunk={id:randomUUID(),revisionId:job.revisionId,ordinal,start,end:start+value.length,page:ordinal+1,section:null,text:value,digest:textDigest(value),tokens:64};start=chunk.end+2;return chunk;});await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);
  await knowledge.publishExtraction(job.id,{text,chunks,normalizerRelease:"fixture-nfc-v1",acquiredAt:new Date().toISOString(),...(hybrid?{embeddings:chunks.map(()=>Array.from({length:384},(_,index)=>index===0?1:0))}:{})});await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
  await connectFixtureModel(pool,account.id,org.id);
  const config=defaultBusinessConfiguration();config.memory={enabled:false};config.model.maxOutputTokens=1024;config.sourceRevisionIds=[job.revisionId];config.tools=["knowledge.search","knowledge.read"];config.retrievalProfile=hybrid?{kind:"hybrid-v1",embeddingRelease:release}:{kind:"lexical-v1"};const agent=await platform.createAgent({...scope,name:"Researcher",configuration:config}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}},grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read"],sourceRevisionIds:[job.revisionId],maxInputBytes:16384,maxOutputTokens:1024,maxContextTokens:contextGrantCeiling(config),expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null});await platform.createGrant({...scope,grant});const {task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Zircon refrigeration policy"});
  return{scope,job,text,chunks,task,grant,authority,version};
 }
 async function operation(taskId:string,name="knowledge.search",args:unknown={query:"zircon"}){const id=`tool:${taskId}:${randomUUID()}`;await beginOperation(pool,taskId,{id,kind:"tool",name,request:{tool:name,arguments:JSON.stringify(args),version:"1"},reservedTokens:0,reservedMs:30000,retrySafe:true});return id;}
 it("finds approved business facts from ordinary questions and entity searches without requiring every prompt word",async()=>{
  const facts="Wheelhouse is a mobile bicycle repair service in Pretoria. The service area is Hatfield and Brooklyn only. The call-out fee is R150 and repairs are quoted separately. Supported repairs are punctures and brake adjustments. E-bike repairs are not available. There is no launch discount and no booking link.";
  const f=await fixture(false,[facts,"Independent laboratory samples require refrigerated storage."]);
  for(const query of ["We're launching Wheelhouse next Monday. Can you put together a practical launch plan, a couple of social posts and a WhatsApp message?","What can you tell me about Wheelhouse?"]){
   const id=await operation(f.task.id,"knowledge.search",{query}),result=await runtime.search(f.task.id,id,query);
   expect(f.version.configuration.memory.enabled).toBe(false);expect(result.passages).toHaveLength(1);expect(result.passages[0]!.text).toBe(facts);expect(result.passages[0]!.revisionId).toBe(f.job.revisionId);
   expect((await pool.query("SELECT operation_id,revision_id FROM agents_platform.evidence_references WHERE id=$1",[result.passages[0]!.evidenceId])).rows[0]).toMatchObject({operation_id:id,revision_id:f.job.revisionId});
  }
 });
 it("retrieves normalized JSON records through the real knowledge runtime",async()=>{
  const account=await platform.ensureAccount({issuer:"http://knowledge/structured",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(account.id,"Sandwich Baron"),scope={organizationId:org.id,accountId:account.id};
  const menu=JSON.stringify({order_url:"https://sandwichbaronheadoffice.zenfoody.com/newtemplate",categories:[{name:"Sandwiches",category_url:"https://www.sandwichbaron.co.za/sandwiches",items:[{name:"Chicken Mayo",price:{sandwich:"R47",french:"R65",footlong:"R87"}}]}],stores:[{name:"Sandton",weekday:"08:00-16:30",saturday:"08:00-13:30"},{name:"Klerksdorp",weekday:"08:00-16:30",saturday:"08:00-13:30"}]});
  const job=await knowledge.admitText(scope,{operationId:randomUUID(),title:"Sandwich Baron menu",contentType:"application/json",text:menu});
  expect(job.state).toBe("ready");expect(job.contentType).toBe("text/markdown");
  await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
  await connectFixtureModel(pool,account.id,org.id);
  const config=defaultBusinessConfiguration();config.model.maxOutputTokens=1024;config.sourceRevisionIds=[job.revisionId];config.tools=["knowledge.search","knowledge.read"];config.retrievalProfile={kind:"lexical-v1"};
  const agent=await platform.createAgent({...scope,name:"Sandwich Baron",configuration:config}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}},grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read"],sourceRevisionIds:[job.revisionId],maxInputBytes:16384,maxOutputTokens:1024,maxContextTokens:contextGrantCeiling(config),expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null});
  await platform.createGrant({...scope,grant});const {task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Sandwich Baron menu"});
  for(const [query,expected] of [["How much is the Chicken Mayo footlong?",["Chicken Mayo","price.footlong: R87"]],["What are the Sandton Saturday hours?",["Sandton","saturday: 08:00-13:30"]],["Do you deliver to Klerksdorp?",["Klerksdorp"]]] as const){
   const id=await operation(task.id,"knowledge.search",{query}),result=await runtime.search(task.id,id,query),text=result.passages.map(passage=>passage.text).join("\n");
   expect(result.passages.length).toBeGreaterThan(0);expect(text).toContain(expected[0]);
   for(const fragment of expected.slice(1))expect(text).toContain(fragment);
  }
 });
 it("retrieves a decisive tail passage with exact page/span/hash provenance and a serializable citation",async()=>{
  const f=await fixture(),id=await operation(f.task.id),result=await runtime.search(f.task.id,id,"zircon");expect(result.passages).toHaveLength(1);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
  const passage=result.passages[0]!;expect(passage.page).toBe(3);expect(passage.start).toBeGreaterThan(9000);expect(passage.text).toContain("four degrees Celsius");expect(f.text.slice(passage.start,passage.end)).toBe(passage.text);expect(Buffer.byteLength(passage.text)).toBeLessThanOrEqual(1800);expect(passage.text).not.toContain("�");expect(passage.citation).toBe(`[${passage.label}]`);
  const reference=(await pool.query("SELECT * FROM agents_platform.evidence_references WHERE id=$1",[passage.evidenceId])).rows[0];expect(reference.content_digest).toBe(textDigest(passage.text));expect(reference.operation_id).toBe(id);
  const snapshot=`context:${f.task.id}:0`,payload={messages:[{role:"tool",content:JSON.stringify(result)}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,f.task.id,requestDigest(payload),payload]);await evidence.supplyContext(f.task.id,snapshot,[passage.evidenceId]);
  expect(await evidence.validateCitations(f.task.id,`Keep samples at four degrees Celsius ${passage.citation}`)).toHaveLength(1);await expect(evidence.validateCitations(f.task.id,"Forged citation [E00000000000000000000000000000000]")).rejects.toMatchObject({code:"CITATION_UNKNOWN"});
 });
 it("reads bounded Unicode-safe continuation spans only through a permitted evidence handle",async()=>{
  const f=await fixture(),id=await operation(f.task.id),found=await runtime.search(f.task.id,id,"zircon"),reference=found.passages[0]!;const readId=await operation(f.task.id,"knowledge.read",{evidenceId:reference.evidenceId});
  const first=await runtime.read(f.task.id,readId,reference.evidenceId);expect(Buffer.byteLength(first.passage.text)).toBeLessThanOrEqual(4096);expect(first.nextOffset).not.toBeNull();expect(f.text.slice(first.passage.start,first.passage.end)).toBe(first.passage.text);
  const secondId=await operation(f.task.id,"knowledge.read",{evidenceId:reference.evidenceId,offset:first.nextOffset}),second=await runtime.read(f.task.id,secondId,reference.evidenceId,first.nextOffset!);expect(second.passage.start).toBe(first.passage.end);expect(second.passage.text).not.toContain("�");expect(f.text.slice(second.passage.start,second.passage.end)).toBe(second.passage.text);
  const low=f.chunks[2]!.text.indexOf("🧪")+1;await expect(runtime.read(f.task.id,readId,reference.evidenceId,low)).rejects.toMatchObject({code:"EVIDENCE_SPAN_INVALID"});await expect(runtime.read(f.task.id,readId,randomUUID())).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
 });
 it("returns a genuine lexical no-match and fails closed for unavailable hybrid embeddings",async()=>{
  const f=await fixture(),id=await operation(f.task.id,"knowledge.search",{query:"unobtainiumquasar"});expect(await runtime.search(f.task.id,id,"unobtainiumquasar")).toEqual({profile:"lexical-v1",passages:[],omitted:0});expect((await pool.query("SELECT count(*) FROM agents_platform.evidence_references WHERE task_id=$1",[f.task.id])).rows[0].count).toBe("0");
  const hybrid=await fixture(true),hybridId=await operation(hybrid.task.id);await expect(runtime.search(hybrid.task.id,hybridId,"zircon")).rejects.toMatchObject({code:"RETRIEVAL_BACKEND_UNAVAILABLE"});
  const hits=await runtime.retrieval.search({organizationId:hybrid.scope.organizationId,versionId:hybrid.version.id,sourceRevisionIds:[hybrid.job.revisionId],publicOnly:false},"Could you explain how the zircon samples should be refrigerated?",{kind:"hybrid-v1",embeddingRelease:"document-processing-v1@"+"a".repeat(64),queryVector:Array.from({length:384},(_,index)=>index===0?1:0)},async db=>assertCurrentAuthority(db,await loadExecution(db,hybrid.task.id)));
  expect(hits[0]!.text).toContain("Zircon refrigeration");expect(hits.length).toBeLessThanOrEqual(5);
 });
 it("does not let an unavailable private index block customer-visible knowledge",async()=>{
  const f=await fixture(true),release="document-processing-v1@"+"b".repeat(64);
  await pool.query("UPDATE agents_platform.sources SET visibility='private' WHERE id=$1",[f.job.sourceId]);
  const scope={organizationId:f.scope.organizationId,versionId:f.version.id,sourceRevisionIds:[f.job.revisionId],publicOnly:true};
  const profile={kind:"hybrid-v1" as const,embeddingRelease:release,queryVector:Array.from({length:384},(_,index)=>index===0?1:0)};
  const authorize=async(db:import("pg").PoolClient)=>assertCurrentAuthority(db,await loadExecution(db,f.task.id));
  expect(await runtime.retrieval.search(scope,"zircon",{kind:"lexical-v1"},authorize)).toEqual([]);
  expect((await runtime.retrieval.search({...scope,publicOnly:false},"zircon",{kind:"lexical-v1"},authorize)).length).toBeGreaterThan(0);
  expect(await runtime.retrieval.search(scope,"zircon",profile,authorize)).toEqual([]);
  await expect(runtime.retrieval.search({...scope,publicOnly:false},"zircon",profile,authorize)).rejects.toMatchObject({code:"RETRIEVAL_BACKEND_UNAVAILABLE"});
 });
 it("keeps private pinned sections out of customer context",async()=>{
  const f=await fixture(false,["Private zircon instructions"]),content="Private zircon instructions";
  await pool.query(`INSERT INTO agents_platform.source_sections(id,organization_id,revision_id,ordinal,level,heading,heading_path,start_offset,end_offset,chars,content,content_digest)
    VALUES($1,$2,$3,0,1,'Instructions','Instructions',0,$4,$4,$5,$6)`,[randomUUID(),f.scope.organizationId,f.job.revisionId,content.length,content,textDigest(content)]);
  await pool.query("UPDATE agents_platform.sources SET visibility='public' WHERE id=$1",[f.job.sourceId]);
  const deployment=await platform.publishWebsite({accountId:f.scope.accountId,organizationId:f.scope.organizationId,agentId:f.task.resource_id,versionId:f.version.id,allowedOrigins:["https://example.com"]});
  const grant=await platform.createWebsiteGrant({deploymentId:deployment.id,origin:"https://example.com",sessionId:randomUUID()});
  const authority={product:grant.product,organizationId:grant.organizationId,resourceId:grant.resourceId,callerClientId:grant.callerClientId,principal:grant.principal};
  const visitor=await platform.admitTask({authority,versionId:grant.versionId,grantId:grant.id,requestKey:randomUUID(),input:"Hello"});
  await pool.query("UPDATE agents_platform.sources SET visibility='private' WHERE id=$1",[f.job.sourceId]);
  expect(await runtime.pinnedEligible(f.task.id)).toBe(true);
  expect(await runtime.pinnedSources(f.task.id)).toHaveLength(1);
  expect(await runtime.pinnedEligible(visitor.task.id)).toBe(false);
  expect(await runtime.pinnedSources(visitor.task.id)).toEqual([]);
 });
 it("denies cross-root handles and rechecks source withdrawal before new searches and reads",async()=>{
  const first=await fixture(),other=await fixture(),id=await operation(first.task.id),found=await runtime.search(first.task.id,id,"zircon"),reference=found.passages[0]!;
  const otherRead=await operation(other.task.id,"knowledge.read",{evidenceId:reference.evidenceId});await expect(runtime.read(other.task.id,otherRead,reference.evidenceId)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  expect(await runtime.retrieval.search({organizationId:first.scope.organizationId,versionId:first.version.id,sourceRevisionIds:[other.job.revisionId],publicOnly:false},"Could you explain zircon refrigeration?",{kind:"lexical-v1"},async db=>assertCurrentAuthority(db,await loadExecution(db,first.task.id)))).toEqual([]);
  await knowledge.setPolicy(first.scope,first.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});const readId=await operation(first.task.id,"knowledge.read",{evidenceId:reference.evidenceId});await expect(runtime.read(first.task.id,readId,reference.evidenceId)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  const searchId=await operation(first.task.id);expect((await runtime.search(first.task.id,searchId,"zircon")).passages).toEqual([]);
 });
});
