import {dropClosedTestDatabase} from "./support/database-cleanup";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {homedir} from "node:os";
import {performance} from "node:perf_hooks";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {DocumentRuntime} from "../src/capabilities/knowledge/document-runtime";
import {KnowledgeRetrieval,RETRIEVAL_PROFILE,type RetrievalScope} from "../src/capabilities/knowledge/retrieval";
import {KnowledgeStore,requireKnowledgeMember,type KnowledgeScope} from "../src/capabilities/knowledge/knowledge";
import {QueryEmbeddingService} from "../src/capabilities/knowledge/query-embedding";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {defaultBusinessConfiguration,executionGrantSchema} from "../src/contracts/contracts";
import {beginOperation,finishOperation,settleTask} from "../src/execution/lifecycle/execution";
import {textDigest} from "../src/contracts/source-contracts";

const url=process.env.AGENTS_TEST_DATABASE_URL;
const suite=url&&process.env.AGENTS_DOCUMENT_RUNTIME_VERIFY==="1"?describe:describe.skip;
// Fixed labeled holdout; irrelevant boilerplate is duplicated to measure dense exact-scan behavior.
const corpus=[
 {id:"cancellation",text:"Customers cancelling a reservation within fourteen days pay a cancellation charge of forty-two dollars."},
 {id:"refund",text:"Approved refund requests return to the original bank card within seven business days."},
 {id:"accessibility",text:"The museum provides step-free wheelchair access through the east entrance and a free companion ticket."},
 {id:"hours",text:"The help desk opens Monday to Friday from nine in the morning until six in the evening."},
 {id:"pets",text:"Registered assistance dogs are welcome. Other pets must remain outside the visitor centre."},
 {id:"password",text:"To recover account access, select Forgot password and follow the recovery link sent to your registered email address."},
 {id:"privacy",text:"We retain customer support conversation records for thirty days before permanent deletion."},
 {id:"shipping",text:"Orders shipped to Namibia arrive in three to five working days; tracking begins when the parcel leaves the warehouse."},
 {id:"unicode",text:"Café São Tomé serves pão de queijo and accepts M-Pesa payments in meticais."},
 {id:"conflict-old",text:"The archived 2025 annual membership policy sets the membership price at ninety dollars."},
 {id:"conflict-new",text:"The current 2026 annual membership policy sets the membership price at one hundred and ten dollars."},
 {id:"tail",text:"Zircon research samples must be refrigerated at four degrees Celsius immediately after collection."},
];
const holdout=[
 {query:"What do I owe if I call off my booking two weeks before?",expected:["cancellation"]},
 {query:"How long before the money goes back to my credit card?",expected:["refund"]},
 {query:"Can someone using a wheelchair enter without climbing stairs?",expected:["accessibility"]},
 {query:"When can I contact a person at the help desk during the week?",expected:["hours"]},
 {query:"May I bring my service dog into the visitor building?",expected:["pets"]},
 {query:"I cannot sign in because I forgot my login secret. How can I regain access?",expected:["password"]},
 {query:"How many days do you keep support chat history?",expected:["privacy"]},
 {query:"How long will delivery of a package to Namibia take?",expected:["shipping"]},
 {query:"Café São Tomé M-Pesa pão de queijo",expected:["unicode"]},
 {query:"What annual membership prices do the old and new policies give?",expected:["conflict-old","conflict-new"]},
 {query:"At what temperature should zircon samples be kept after collection?",expected:["tail"]},
 {query:"Who won the 1978 world chess championship?",expected:[]},
 {query:"What is the orbital period of the planet Neptune?",expected:[]},
 {query:"Give me the nuclear fusion cross section for deuterium tritium.",expected:[]},
];
suite("local hybrid retrieval quality, eligibility and resource recovery",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,knowledge:KnowledgeStore,retrieval:KnowledgeRetrieval,queries:QueryEmbeddingService;
 const database=`agents_retrieval_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>(),runtime=new DocumentRuntime({cache:process.env.AGENTS_DOCUMENT_RUNTIME_CACHE??join(homedir(),".cache/kasitek-documents")}),allocations:string[]=[];
 let release:string,owner:KnowledgeScope,scope:RetrievalScope,account:{issuer:string;subject:string},agentId:string,versionId:string;
 const labels=new Map<string,string>(),sources:{id:string;revisionId:string}[]=[],timings:number[]=[];let quality:Record<string,unknown>={},calibration:Record<string,unknown>={};
 beforeAll(async()=>{
  expect(await runtime.available()).toBe(true);release=(await runtime.profile()).profileRelease;
  admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);
  platform=new PlatformStore(pool);const store={async get(key:string){const value=objects.get(key);if(!value)throw Error("Private fixture object missing");return value;},async put(key:string,content:Uint8Array){objects.set(key,Buffer.from(content));},async delete(key:string){objects.delete(key);}};
  knowledge=new KnowledgeStore(pool,store);retrieval=new KnowledgeRetrieval(pool);queries=new QueryEmbeddingService(pool,store,runtime);
  const person=await platform.ensureAccount({issuer:"http://localhost/retrieval",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});account=person;const organization=await platform.createOrganization(person.id,"Retrieval quality");owner={accountId:person.id,organizationId:organization.id};
  const fillers="Warehouse inventory placeholder: standard cardboard packaging and routine stock counting procedures.";
  const vectors=await embed("document",[...corpus.map(item=>item.text),fillers]);
  const dense=process.env.AGENTS_RETRIEVAL_BENCHMARK==="1",sourceCount=dense?20:1,perSource=dense?1000:corpus.length;
  for(let number=0;number<sourceCount;number++){
   const values=Array(perSource).fill(fillers) as string[],ids=Array(perSource).fill("filler") as string[];
   if(number===0)for(let n=0;n<corpus.length-1;n++){values[n]=corpus[n]!.text;ids[n]=corpus[n]!.id;}
   if(number===sourceCount-1){values[perSource-1]=corpus.at(-1)!.text;ids[perSource-1]=corpus.at(-1)!.id;}
   const text=values.join("\n\n"),job=await knowledge.admitUpload(owner,{operationId:randomUUID(),title:`Handbook ${number+1}`,contentType:"text/plain",content:Buffer.from(text),parserRelease:release,embeddingRelease:release});
   let offset=0;const chunks=values.map((value,ordinal)=>{const id=randomUUID();labels.set(id,ids[ordinal]!);const chunk={id,revisionId:job.revisionId,ordinal,start:offset,end:offset+value.length,page:Math.floor(ordinal/5)+1,section:null,text:value,digest:textDigest(value),tokens:40};offset=chunk.end+2;return chunk;});
   await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);await knowledge.publishExtraction(job.id,{text,chunks,normalizerRelease:"fixture-nfc-lf-v1",acquiredAt:new Date().toISOString(),embeddings:ids.map(id=>vectors[id==="filler"?corpus.length:corpus.findIndex(item=>item.id===id)]!)});
   await knowledge.setPolicy(owner,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});sources.push({id:job.sourceId,revisionId:job.revisionId});
  }
  const config=defaultBusinessConfiguration();config.tools=["knowledge.search"];config.sourceRevisionIds=sources.map(source=>source.revisionId);config.retrievalProfile={kind:"hybrid-v1",embeddingRelease:release};
  expect(Number((await pool.query("SELECT count(*) FROM agents_platform.source_chunks WHERE organization_id=$1",[owner.organizationId])).rows[0].count)).toBe(sourceCount*perSource);
  const agent=await platform.createAgent({...owner,name:"Knowledge researcher",configuration:config});agentId=agent.id;const version=await platform.createVersion({...owner,agentId,expectedRevision:1});versionId=version.id;
  expect(Number((await pool.query("SELECT count(*) FROM agents_platform.version_sources WHERE version_id=$1",[versionId])).rows[0].count)).toBe(sourceCount);
  scope={organizationId:owner.organizationId,versionId,sourceRevisionIds:sources.map(source=>source.revisionId),publicOnly:false};
  await pool.query("ANALYZE agents_platform.source_chunks");await pool.query("ANALYZE agents_platform.chunk_embeddings");
 },120_000);
 afterAll(async()=>{
  for(const id of allocations)await runtime.destroy(id);if(queries)await queries.reap();
  if(timings.length){const ordered=timings.toSorted((a,b)=>a-b),report={profile:RETRIEVAL_PROFILE,embeddingRelease:release,eligibleChunks:process.env.AGENTS_RETRIEVAL_BENCHMARK==="1"?20000:corpus.length,fixture:"13 actual distinct passage vectors; exact duplicate boilerplate reuses its identical vector; real PostgreSQL and gVisor; fixture private object map",calibration,quality,samples:timings.length,p50Ms:ordered[Math.floor(ordered.length*.5)],p95Ms:ordered[Math.min(ordered.length-1,Math.ceil(ordered.length*.95)-1)]};
   await mkdir(resolve(__dirname,"../../../../.audit"),{recursive:true});await writeFile(resolve(__dirname,`../../../../.audit/knowledge-retrieval-benchmark-${report.eligibleChunks}.json`),JSON.stringify(report,null,2));console.log("RETRIEVAL_BENCHMARK",JSON.stringify(report));}
  await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}
 });
 async function embed(mode:"query"|"document",texts:string[]){
  const id=randomUUID();allocations.push(id);await runtime.start({allocationId:id,jobId:randomUUID(),profileRelease:release,input:{kind:"embed",mode,texts}});
  for(let count=0;count<700;count++){const result=await runtime.result(id);if(result){if(!result.ok)throw Error(result.errorCode);if(result.result.kind!=="embed")throw Error("Expected vectors");await runtime.destroy(id);return result.result.vectors;}await new Promise(done=>setTimeout(done,50));}throw Error("Embedding timeout");
 }
 async function operation(query:string){
  const authority={product:"agents" as const,organizationId:owner.organizationId,resourceId:agentId,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId,operations:["model.reply","knowledge.read"],sourceRevisionIds:scope.sourceRevisionIds,maxInputBytes:16384,maxOutputTokens:1024,expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null});await platform.createGrant({...owner,grant});const admitted=await platform.admitTask({authority,versionId,grantId:grant.id,requestKey:randomUUID(),input:query});
  const operationId=`tool:${admitted.task.id}:search`;await beginOperation(pool,admitted.task.id,{id:operationId,kind:"tool",name:"knowledge.search",request:{query},reservedTokens:0,reservedMs:30000,retrySafe:true});return{taskId:admitted.task.id,operationId,grant};
 }
 it("calibrates the pinned semantic gate on separate development passages",async()=>{
  const documents=["Employees receive twenty annual leave days each calendar year.","The city airport shuttle departs every thirty minutes from platform five.","A broken office laptop can be replaced by submitting an equipment support ticket.","The car insurance policy covers accidental windscreen damage.","Invoice payments are due forty-five days after the invoice date.","The swimming pool is closed on Tuesdays for maintenance."];
  const positive=["How much yearly holiday entitlement do staff have?","How often does the bus to the airport leave and from which platform?","What should I do when my work computer is broken?","Does the motor policy pay for a cracked front window?","When must a customer settle their bill?","On which day can nobody use the pool?"];
  const negative=["How fast does a cheetah run?","What ingredients make sourdough bread rise?","Who composed the opera Aida?","What causes solar flares?","How do tropical orchids reproduce?","What is the density of platinum?"];
  const docs=await embed("document",documents),vectors=await embed("query",[...positive,...negative]),dot=(a:number[],b:number[])=>a.reduce((sum,value,index)=>sum+value*b[index]!,0);
  const positives=vectors.slice(0,6).map((vector,index)=>dot(vector,docs[index]!)),negatives=vectors.slice(6).map(vector=>Math.max(...docs.map(doc=>dot(vector,doc))));
  calibration={kind:"separate-fixed-development-corpus",positiveCases:6,negativeCases:6,minPositive:Math.min(...positives),maxNegative:Math.max(...negatives),selectedThreshold:RETRIEVAL_PROFILE.semanticMinSimilarity};
  expect(RETRIEVAL_PROFILE.semanticMinSimilarity).toBeGreaterThan(Math.max(...negatives));expect(RETRIEVAL_PROFILE.semanticMinSimilarity).toBeLessThan(Math.min(...positives));
 },15_000);
 it("meets labeled paraphrase/tail/conflict/no-answer gates with the real embedding model",async()=>{
  const vectors=await embed("query",holdout.map(item=>item.query)),results=[];let expectedCount=0,found=0,lexicalFound=0,falseAnswers=0;
  for(const [index,item]of holdout.entries()){
   const hits=await retrieval.search(scope,item.query,{kind:"hybrid-v1",embeddingRelease:release,queryVector:vectors[index]!},db=>requireKnowledgeMember(db,owner));const actual=hits.map(hit=>labels.get(hit.chunkId));
   const lexical=await retrieval.search(scope,item.query,{kind:"lexical-v1"},db=>requireKnowledgeMember(db,owner)),lexicalLabels=lexical.map(hit=>labels.get(hit.chunkId));
   if(item.expected.length){expectedCount+=item.expected.length;found+=item.expected.filter(id=>actual.includes(id)).length;lexicalFound+=item.expected.filter(id=>lexicalLabels.includes(id)).length;}else if(hits.length)falseAnswers++;
   results.push({query:item.query,expected:item.expected,actual,lexical:lexicalLabels});
  }
  quality={recallAt5:found/expectedCount,lexicalRecallAt5:lexicalFound/expectedCount,falseAnswers,results};expect(found/expectedCount,JSON.stringify(results)).toBeGreaterThanOrEqual(.9);expect(found).toBeGreaterThan(lexicalFound);expect(falseAnswers,JSON.stringify(results)).toBe(0);
 },30_000);
 it("keeps owner/public/withdrawal/version gates before ranking and rejects profile fallback",async()=>{
  const vector=(await embed("query",[holdout[0]!.query]))[0]!;const profile={kind:"hybrid-v1" as const,embeddingRelease:release,queryVector:vector};
  expect(await retrieval.search({...scope,publicOnly:true},holdout[0]!.query,profile,db=>requireKnowledgeMember(db,owner))).toEqual([]);
  await expect(retrieval.search(scope,holdout[0]!.query,{...profile,embeddingRelease:"missing-profile"},db=>requireKnowledgeMember(db,owner))).rejects.toMatchObject({code:"RETRIEVAL_BACKEND_UNAVAILABLE"});
  const outsider=await platform.ensureAccount({issuer:account.issuer,subject:randomUUID(),email:"outside@example.test",displayName:"Other"});await expect(retrieval.search(scope,holdout[0]!.query,profile,db=>requireKnowledgeMember(db,{...owner,accountId:outsider.id}))).rejects.toMatchObject({code:"ACCESS_DENIED"});
  const filtered=await retrieval.search({...scope,sourceRevisionIds:[]},holdout[0]!.query,profile,db=>requireKnowledgeMember(db,owner));expect(filtered).toEqual([]);
 },15_000);
 it("measures full query embedding plus eligible hybrid search and replays its private durable result",async()=>{
  const samples=process.env.AGENTS_RETRIEVAL_BENCHMARK==="1"?20:3;
  for(let index=0;index<samples;index++){
   const query=holdout[index%11]!.query,{taskId,operationId}=await operation(query),input={taskId,operationId,profileRelease:release,query};
   const started=performance.now(),result=index===0?await Promise.all([queries.embed(input),queries.embed(input)]).then(values=>{expect(values[0]).toEqual(values[1]);return values[0]!;}):await queries.embed(input);const hits=await retrieval.search(scope,query,{kind:"hybrid-v1",embeddingRelease:release,queryVector:result.vector},db=>requireKnowledgeMember(db,owner));timings.push(performance.now()-started);expect(hits.length).toBeGreaterThan(0);
   expect(await new QueryEmbeddingService(pool,queries.objects,runtime).embed(input)).toEqual(result);expect((await pool.query("SELECT state FROM agents_platform.query_embedding_allocations WHERE operation_id=$1",[operationId])).rows[0].state).toBe("destroyed");
   await finishOperation(pool,taskId,operationId,"completed",{count:hits.length},null,0);await settleTask(pool,taskId,{state:"completed",output:"Search complete"});
  }
  const sorted=timings.toSorted((a,b)=>a-b);expect(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]).toBeLessThan(2000);
 },90_000);
 it("keeps uncertain cleanup charged, denies changed operation inputs and reaps the same allocation",async()=>{
  const query=holdout[0]!.query,{taskId,operationId}=await operation(`  ${query}  `),input={taskId,operationId,profileRelease:release,query};
  await expect(queries.embed({...input,query:"Changed query"})).rejects.toMatchObject({code:"QUERY_OPERATION_CONFLICT"});
  const uncertain=new QueryEmbeddingService(pool,queries.objects,{start:runtime.start.bind(runtime),status:runtime.status.bind(runtime),result:runtime.result.bind(runtime),async destroy(id){return{allocationId:id,state:"destroying" as const};}});
  await expect(uncertain.embed(input)).rejects.toMatchObject({code:"DOCUMENT_CLEANUP_PENDING"});
  const retained=(await pool.query("SELECT * FROM agents_platform.query_embedding_allocations WHERE operation_id=$1",[operationId])).rows[0];expect(retained.state).toBe("completed");expect(retained.result_key).toBeTruthy();
  const blockedOperation=`tool:${taskId}:capacity`;
  await beginOperation(pool,taskId,{id:blockedOperation,kind:"tool",name:"knowledge.search",request:{query},reservedTokens:0,reservedMs:30000,retrySafe:true});
  const dummy=randomUUID();await pool.query(`INSERT INTO agents_platform.query_embedding_allocations(id,organization_id,task_id,operation_id,profile_release,input_digest,state,lease_expires_at)
   VALUES($1,$2,$3,$4,$5,$6,'admitted',now()+interval '30 seconds')`,[dummy,owner.organizationId,taskId,blockedOperation,release,"0".repeat(64)]);
  const third=`tool:${taskId}:third`;await beginOperation(pool,taskId,{id:third,kind:"tool",name:"knowledge.search",request:{query},reservedTokens:0,reservedMs:30000,retrySafe:true});
  await expect(queries.embed({...input,operationId:third})).rejects.toMatchObject({code:"PROVIDER_BUSY"});
  await queries.cleanup(dummy);const replay=await queries.embed(input);expect(replay.receipt.allocationId).toBe(retained.id);await queries.reap();
  expect((await pool.query("SELECT state FROM agents_platform.query_embedding_allocations WHERE id=$1",[retained.id])).rows[0].state).toBe("destroyed");
  await settleTask(pool,taskId,{state:"cancelled",errorCode:"TEST_COMPLETE"});
 },15_000);
 it("excludes actual cross-tenant nearest neighbors and applies fresh public/withdrawal policy",async()=>{
  const query=holdout[0]!.query,vector=(await embed("query",[query]))[0]!,profile={kind:"hybrid-v1" as const,embeddingRelease:release,queryVector:vector};
  const other=await platform.ensureAccount({issuer:account.issuer,subject:randomUUID(),email:"neighbor@example.test",displayName:"Other owner"}),org=await platform.createOrganization(other.id,"Other tenant"),otherScope={organizationId:org.id,accountId:other.id};
  const text=corpus[0]!.text,job=await knowledge.admitUpload(otherScope,{operationId:randomUUID(),title:"Other tenant private policy",contentType:"text/plain",content:Buffer.from(text),parserRelease:release,embeddingRelease:release});
  await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);const documentVector=(await embed("document",[text]))[0]!;
  await knowledge.publishExtraction(job.id,{text,chunks:[{id:randomUUID(),revisionId:job.revisionId,ordinal:0,start:0,end:text.length,page:1,section:null,text,digest:textDigest(text),tokens:30}],normalizerRelease:"fixture-v1",acquiredAt:new Date().toISOString(),embeddings:[documentVector]});
  await knowledge.setPolicy(otherScope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:job.revisionId});
  const adversarial={...scope,sourceRevisionIds:[job.revisionId,...scope.sourceRevisionIds.slice(0,19)]};const hits=await retrieval.search(adversarial,query,profile,db=>requireKnowledgeMember(db,owner));expect(hits.length).toBeGreaterThan(0);expect(hits.every(hit=>hit.sourceId!==job.sourceId)).toBe(true);
  const first=sources[0]!;await knowledge.setPolicy(owner,first.id,{operationId:randomUUID(),expectedGeneration:1,action:"visibility",visibility:"public"});
  expect((await retrieval.search({...scope,publicOnly:true},query,profile,db=>requireKnowledgeMember(db,owner))).some(hit=>hit.sourceId===first.id)).toBe(true);
  await knowledge.setPolicy(owner,first.id,{operationId:randomUUID(),expectedGeneration:2,action:"visibility",visibility:"private"});expect(await retrieval.search({...scope,publicOnly:true},query,profile,db=>requireKnowledgeMember(db,owner))).toEqual([]);
  await knowledge.setPolicy(owner,first.id,{operationId:randomUUID(),expectedGeneration:3,action:"withdraw"});expect((await retrieval.search(scope,query,profile,db=>requireKnowledgeMember(db,owner))).every(hit=>hit.sourceId!==first.id)).toBe(true);
 },15_000);
});
