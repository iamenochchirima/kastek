import {dropClosedTestDatabase} from "./support/database-cleanup";
import {connectFixtureModel} from "./model-fixture";
import {collectNativeMetrics} from "../src/observability/metrics";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {connectedModelView} from "../src/capabilities/connected-tools/connected-model-view";
import {ConnectedExecutor} from "../src/capabilities/connected-tools/connected-executor";
import {EvidenceStore,assertCurrentEvidence} from "../src/execution/context/evidence";
import {PlatformStore} from "../src/product/agents/store";
import {ConnectionStore} from "../src/product/connections/connections";
import {ConnectionVault} from "../src/infrastructure/vault";
import {setupPlatformSchema} from "../src/composition/setup";
import {defaultBusinessConfiguration,requestDigest,type ExecutionGrant} from "../src/contracts/contracts";
import {admitChildren} from "../src/execution/delegation/delegation";
import {beginOperation,finishOperation,settleTask,loadExecution} from "../src/execution/lifecycle/execution";
import type {CapabilityBinding} from "../src/contracts/capability-catalog";
import {assertConnectedBindingDependencies,connectedModelArguments,connectedModelTool} from "../src/capabilities/connected-tools/connected-tool-schema";
import {readGithubJourneyScopes} from "./support/github-journey-scopes";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("registered connected executor with actual PostgreSQL, HTTP and private fixture objects",()=>{
 let admin:Pool,pool:Pool,server:Server,platform:PlatformStore,connections:ConnectionStore,executor:ConnectedExecutor,evidence:EvidenceStore;
 let origin:string,requests:string[]=[],isPrivate=false,hang=false,treeFileCount=1;
 let repositoryGate:(()=>Promise<void>)|undefined;
 let remoteResult:Record<string,unknown>|undefined,publicProfile=false;
 let authorizationHeaders:(string|undefined)[]=[];
 const remoteArguments:Record<string,unknown>[]=[];
 const database=`agents_connected_exec_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>();
 const text="Public immutable source content. "+"😀".repeat(1000)+"x".repeat(5000)+" Decisive tail fact.",bytes=Buffer.from(text),blobSha=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),commit="a".repeat(40),tree="b".repeat(40);
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
  server=createServer(async(req,res)=>{requests.push(req.url!);authorizationHeaders.push(req.headers.authorization);res.setHeader("content-type","application/json");
   if(req.url==="/mcp"){
    let serialized="";for await(const chunk of req)serialized+=chunk;const message=JSON.parse(serialized),reply=(result:unknown)=>res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if(message.method==="server/discover")res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Legacy endpoint"}}));
    else if(message.method==="initialize")reply({protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"github-contract-fixture",version:"1"}});
    else if(message.method==="notifications/initialized")res.writeHead(202).end();
    else if(message.method==="tools/list"&&publicProfile)reply({tools:[{name:"read_wiki_structure",description:"Read public repository documentation structure",inputSchema:{type:"object",properties:{repoName:{type:"string"}},required:["repoName"],additionalProperties:false}}]});
    else if(message.method==="tools/list")reply({tools:[{name:"get_file_contents",description:"Read approved file",inputSchema:{type:"object",properties:{owner:{type:"string"},repo:{type:"string"},path:{type:"string"},ref:{type:"string"}},required:["owner","repo","path","ref"],additionalProperties:false}}]});
    else if(message.method==="tools/call"){remoteArguments.push(message.params.arguments);reply(remoteResult??(publicProfile?{content:[{type:"text",text:"Available pages for approved/public: Architecture, Execution, Recovery."}]}:undefined)??{content:[{type:"text",text:`successfully downloaded text file (SHA: ${blobSha})`},{type:"resource",resource:{uri:`repo://approved/public/sha/${commit}/contents/guide.md`,mimeType:"text/plain; charset=utf-8",text}}]});}else res.writeHead(400).end("{}");return;
   }

   if(req.url==="/repos/approved/public"){await repositoryGate?.();res.end(JSON.stringify({id:1,private:isPrivate,visibility:isPrivate?"private":"public",full_name:"approved/public",description:"Public fixture",default_branch:"main",updated_at:"2026-10-17T00:00:00Z",stargazers_count:1,extra:"Retain full provider body"}));}
   else if(req.url==="/repos/approved/public/commits/main")res.end(JSON.stringify({sha:commit,commit:{tree:{sha:tree}}}));
   else if(req.url===`/repos/approved/public/git/trees/${tree}?recursive=1`)res.end(JSON.stringify({sha:tree,truncated:false,tree:Array.from({length:treeFileCount},(_,index)=>({path:index===treeFileCount-1?"guide.md":`docs/other-${String(index).padStart(2,"0")}.md`,type:"blob",mode:"100644",sha:blobSha,size:bytes.length}))}));
   else if(req.url===`/repos/approved/public/git/blobs/${blobSha}`){if(hang)return;res.end(JSON.stringify({sha:blobSha,encoding:"base64",size:bytes.length,content:bytes.toString("base64")}));}
   else res.writeHead(404).end("{}");
  });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("Missing private fixture object");return value;},async delete(key:string){objects.delete(key);}};
  connections=new ConnectionStore(pool,new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),[]);evidence=new EvidenceStore(pool,storage);executor=new ConnectedExecutor(pool,connections,storage,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`,testPublicMcpEndpoint:`${origin}/mcp`});
 });
 afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(withMcp=false,anonymous=false){
  isPrivate=false;hang=false;treeFileCount=1;requests=[];authorizationHeaders=[];remoteArguments.length=0;remoteResult=undefined;publicProfile=anonymous;
  const account=await platform.ensureAccount({issuer:"http://localhost/connected-executor",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(account.id,"Connected"),scope={accountId:account.id,organizationId:org.id};
  await connectFixtureModel(pool,account.id,org.id);
  const connection=await connections.create(scope,{operationId:randomUUID(),name:"GitHub",profileId:anonymous?"public-repository-read-v1":"github-public-read-v1",targetId:anonymous?"provider:public-repository":"provider:github",...(anonymous?{}:{apiKey:"github_pat_connected_fixture_only"}),expiresAt:new Date(Date.now()+86400000).toISOString(),selections:[{owner:"approved",repository:"public",ref:"main"}]});
  const catalog=await executor.discover(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,transport:"native_http"});
  const bindings=await executor.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,catalogId:catalog.id,selections:["get_repository","resolve_ref","list_tree","read_file"].map(providerOperation=>({providerOperation,resources:connection.resources}))});
  if(withMcp){
   const remote=await executor.discover(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,transport:"mcp_http"});
   bindings.push(...await executor.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,catalogId:remote.id,selections:[{providerOperation:anonymous?"read_wiki_structure":"get_file_contents",resources:connection.resources}]}));
  }
  const configuration={...defaultBusinessConfiguration(),connectedToolBindingIds:bindings.map(binding=>binding.id)},agent=await platform.createAgent({...scope,name:"Research",configuration}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","connected.read"],sourceRevisionIds:[],connectedToolBindingIds:bindings.map(binding=>binding.id),maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};await platform.createGrant({accountId:account.id,grant});
  const{task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Read approved public sources"});
  return{scope,connection,bindings,task,grant};
 }
 async function call(f:Awaited<ReturnType<typeof fixture>>,name:string,args:object){const binding=f.bindings.find(b=>b.definition.providerOperation===name)!,operationId=`tool:${f.task.id}:${randomUUID()}`;await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:30000,retrySafe:true});return{result:await executor.execute(f.task.id,operationId,binding,args),binding,operationId,args};}
 async function completedCall(f:Awaited<ReturnType<typeof fixture>>,name:string,args:object){const result=await call(f,name,args);await finishOperation(pool,f.task.id,result.operationId,"completed",result.result,null,0);return result;}
 it("releases the only pool connection during two independent provider reads and rejects duplicate live claims",async()=>{
  const first=await fixture(),second=await fixture(),binding=first.bindings.find(item=>item.definition.providerOperation==="get_repository")!,otherBinding=second.bindings.find(item=>item.definition.providerOperation==="get_repository")!,args={repository:"approved/public"};
  const operationId=`tool:${first.task.id}:single-pool`,otherOperation=`tool:${second.task.id}:single-pool`;
  for(const [f,b,id]of [[first,binding,operationId],[second,otherBinding,otherOperation]] as const)await beginOperation(pool,f.task.id,{id,kind:"tool",name:b.alias,request:args,reservedTokens:0,reservedMs:30000,retrySafe:true});
  let release!:()=>void,arrived!:()=>void,count=0;const barrier=new Promise<void>(resolve=>{release=resolve;}),both=new Promise<void>(resolve=>{arrived=resolve;});
  repositoryGate=async()=>{if(++count===2)arrived();await barrier;};
  const narrow=new Pool({connectionString:pool.options.connectionString,max:1,connectionTimeoutMillis:2000}),singleExecutor=new ConnectedExecutor(narrow,connections,executor.objects,new EvidenceStore(narrow,executor.objects),{testGithubOrigin:origin});
  const reads=[singleExecutor.execute(first.task.id,operationId,binding,args),singleExecutor.execute(second.task.id,otherOperation,otherBinding,args)];
  try{
   await Promise.race([both,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("Independent reads did not both reach provider with pool max 1")),5000).unref())]);
   expect(narrow.totalCount).toBe(1);expect(narrow.waitingCount).toBe(0);
   const before=(await pool.query("SELECT claim_token,claim_expires_at FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0];
   await expect(singleExecutor.execute(first.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_IN_PROGRESS"});
   expect((await pool.query("SELECT claim_token,claim_expires_at FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0]).toEqual(before);
   expect(requests).toEqual(["/repos/approved/public","/repos/approved/public"]);
  }finally{repositoryGate=undefined;release();await Promise.allSettled(reads);await narrow.end();}
  const results=await Promise.all(reads);expect(results.every(result=>result.status==="ok")).toBe(true);
  expect(requests).toHaveLength(2);
 });
 it("keeps original claim identity immutable and expired work uncertain without publishing a late result",async()=>{
  const f=await fixture(),binding=f.bindings.find(item=>item.definition.providerOperation==="get_repository")!,operationId=`tool:${f.task.id}:claim-expiry`,args={repository:"approved/public"};
  let entered!:()=>void,release!:()=>void;const inPut=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const storage={put:async(key:string,value:Uint8Array,type:string)=>{entered();await gate;await executor.objects.put(key,value,type);},get:executor.objects.get.bind(executor.objects),delete:executor.objects.delete.bind(executor.objects)};
  const blocked=new ConnectedExecutor(pool,connections,storage,evidence,{testGithubOrigin:origin});
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:500,retrySafe:true});
  const read=blocked.execute(f.task.id,operationId,binding,args);const outcome=read.then(value=>({value}),error=>({error}));
  try{
   await inPut;
   const claim=(await pool.query("SELECT c.claim_token,c.claim_expires_at,o.started_at,o.reserved_ms,t.deadline_at FROM agents_platform.connected_reads c JOIN agents_platform.operations o ON o.id=c.operation_id JOIN agents_platform.tasks t ON t.id=c.task_id WHERE c.operation_id=$1",[operationId])).rows[0];
   expect(claim.claim_token).toMatch(/^[a-f0-9-]{36}$/);expect(claim.claim_expires_at.getTime()).toBe(Math.min(claim.started_at.getTime()+500,claim.deadline_at.getTime()));
   for(const sql of ["claim_token=gen_random_uuid()","claim_expires_at=claim_expires_at+interval '1 second'","request_digest='changed'"])await expect(pool.query(`UPDATE agents_platform.connected_reads SET ${sql} WHERE operation_id=$1`,[operationId])).rejects.toThrow("connected claim identity is immutable");
   await pool.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM($1::timestamptz-clock_timestamp())))+0.02)",[claim.claim_expires_at]);
   await expect(executor.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});
   expect((await pool.query("SELECT state,result FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0]).toEqual({state:"uncertain",result:null});
  }finally{release();}
  expect(await outcome).toMatchObject({error:{code:"CONNECTED_READ_UNCERTAIN"}});
  expect(requests).toEqual(["/repos/approved/public"]);
  expect((await pool.query("SELECT state,result FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0]).toEqual({state:"uncertain",result:null});
  expect((await pool.query("SELECT * FROM agents_platform.connected_response_bodies WHERE operation_id=$1",[operationId])).rows).toEqual([]);
  expect((await pool.query("SELECT state,receipt FROM agents_platform.connected_attempts WHERE operation_id=$1",[operationId])).rows).toMatchObject([{state:"completed",receipt:{status:200}}]);
  await expect(executor.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});
 });
 it("marks an orphan started receipt with no claim uncertain without contacting the provider",async()=>{
  const f=await fixture(),binding=f.bindings.find(item=>item.definition.providerOperation==="get_repository")!,operationId=`tool:${f.task.id}:orphan-claim`,args={repository:"approved/public"};
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:30000,retrySafe:true});
  await pool.query("INSERT INTO agents_platform.connected_reads(operation_id,task_id,organization_id,root_task_id,connection_id,binding_id,request_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,'started')",[operationId,f.task.id,f.scope.organizationId,f.task.root_task_id,f.connection.id,binding.id,requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args})]);
  await expect(executor.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});
  expect(requests).toEqual([]);expect((await pool.query("SELECT state,claim_token,claim_expires_at FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0]).toEqual({state:"uncertain",claim_token:null,claim_expires_at:null});
 });
 it("coalesces actual receipts from two legacy profiles into one bounded provider metric series",async()=>{
  const before=(await collectNativeMetrics(pool,"test")).filter(point=>point.name==="agents.connected.provider.attempts"&&point.attributes.provider==="other"&&point.attributes.phase==="read"&&point.attributes.outcome==="response").reduce((sum,point)=>sum+point.value,0);
  const keyed=await fixture();await call(keyed,"get_repository",{repository:"approved/public"});
  const anonymous=await fixture(false,true);await call(anonymous,"get_repository",{repository:"approved/public"});
  const points=(await collectNativeMetrics(pool,"test")).filter(point=>point.name.startsWith("agents.connected.provider.")&&point.attributes.provider==="other");
  const attempts=points.filter(point=>point.name==="agents.connected.provider.attempts"&&point.attributes.phase==="read"&&point.attributes.outcome==="response");
  expect(attempts).toHaveLength(1);expect(attempts[0]!.value).toBe(before+2);
  expect(points.filter(point=>point.name==="agents.connected.provider.latency_p95_ms"&&point.attributes.phase==="read")).toHaveLength(1);
  expect(JSON.stringify(points)).not.toContain(keyed.connection.id);expect(JSON.stringify(points)).not.toContain(anonymous.connection.id);
 });
 it("executes anonymous native and MCP reads without transmitting any authorization header",async()=>{
  const f=await fixture(true,true);expect(f.connection.authentication).toBe("none");
  const metadata=await call(f,"get_repository",{repository:"approved/public"});expect(metadata.result.status).toBe("ok");
  const remote=await call(f,"read_wiki_structure",{repository:"approved/public"});expect(remote.result.content).toContain("Available pages");expect(remote.result.observation.provenance).toMatchObject({kind:"timestamped_observation",provider:"deepwiki",repository:"approved/public"});
  expect(remoteArguments.at(-1)).toEqual({repoName:"approved/public"});expect(authorizationHeaders.every(header=>header===undefined)).toBe(true);
  const count=requests.length;expect(await executor.execute(f.task.id,remote.operationId,remote.binding,remote.args)).toEqual(remote.result);expect(requests).toHaveLength(count);
 },30000);
 it("denies public MCP private queries and native-to-private repository reads",async()=>{
  const f=await fixture(true,true),binding=f.bindings.find(binding=>binding.definition.providerOperation==="read_wiki_structure")!,before=requests.length;
  await expect(executor.execute(f.task.id,randomUUID(),binding,{repository:"approved/public",question:"private knowledge"})).rejects.toThrow();expect(requests).toHaveLength(before);
  isPrivate=true;await expect(call(f,"read_wiki_structure",{repository:"approved/public"})).rejects.toThrow();expect(remoteArguments).toHaveLength(0);
 },30000);
 it("uses safe wrappers, immutable commit/file handles, bounded tail reads and private full response receipts",async()=>{
  const f=await fixture();expect(requests).toHaveLength(0);
  for(const binding of f.bindings){expect(connectedModelTool(binding).function.parameters.additionalProperties).toBe(false);expect(()=>connectedModelArguments(binding,{url:"https://private.test",path:"evil",repository:"approved/public"})).toThrow();}
  const revision=await call(f,"resolve_ref",{repository:"approved/public"}),revisionId=(revision.result.handles as any).revisionId;
  const listing=await call(f,"list_tree",{revisionId}),fileId=(listing.result.handles as any).files[0].fileId;
  const file=await call(f,"read_file",{fileId,offset:5000});expect(file.result.content).toContain("Decisive tail fact");expect(Buffer.byteLength(JSON.stringify(file.result))).toBeLessThanOrEqual(8192);
  expect(requests.filter(path=>path.includes("/commits/"))).toEqual(["/repos/approved/public/commits/main"]);expect(requests.some(path=>path.includes(blobSha))).toBe(true);
  const saved=await pool.query("SELECT * FROM agents_platform.connected_response_bodies WHERE operation_id=$1 ORDER BY ordinal",[file.operationId]);expect(saved.rowCount).toBe(2);expect(Buffer.from(objects.get(saved.rows[0].object_key)!).toString()).toContain("Retain full provider body");
  expect((await pool.query("SELECT count(*) AS count FROM agents_platform.connected_attempts WHERE operation_id=$1",[file.operationId])).rows[0].count).toBe("2");
  const fresh=new ConnectedExecutor(pool,connections,executor.objects,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`,testPublicMcpEndpoint:`${origin}/mcp`});
  const resolve=vi.spyOn(fresh.registry,"resolve").mockImplementation(()=>{throw Error("fixture old adapter release absent");});
  const before=requests.length;expect(await fresh.execute(f.task.id,file.operationId,file.binding,file.args)).toEqual(file.result);expect(requests).toHaveLength(before);expect(resolve).not.toHaveBeenCalled();
 });
 it("filters an exact known file locally while preserving unfiltered pagination and immutable file proof",async()=>{
  const f=await fixture(),revision=await completedCall(f,"resolve_ref",{repository:"approved/public"}),revisionId=(revision.result.handles as any).revisionId;treeFileCount=41;
  const first=await completedCall(f,"list_tree",{revisionId}),firstPage=JSON.parse(first.result.content),second=await completedCall(f,"list_tree",{revisionId,offset:firstPage.nextOffset}),secondPage=JSON.parse(second.result.content);
  expect(firstPage.files).toHaveLength(20);expect(firstPage).toMatchObject({hasMore:true,nextOffset:20});expect(firstPage).not.toHaveProperty("filePath");expect(secondPage.files).toHaveLength(20);expect(secondPage).toMatchObject({hasMore:true,nextOffset:40});expect(firstPage.files.some((file:any)=>file.path==="guide.md")).toBe(false);
  const before=requests.length,filtered=await completedCall(f,"list_tree",{revisionId,filePath:"guide.md"}),view=JSON.parse(filtered.result.content);
  expect(requests.slice(before)).toEqual(["/repos/approved/public",`/repos/approved/public/git/trees/${tree}?recursive=1`]);
  expect(view).toMatchObject({filePath:"guide.md",files:[{path:"guide.md",bytes:bytes.length}],hasMore:false,nextOffset:1});expect(view.files).toHaveLength(1);
  const handle=(await pool.query("SELECT payload FROM agents_platform.connected_handles WHERE created_by_operation=$1 AND kind='file'",[filtered.operationId])).rows;
  expect(handle).toHaveLength(1);expect(handle[0].payload).toMatchObject({revision:{commitSha:commit},file:{path:"guide.md",blobSha}});
  const receipt=(await pool.query("SELECT object_key FROM agents_platform.connected_response_bodies WHERE operation_id=$1 ORDER BY ordinal DESC LIMIT 1",[filtered.operationId])).rows[0];
  const saved=JSON.parse(Buffer.from(objects.get(receipt.object_key)!).toString());expect(saved.tree).toHaveLength(41);expect(saved.tree[0].path).toBe("docs/other-00.md");
  const replayCount=requests.length;expect(await executor.execute(f.task.id,filtered.operationId,filtered.binding,filtered.args)).toEqual(filtered.result);
  await expect(executor.execute(f.task.id,filtered.operationId,filtered.binding,{revisionId,filePath:"docs/other-00.md"})).rejects.toMatchObject({code:"OPERATION_CONFLICT"});expect(requests).toHaveLength(replayCount);

  const read=await completedCall(f,"read_file",{fileId:view.files[0].fileId,offset:5000});expect(read.result.content).toContain("Decisive tail fact");expect(read.result.observation.provenance).toEqual({kind:"commit_snapshot",commitSha:commit});
  const missing=await completedCall(f,"list_tree",{revisionId,filePath:"docs/does-not-exist.md"});expect(JSON.parse(missing.result.content)).toMatchObject({filePath:"docs/does-not-exist.md",files:[],hasMore:false,nextOffset:0});expect(missing.result.handles).toEqual({files:[]});expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.connected_handles WHERE created_by_operation=$1 AND kind='file'",[missing.operationId])).rows[0].count).toBe(0);
  expect(requests.some(path=>path.includes("filePath")||path.includes("guide.md")||path.includes("does-not-exist"))).toBe(false);
 });
 it("selects a bounded UTF8-safe byte span locally after verifying the entire immutable blob",async()=>{
  const f=await fixture(),revision=await completedCall(f,"resolve_ref",{repository:"approved/public"}),listing=await completedCall(f,"list_tree",{revisionId:(revision.result.handles as any).revisionId,filePath:"guide.md"}),fileId=(listing.result.handles as any).files[0].fileId,before=requests.length;
  const selected=await completedCall(f,"read_file",{fileId,maxBytes:512}),expected=new TextDecoder().decode(bytes.subarray(0,512),{stream:true});
  expect(selected.result.content).toBe(expected);expect(Buffer.byteLength(selected.result.content)).toBeLessThanOrEqual(512);expect(selected.result.content.endsWith("😀")).toBe(true);expect(selected.result.truncated).toBe(true);expect(Buffer.from(selected.result.content).toString("utf8")).toBe(selected.result.content);expect(selected.result.observation.provenance).toEqual({kind:"commit_snapshot",commitSha:commit});
  expect(requests.slice(before)).toEqual(["/repos/approved/public",`/repos/approved/public/git/blobs/${blobSha}`]);
  const receipt=(await pool.query("SELECT object_key FROM agents_platform.connected_response_bodies WHERE operation_id=$1 ORDER BY ordinal DESC LIMIT 1",[selected.operationId])).rows[0],raw=JSON.parse(Buffer.from(objects.get(receipt.object_key)!).toString());
  expect(Buffer.from(raw.content,"base64").equals(bytes)).toBe(true);expect(raw.sha).toBe(blobSha);expect((await evidence.readPassage(f.task.id,selected.result.evidence.id)).text).toBe(expected);
  const defaultRead=await completedCall(f,"read_file",{fileId});expect(defaultRead.result.content).toBe(new TextDecoder().decode(bytes.subarray(0,4096),{stream:true}));expect(Buffer.byteLength(defaultRead.result.content)).toBeGreaterThan(512);
  const next=await completedCall(f,"read_file",{fileId,offset:selected.result.content.length,maxBytes:128});expect(next.result.content).toBe(new TextDecoder().decode(Buffer.from(text.slice(selected.result.content.length)).subarray(0,128),{stream:true}));
  await expect(call(f,"read_file",{fileId,offset:text.indexOf("😀")+1,maxBytes:128})).rejects.toMatchObject({code:"CONNECTED_TEXT_BOUNDARY"});
 });
 it("rejects empty or unbounded exact-path filters and filePath on another operation before network",async()=>{
  const f=await fixture(),list=f.bindings.find(binding=>binding.definition.providerOperation==="list_tree")!,metadata=f.bindings.find(binding=>binding.definition.providerOperation==="get_repository")!,revisionId=randomUUID(),before=requests.length;
  const schema=connectedModelTool(list).function.parameters as any;expect(schema.properties.filePath).toEqual({type:"string",minLength:1,maxLength:1024});
  for(const filePath of ["","x".repeat(1025),4,null])await expect(executor.execute(f.task.id,randomUUID(),list,{revisionId,filePath})).rejects.toThrow();
  await expect(executor.execute(f.task.id,randomUUID(),metadata,{repository:"approved/public",filePath:"guide.md"})).rejects.toThrow();
  const read=f.bindings.find(binding=>binding.definition.providerOperation==="read_file")!;
  for(const maxBytes of [127,4097,128.5,"512",null])await expect(executor.execute(f.task.id,randomUUID(),read,{fileId:randomUUID(),maxBytes})).rejects.toThrow();
  await expect(executor.execute(f.task.id,randomUUID(),list,{revisionId,maxBytes:512})).rejects.toThrow();expect(requests).toHaveLength(before);
 });
 it("keeps full receipts replayable while model projections preserve handles and obey current evidence policy",async()=>{
  const f=await fixture(),revision=await call(f,"resolve_ref",{repository:"approved/public"}),listing=await call(f,"list_tree",{revisionId:(revision.result.handles as any).revisionId});
  const full=JSON.stringify(listing.result),view=connectedModelView(listing.result),fileId=JSON.parse(view.content).files[0].fileId;
  expect(view).not.toHaveProperty("handles");expect(JSON.stringify(view).length).toBeLessThan(full.length-100);expect(view.content).toBe(listing.result.content);expect(fileId).toBe((listing.result.handles as any).files[0].fileId);
  const file=await call(f,"read_file",{fileId}),model=connectedModelView(file.result);
  expect(model.content).toBe(file.result.content);expect(model.evidence).toEqual({id:file.result.evidence.id,citation:file.result.evidence.citation});expect(model.observation.provenance).toEqual(file.result.observation.provenance);
  const manifest=(await pool.query("SELECT manifest FROM agents_platform.evidence_references WHERE id=$1",[model.evidence.id])).rows[0].manifest;
  await assertCurrentEvidence(pool,f.task.id,manifest);
  const before=(await pool.query("SELECT state,body_digest,result FROM agents_platform.connected_reads WHERE operation_id=$1",[file.operationId])).rows[0],count=requests.length;
  await connections.mutate(f.scope,f.connection.id,{operationId:randomUUID(),expectedRevision:1},"revoke");
  const fresh=new ConnectedExecutor(pool,connections,executor.objects,evidence,{testGithubOrigin:origin});
  const resolve=vi.spyOn(fresh.registry,"resolve").mockImplementation(()=>{throw Error("Old adapter absent");});
  expect(await fresh.execute(f.task.id,file.operationId,file.binding,file.args)).toEqual(file.result);expect(resolve).not.toHaveBeenCalled();expect(requests).toHaveLength(count);
  expect((await pool.query("SELECT state,body_digest,result FROM agents_platform.connected_reads WHERE operation_id=$1",[file.operationId])).rows[0]).toEqual(before);
  await expect(assertCurrentEvidence(pool,f.task.id,manifest)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 });
 it("rejects cross-root handles and stops private resources after their metadata check",async()=>{
  const first=await fixture(),revision=await call(first,"resolve_ref",{repository:"approved/public"}),other=await fixture();
  await expect(call(other,"list_tree",{revisionId:(revision.result.handles as any).revisionId})).rejects.toMatchObject({code:"CONNECTED_SCOPE_DENIED"});expect(requests).toHaveLength(0);
  isPrivate=true;await expect(call(other,"resolve_ref",{repository:"approved/public"})).rejects.toMatchObject({code:"REPOSITORY_NOT_PUBLIC"});expect(requests).toEqual(["/repos/approved/public"]);
 });
 it("retains uncertain physical work across a fresh executor without repeating the remote read",async()=>{
  const f=await fixture(),revision=await call(f,"resolve_ref",{repository:"approved/public"}),listing=await call(f,"list_tree",{revisionId:(revision.result.handles as any).revisionId}),fileId=(listing.result.handles as any).files[0].fileId;
  const binding=f.bindings.find(b=>b.definition.providerOperation==="read_file")!,operationId=`tool:${f.task.id}:lost`,args={fileId};await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:1000,retrySafe:true});
  hang=true;const controller=new AbortController(),pending=executor.execute(f.task.id,operationId,binding,args,controller.signal);const timer=setInterval(()=>{if(requests.at(-1)?.includes("/git/blobs/"))controller.abort();},10);
  try{await expect(pending).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});}finally{clearInterval(timer);}const count=requests.length;
  const fresh=new ConnectedExecutor(pool,connections,executor.objects,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`,testPublicMcpEndpoint:`${origin}/mcp`});
  await expect(fresh.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});expect(requests).toHaveLength(count);
 });
 it("uses the original operation deadline through private receipt publication and charges actual overrun",async()=>{
  const f=await fixture(),binding=f.bindings.find(binding=>binding.definition.providerOperation==="get_repository")!,operationId=`tool:${f.task.id}:slow-storage`,args={repository:"approved/public"};
  const slow={...executor.objects,put:async(key:string,value:Uint8Array,type:string)=>{await new Promise(done=>setTimeout(done,160));await executor.objects.put(key,value,type);},get:executor.objects.get.bind(executor.objects),delete:executor.objects.delete.bind(executor.objects)};
  const bounded=new ConnectedExecutor(pool,connections,slow,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`,testPublicMcpEndpoint:`${origin}/mcp`});
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:100,retrySafe:true});
  await expect(bounded.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});
  expect(requests).toEqual(["/repos/approved/public"]);
  expect((await pool.query("SELECT state,result FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0]).toMatchObject({state:"uncertain",result:null});
  await finishOperation(pool,f.task.id,operationId,"uncertain",null,"CONNECTED_READ_UNCERTAIN",0);
  expect(Number((await pool.query("SELECT active_ms FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0].active_ms)).toBeGreaterThanOrEqual(160);
  const before=requests.length;await expect(bounded.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});expect(requests).toHaveLength(before);
 });
 it("does not publish a late private response link after its grant is revoked during PUT",async()=>{
  const f=await fixture(),binding=f.bindings.find(binding=>binding.definition.providerOperation==="get_repository")!,operationId=`tool:${f.task.id}:revoked-body`,args={repository:"approved/public"};
  const blocked={...executor.objects,put:async(key:string,value:Uint8Array,type:string)=>{await executor.objects.put(key,value,type);await platform.revokeGrant(f.scope.accountId,f.scope.organizationId,f.grant.id);},get:executor.objects.get.bind(executor.objects),delete:executor.objects.delete.bind(executor.objects)};
  const scoped=new ConnectedExecutor(pool,connections,blocked,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`,testPublicMcpEndpoint:`${origin}/mcp`});
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:30000,retrySafe:true});
  await expect(scoped.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"GRANT_REVOKED"});
  expect((await pool.query("SELECT * FROM agents_platform.connected_response_bodies WHERE operation_id=$1",[operationId])).rows).toEqual([]);
  const tracked=(await pool.query("SELECT state FROM agents_platform.execution_objects WHERE operation_id=$1",[operationId])).rows;expect(tracked).toHaveLength(1);expect(tracked[0]?.state).toBe("available");
  expect((await pool.query("SELECT result FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0].result).toBeNull();
 });
 it("requires explicit native handle producers for MCP tools on each selected resource",async()=>{
  const f=await fixture(),native=f.bindings.find(binding=>binding.definition.providerOperation==="resolve_ref")!;
  const remote={...native,transport:"mcp_http",definition:{...native.definition,providerOperation:"get_file_contents"}} as CapabilityBinding;
  expect(()=>assertConnectedBindingDependencies([remote,native])).toThrow("Select native list_tree");
  expect(()=>assertConnectedBindingDependencies([remote,...f.bindings])).not.toThrow();
 });
 it("routes actual SDK MCP calls through approved file handles with one metadata read and two MCP read messages",async()=>{
  const f=await fixture(true),revision=await call(f,"resolve_ref",{repository:"approved/public"}),listing=await call(f,"list_tree",{revisionId:(revision.result.handles as any).revisionId});
  const fileId=(listing.result.handles as any).files[0].fileId,remote=await call(f,"get_file_contents",{fileId,offset:5000});
  expect(remote.result.content).toContain("Decisive tail fact");expect(remoteArguments.at(-1)).toEqual({owner:"approved",repo:"public",path:"guide.md",ref:commit});
  const attempts=(await pool.query("SELECT phase,state FROM agents_platform.connected_attempts WHERE operation_id=$1 ORDER BY ordinal",[remote.operationId])).rows;
  expect(attempts.filter(row=>row.phase==="read")).toHaveLength(3);expect(attempts.length).toBeLessThanOrEqual(7);expect(attempts.every(row=>row.state==="completed")).toBe(true);
  const before=requests.length;expect(await executor.execute(f.task.id,remote.operationId,remote.binding,remote.args)).toEqual(remote.result);expect(requests).toHaveLength(before);
  const snapshot=`context:${f.task.id}:0`,payload={messages:[{role:"tool",content:JSON.stringify(remote.result)}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,f.task.id,requestDigest(payload),payload]);await evidence.supplyContext(f.task.id,snapshot,[remote.result.evidence.id]);
  expect((await evidence.validateCitations(f.task.id,`Fact ${remote.result.evidence.citation}`))[0]?.text).toContain("Decisive tail fact");
  expect(remote.result.content).not.toContain("successfully downloaded");expect(remote.result.observation.provenance).toEqual({kind:"commit_snapshot",commitSha:commit});

 },20000);

 it("preserves declared MCP file error observations and current policy without retrying",async()=>{
  const f=await fixture(true),revision=await call(f,"resolve_ref",{repository:"approved/public"}),listing=await call(f,"list_tree",{revisionId:(revision.result.handles as any).revisionId}),fileId=(listing.result.handles as any).files[0].fileId;
  remoteResult={isError:true,content:[{type:"text",text:"file content unavailable"}]};
  const remote=await call(f,"get_file_contents",{fileId});expect(remote.result).toMatchObject({status:"tool_error",content:"file content unavailable"});expect(remote.result.observation.provenance).toEqual({kind:"timestamped_observation"});
  const passage=await evidence.readPassage(f.task.id,remote.result.evidence.id);expect(passage.title).toBe("GitHub get_file_contents error");expect(passage.reference.manifest.dependencies.some(dependency=>dependency.kind==="connection")).toBe(true);
  expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.evidence_references WHERE operation_id=$1",[remote.operationId])).rows[0].count).toBe(1);
  const before=requests.length;expect(await executor.execute(f.task.id,remote.operationId,remote.binding,remote.args)).toEqual(remote.result);expect(requests).toHaveLength(before);
  await connections.mutate(f.scope,f.connection.id,{operationId:randomUUID(),expectedRevision:1},"revoke");
  await expect(evidence.readPassage(f.task.id,remote.result.evidence.id)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
 },20000);
 it.each([
  ["foreign URI",{type:"resource",resource:{uri:"https://private.test/secret",mimeType:"text/plain",text}},"MCP_FILE_IDENTITY_MISMATCH"],
  ["different commit",{type:"resource",resource:{uri:`repo://approved/public/sha/${"c".repeat(40)}/contents/guide.md`,mimeType:"text/plain",text}},"MCP_FILE_IDENTITY_MISMATCH"],
  ["changed text",{type:"resource",resource:{uri:`repo://approved/public/sha/${commit}/contents/guide.md`,mimeType:"text/plain",text:text+"tampered"}},"MCP_FILE_CONTENT_MISMATCH"],
  ["link",{type:"resource_link",uri:"https://private.test/secret",name:"remote"},"MCP_FILE_LINK_UNSUPPORTED"],
  ["binary",{type:"resource",resource:{uri:`repo://approved/public/sha/${commit}/contents/guide.md`,mimeType:"application/octet-stream",blob:"c2VjcmV0"}},"MCP_FILE_BINARY_UNSUPPORTED"],
  ["status only",{type:"text",text:"successfully downloaded file"},"MCP_FILE_UNAVAILABLE"],
 ] as const)("rejects MCP %s without traversal or published evidence",async(_name,block,errorCode)=>{
  const f=await fixture(true),revision=await call(f,"resolve_ref",{repository:"approved/public"}),listing=await call(f,"list_tree",{revisionId:(revision.result.handles as any).revisionId}),fileId=(listing.result.handles as any).files[0].fileId;
  remoteResult={content:[{type:"text",text:"provider status"},block]};
  const before=requests.length;
  await expect(call(f,"get_file_contents",{fileId})).rejects.toMatchObject({code:errorCode});
  expect(requests.slice(before).every(path=>path==="/mcp"||path==="/repos/approved/public")).toBe(true);
  const binding=f.bindings.find(binding=>binding.definition.providerOperation==="get_file_contents")!,receipt=(await pool.query("SELECT operation_id,state,error_code FROM agents_platform.connected_reads WHERE task_id=$1 AND binding_id=$2",[f.task.id,binding.id])).rows[0];
  expect(receipt).toMatchObject({state:"failed",error_code:errorCode});const settledRequests=requests.length;
  await expect(executor.execute(f.task.id,receipt.operation_id,binding,{fileId})).rejects.toMatchObject({code:errorCode});expect(requests).toHaveLength(settledRequests);

  expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.evidence_references e JOIN agents_platform.operations o ON o.id=e.operation_id WHERE e.task_id=$1 AND o.name=$2",[f.task.id,f.bindings.find(binding=>binding.definition.providerOperation==="get_file_contents")!.alias])).rows[0].count).toBe(0);
 },20000);

 it("does not reissue an orphaned durable read claim and preserves its uncertainty receipt",async()=>{
  const f=await fixture(),binding=f.bindings.find(b=>b.definition.providerOperation==="get_repository")!,args={repository:"approved/public"},operationId=`tool:${f.task.id}:orphan`;
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:1000,retrySafe:true});
  await pool.query("INSERT INTO agents_platform.connected_reads(operation_id,task_id,organization_id,root_task_id,connection_id,binding_id,request_digest,state) VALUES($1,$2,$3,$2,$4,$5,$6,'started')",[operationId,f.task.id,f.scope.organizationId,f.connection.id,binding.id,requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args})]);
  await expect(executor.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});expect(requests).toHaveLength(0);
  await expect(pool.query("UPDATE agents_platform.connected_reads SET state='started' WHERE operation_id=$1",[operationId])).rejects.toThrow("immutable");
 });

 it("keeps delegated-only connected authority out of the coordinator while admitting and fencing actual child evidence",async()=>{
  const f=await fixture(),selected=f.bindings.find(binding=>binding.definition.providerOperation==="get_repository")!,other=f.bindings.find(binding=>binding.definition.providerOperation==="resolve_ref")!;
  const config=defaultBusinessConfiguration();config.tools=["agents.delegate"];config.connectedToolBindingIds=[];
  config.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"metadata",versionId:f.task.version_id,sourceRevisionIds:[],connectedToolBindingIds:[selected.id],tools:[],maxTokens:8000,maxActiveMs:120000},{id:"revision",versionId:f.task.version_id,sourceRevisionIds:[],connectedToolBindingIds:[other.id],tools:[],maxTokens:8000,maxActiveMs:120000}]};
  const agent=await platform.createAgent({...f.scope,name:"Delegated-only coordinator",configuration:config}),version=await platform.createVersion({...f.scope,agentId:agent.id,expectedRevision:1});
  const authority={...f.grant,resourceId:agent.id},grant:ExecutionGrant={...f.grant,resourceId:agent.id,id:randomUUID(),versionId:version.id,connectedToolBindingIds:[selected.id,other.id],operations:["model.reply","knowledge.read","connected.read","delegation.execute"]};
  await platform.createGrant({accountId:f.scope.accountId,grant});const{task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Delegate metadata and report the issued evidence"});
  expect((await loadExecution(pool,task.id)).connectedBindings).toEqual([]);
  const before=requests.length;await expect(executor.execute(task.id,randomUUID(),selected,{repository:"approved/public"})).rejects.toThrow();expect(requests).toHaveLength(before);
  const operationId=`delegate:${task.id}`,args={requests:[{bindingId:"metadata",brief:"Read metadata with your published capability"}]};
  await beginOperation(pool,task.id,{id:operationId,kind:"delegation",name:"agents.delegate",request:args,reservedTokens:0,reservedMs:0,retrySafe:true});
  await expect(evidence.recordConnected(task.id,operationId,{bindingId:selected.id,resource:selected.resources[0]!,text:"invented metadata",title:"Fake root read",acquiredAt:new Date().toISOString(),receiptDigest:"a".repeat(64)})).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  const[child]=await admitChildren(pool,task.id,operationId,args);const childTask=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[child!.taskId])).rows[0];
  expect((await loadExecution(pool,child!.taskId)).connectedBindings.map(binding=>binding.id)).toEqual([selected.id]);
  await expect(executor.execute(child!.taskId,randomUUID(),other,{repository:"approved/public"})).rejects.toThrow();expect(requests).toHaveLength(before);
  const read=await completedCall({...f,task:childTask},"get_repository",{repository:"approved/public"});const count=requests.length;
  expect(await executor.execute(child!.taskId,read.operationId,read.binding,read.args)).toEqual(read.result);expect(requests).toHaveLength(count);
  const evidenceId=read.result.evidence.id,citation=read.result.evidence.citation;
  await expect(evidence.readPassage(task.id,evidenceId)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  const reference=(await pool.query("SELECT manifest FROM agents_platform.evidence_references WHERE id=$1",[evidenceId])).rows[0];
  await expect(assertCurrentEvidence(pool,task.id,reference.manifest)).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  const snapshot=`context:${child!.taskId}:0`,payload={messages:[{role:"tool",content:JSON.stringify(read.result)}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,child!.taskId,requestDigest(payload),payload]);
  await evidence.supplyContext(child!.taskId,snapshot,[evidenceId]);await evidence.derive(child!.taskId,"child_result",child!.taskId);await settleTask(pool,child!.taskId,{state:"completed",output:`Confirmed metadata ${citation}`});
  await evidence.joinChildren(task.id,operationId);await finishOperation(pool,task.id,operationId,"completed",{children:[child]},null,0);
  expect((await evidence.readPassage(task.id,evidenceId)).text).toBe(read.result.content);expect((await evidence.validateCitations(task.id,`Report ${citation}`))[0]?.reference.id).toBe(evidenceId);
  expect(await evidence.suppliedEvidence(task.id,1)).toEqual({items:[{id:evidenceId,citation,operationId:read.operationId,kind:"connection"}],omittedCount:0});
  await evidence.derive(task.id,"artifact","coordinator-report");expect(requests).toHaveLength(count);
  await expect(executor.execute(task.id,randomUUID(),selected,{repository:"approved/public"})).rejects.toThrow();expect(requests).toHaveLength(count);
  await connections.mutate(f.scope,f.connection.id,{operationId:randomUUID(),expectedRevision:1,apiKey:"github_pat_rotated_delegated_fixture"},"rotate");
  expect((await evidence.validateCitations(task.id,`Report ${citation}`))[0]?.reference.id).toBe(evidenceId);
  await connections.mutate(f.scope,f.connection.id,{operationId:randomUUID(),expectedRevision:2},"revoke");
  await expect(evidence.derive(task.id,"artifact","revoked-report")).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await expect(evidence.validateCitations(task.id,`Report ${citation}`)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});await expect(evidence.suppliedEvidence(task.id)).rejects.toThrow();expect(requests).toHaveLength(count);
 },30000);

 it("inherits only explicit same-actor prior delegated turns under current roles and original live policy",async()=>{
  const f=await fixture(),selected=f.bindings.find(binding=>binding.definition.providerOperation==="get_repository")!;await settleTask(pool,f.task.id,{state:"cancelled"});
  const config=defaultBusinessConfiguration();config.tools=["agents.delegate"];config.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"metadata",versionId:f.task.version_id,sourceRevisionIds:[],connectedToolBindingIds:[selected.id],tools:[],maxTokens:8000,maxActiveMs:120000}]};
  const agent=await platform.createAgent({...f.scope,name:"History coordinator",configuration:config}),version=await platform.createVersion({...f.scope,agentId:agent.id,expectedRevision:1});
  const authority={...f.grant,resourceId:agent.id},grant:ExecutionGrant={...f.grant,resourceId:agent.id,id:randomUUID(),versionId:version.id,connectedToolBindingIds:[selected.id],operations:["model.reply","knowledge.read","connected.read","delegation.execute"]};await platform.createGrant({accountId:f.scope.accountId,grant});
  const{task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Read delegated metadata"}),operationId=`delegate:${task.id}`,args={requests:[{bindingId:"metadata",brief:"Read metadata"}]};
  await beginOperation(pool,task.id,{id:operationId,kind:"delegation",name:"agents.delegate",request:args,reservedTokens:0,reservedMs:0,retrySafe:true});const[child]=await admitChildren(pool,task.id,operationId,args),childTask=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[child!.taskId])).rows[0];
  const read=await completedCall({...f,task:childTask},"get_repository",{repository:"approved/public"}),evidenceId=read.result.evidence.id,citation=read.result.evidence.citation,payload={messages:[{role:"tool",content:JSON.stringify(read.result)}]},snapshot=`context:${child!.taskId}:0`;
  await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,child!.taskId,requestDigest(payload),payload]);await evidence.supplyContext(child!.taskId,snapshot,[evidenceId]);await evidence.derive(child!.taskId,"child_result",child!.taskId);await settleTask(pool,child!.taskId,{state:"completed",output:`Metadata ${citation}`});await evidence.joinChildren(task.id,operationId);await finishOperation(pool,task.id,operationId,"completed",{children:[child]},null,0);await settleTask(pool,task.id,{state:"completed",output:`Confirmed metadata ${citation}`});
  const nextGrant={...grant,id:randomUUID()};await platform.createGrant({accountId:f.scope.accountId,grant:nextGrant});const{task:next}=await platform.admitTask({authority,versionId:version.id,grantId:nextGrant.id,conversationId:task.conversation_id,requestKey:randomUUID(),input:"Use the previous confirmed result"});
  expect((await loadExecution(pool,next.id)).connectedBindings).toEqual([]);expect((await evidence.checkHistory(next.id,[task.id]))[0]?.eligible).toBe(true);
  const historyId=`context:${next.id}:0`,historyPayload={historyGroupIds:[task.id],messages:[{role:"assistant",content:`Confirmed metadata ${citation}`}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,1)",[historyId,next.id,requestDigest(historyPayload),historyPayload]);await evidence.inheritHistory(next.id,historyId,[task.id]);
  expect((await evidence.validateCitations(next.id,`Prior result ${citation}`))[0]?.reference.id).toBe(evidenceId);expect((await evidence.suppliedEvidence(next.id)).items.map(item=>item.id)).toContain(evidenceId);
  const currentManifest=await evidence.taskManifest(next.id);await expect(assertCurrentEvidence(pool,next.id,currentManifest,{historyOriginTaskIds:[next.id]})).rejects.toMatchObject({code:"EVIDENCE_INTEGRITY"});
  const count=requests.length;await expect(executor.execute(next.id,randomUUID(),selected,{repository:"approved/public"})).rejects.toThrow();expect(requests).toHaveLength(count);
  await expect(evidence.checkHistory(next.id,[f.task.id])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  const foreign=await platform.ensureAccount({issuer:"http://localhost/foreign-history",subject:randomUUID(),email:"foreign@example.test",displayName:"Foreign"}),foreignOrg=await platform.createOrganization(foreign.id,"Foreign history");await connectFixtureModel(pool,foreign.id,foreignOrg.id);const foreignAgent=await platform.createAgent({accountId:foreign.id,organizationId:foreignOrg.id,name:"Foreign",configuration:defaultBusinessConfiguration()}),foreignVersion=await platform.createVersion({accountId:foreign.id,organizationId:foreignOrg.id,agentId:foreignAgent.id,expectedRevision:1});
  const foreignAuthority={...authority,organizationId:foreignOrg.id,resourceId:foreignAgent.id,principal:{kind:"human" as const,issuer:foreign.issuer,subject:foreign.subject}},foreignGrant={...grant,...foreignAuthority,id:randomUUID(),versionId:foreignVersion.id,connectedToolBindingIds:[],operations:["model.reply" as const,"knowledge.read" as const]};await platform.createGrant({accountId:foreign.id,grant:foreignGrant});const{task:foreignTask}=await platform.admitTask({authority:foreignAuthority,versionId:foreignVersion.id,grantId:foreignGrant.id,requestKey:randomUUID(),input:"Unrelated actor"});
  await expect(evidence.checkHistory(next.id,[foreignTask.id])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1 AND state='accepted'",[next.id]);await settleTask(pool,next.id,{state:"completed",output:`Previously confirmed ${citation}`});
  const{task:third}=await platform.admitTask({authority,versionId:version.id,grantId:nextGrant.id,conversationId:task.conversation_id,requestKey:randomUUID(),input:"Continue using the inherited result"});expect((await evidence.checkHistory(third.id,[next.id]))[0]?.eligible).toBe(true);
  const thirdId=`context:${third.id}:0`,thirdPayload={historyGroupIds:[next.id],messages:[{role:"assistant",content:`Previously confirmed ${citation}`}]};await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,2)",[thirdId,third.id,requestDigest(thirdPayload),thirdPayload]);await evidence.inheritHistory(third.id,thirdId,[next.id]);expect((await evidence.validateCitations(third.id,`Still confirmed ${citation}`))[0]?.reference.id).toBe(evidenceId);
  await platform.revokeGrant(f.scope.accountId,f.scope.organizationId,grant.id);await expect(evidence.validateCitations(third.id,`Prior ${citation}`)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});expect((await evidence.checkHistory(third.id,[next.id]))[0]).toMatchObject({eligible:false,omissionCode:"EVIDENCE_UNAVAILABLE"});await expect(evidence.validateCitations(next.id,`Prior ${citation}`)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  await settleTask(pool,third.id,{state:"cancelled"});
  const removed={...config,tools:[],capabilities:{...config.capabilities,delegation:{enabled:false as const}}};await platform.updateDraft({...f.scope,agentId:agent.id,expectedRevision:1,configuration:removed});const newVersion=await platform.createVersion({...f.scope,agentId:agent.id,expectedRevision:2}),newGrant={...grant,id:randomUUID(),versionId:newVersion.id,connectedToolBindingIds:[],operations:["model.reply" as const,"knowledge.read" as const]};await platform.createGrant({accountId:f.scope.accountId,grant:newGrant});
  await expect(platform.admitTask({authority,versionId:newVersion.id,grantId:newGrant.id,conversationId:task.conversation_id,requestKey:randomUUID(),input:"No current delegated read role"})).rejects.toMatchObject({code:"CONVERSATION_VERSION_CONFLICT"});
  const{task:noRole}=await platform.admitTask({authority,versionId:newVersion.id,grantId:newGrant.id,requestKey:randomUUID(),input:"No current delegated read role"});await expect(evidence.checkHistory(noRole.id,[task.id])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});expect(requests).toHaveLength(count);
 },30000);

 it("reads root publication scopes and the child's effective narrowed override without provider calls",async()=>{
  const f=await fixture(),config=defaultBusinessConfiguration(),selected=f.bindings.find(binding=>binding.definition.providerOperation==="get_repository")!;
  config.connectedToolBindingIds=f.bindings.map(binding=>binding.id);config.tools=["agents.delegate"];
  config.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"research",versionId:f.task.version_id,sourceRevisionIds:[],connectedToolBindingIds:[selected.id],tools:[],maxTokens:8000,maxActiveMs:120000}]};
  const agent=await platform.createAgent({...f.scope,name:"Scoped coordinator",configuration:config}),version=await platform.createVersion({...f.scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:f.scope.organizationId,resourceId:agent.id,callerClientId:"agents-execution",principal:f.grant.principal};
  const grant:ExecutionGrant={...f.grant,...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","connected.read","delegation.execute"]};
  await platform.createGrant({accountId:f.scope.accountId,grant});
  const{task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Check published and effective scope metadata"});
  expect((await pool.query("SELECT effective_configuration FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0].effective_configuration).toBeNull();
  const operationId=`delegate:${task.id}`,args={requests:[{bindingId:"research",brief:"Read only your approved scoped metadata"}]};
  await beginOperation(pool,task.id,{id:operationId,kind:"delegation",name:"agents.delegate",request:args,reservedTokens:0,reservedMs:0,retrySafe:true});
  const[child]=await admitChildren(pool,task.id,operationId,args);expect(child).toBeDefined();
  const scopes=await readGithubJourneyScopes(pool,task.id);expect(scopes).toHaveLength(2);
  expect(scopes.find(scope=>scope.id===task.id)).toMatchObject({id:task.id,parent_task_id:null,root_token_limit:32000,sources:[],bindings:config.connectedToolBindingIds,grant_sources:[],grant_bindings:config.connectedToolBindingIds});
  expect(scopes.find(scope=>scope.id===child!.taskId)).toMatchObject({id:child!.taskId,parent_task_id:task.id,root_token_limit:8000,sources:[],bindings:[selected.id],grant_sources:[],grant_bindings:[selected.id]});
  expect(scopes.every(scope=>scope.created_at instanceof Date&&Number.isFinite(scope.created_at.getTime()))).toBe(true);
  expect(requests).toEqual([]);
 });

 it("rejects narrowed specialist MCP bindings at publication and admission before creating child work",async()=>{
  const f=await fixture(true),remote=f.bindings.find(binding=>binding.transport==="mcp_http")!;
  const config=defaultBusinessConfiguration();config.connectedToolBindingIds=f.bindings.map(binding=>binding.id);config.tools=["agents.delegate"];
  config.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"research",versionId:f.task.version_id,sourceRevisionIds:[],connectedToolBindingIds:[remote.id],tools:[],maxTokens:8000,maxActiveMs:120000}]};
  const agent=await platform.createAgent({...f.scope,name:"Coordinator",configuration:config});
  await expect(platform.createVersion({...f.scope,agentId:agent.id,expectedRevision:1})).rejects.toMatchObject({code:"CONNECTED_HANDLE_DEPENDENCY"});
  config.capabilities.delegation.bindings[0]!.connectedToolBindingIds=f.bindings.map(binding=>binding.id);
  await platform.updateDraft({...f.scope,agentId:agent.id,configuration:config,expectedRevision:1});
  const version=await platform.createVersion({...f.scope,agentId:agent.id,expectedRevision:2}),account=(await pool.query("SELECT issuer,subject FROM agents_platform.accounts WHERE id=$1",[f.scope.accountId])).rows[0];
  const authority={product:"agents" as const,organizationId:f.scope.organizationId,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant:ExecutionGrant={...f.grant,...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","connected.read","delegation.execute"]};
  await platform.createGrant({accountId:f.scope.accountId,grant});
  const{task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Delegate bounded research"});
  const operationId=`delegate:${task.id}`,args={requests:[{bindingId:"research",brief:"Read the approved public file",connectedToolBindingIds:[remote.id]}]};
  await beginOperation(pool,task.id,{id:operationId,kind:"delegation",name:"agents.delegate",request:args,reservedTokens:0,reservedMs:0,retrySafe:true});
  await expect(admitChildren(pool,task.id,operationId,args)).rejects.toMatchObject({code:"CONNECTED_HANDLE_DEPENDENCY"});
  expect((await pool.query("SELECT count(*) AS count FROM agents_platform.tasks WHERE parent_task_id=$1",[task.id])).rows[0].count).toBe("0");
 });

});
