import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {ConnectedExecutor} from "../src/platform/connected-executor";
import {EvidenceStore} from "../src/platform/evidence";
import {PlatformStore} from "../src/platform/store";
import {ConnectionStore} from "../src/platform/connections";
import {ConnectionVault} from "../src/platform/vault";
import {setupPlatformSchema} from "../src/platform/setup";
import {defaultFaqConfiguration,requestDigest,type ExecutionGrant} from "../src/platform/contracts";
import {admitChildren} from "../src/platform/delegation";
import {beginOperation,finishOperation} from "../src/platform/execution";
import type {CapabilityBinding} from "../src/platform/capability-catalog";
import {assertConnectedBindingDependencies,connectedModelArguments,connectedModelTool} from "../src/platform/connected-tool-schema";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("registered connected executor with actual PostgreSQL, HTTP and private fixture objects",()=>{
 let admin:Pool,pool:Pool,server:Server,platform:PlatformStore,connections:ConnectionStore,executor:ConnectedExecutor,evidence:EvidenceStore;
 let origin:string,requests:string[]=[],isPrivate=false,hang=false;
 const remoteArguments:Record<string,unknown>[]=[];
 const database=`agents_connected_exec_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>();
 const text="Public immutable source content. "+"x".repeat(5000)+" Decisive tail fact.",bytes=Buffer.from(text),blobSha=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),commit="a".repeat(40),tree="b".repeat(40);
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
  server=createServer(async(req,res)=>{requests.push(req.url!);res.setHeader("content-type","application/json");
   if(req.url==="/mcp"){
    let serialized="";for await(const chunk of req)serialized+=chunk;const message=JSON.parse(serialized),reply=(result:unknown)=>res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if(message.method==="server/discover")res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Legacy endpoint"}}));
    else if(message.method==="initialize")reply({protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"github-contract-fixture",version:"1"}});
    else if(message.method==="notifications/initialized")res.writeHead(202).end();
    else if(message.method==="tools/list")reply({tools:[{name:"get_file_contents",description:"Read approved file",inputSchema:{type:"object",properties:{owner:{type:"string"},repo:{type:"string"},path:{type:"string"},ref:{type:"string"}},required:["owner","repo","path","ref"],additionalProperties:false}}]});
    else if(message.method==="tools/call"){remoteArguments.push(message.params.arguments);reply({content:[{type:"text",text}]});}else res.writeHead(400).end("{}");return;
   }

   if(req.url==="/repos/approved/public")res.end(JSON.stringify({id:1,private:isPrivate,visibility:isPrivate?"private":"public",full_name:"approved/public",description:"Public fixture",default_branch:"main",updated_at:"2026-10-17T00:00:00Z",stargazers_count:1,extra:"Retain full provider body"}));
   else if(req.url==="/repos/approved/public/commits/main")res.end(JSON.stringify({sha:commit,commit:{tree:{sha:tree}}}));
   else if(req.url===`/repos/approved/public/git/trees/${tree}?recursive=1`)res.end(JSON.stringify({sha:tree,truncated:false,tree:[{path:"guide.md",type:"blob",mode:"100644",sha:blobSha,size:bytes.length}]}));
   else if(req.url===`/repos/approved/public/git/blobs/${blobSha}`){if(hang)return;res.end(JSON.stringify({sha:blobSha,encoding:"base64",size:bytes.length,content:bytes.toString("base64")}));}
   else res.writeHead(404).end("{}");
  });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("Missing private fixture object");return value;},async delete(key:string){objects.delete(key);}};
  connections=new ConnectionStore(pool,new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),[]);evidence=new EvidenceStore(pool,storage);executor=new ConnectedExecutor(pool,connections,storage,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`});
 });
 afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}});
 async function fixture(withMcp=false){
  isPrivate=false;hang=false;requests=[];
  const account=await platform.ensureAccount({issuer:"http://localhost/connected-executor",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(account.id,"Connected"),scope={accountId:account.id,organizationId:org.id};
  const connection=await connections.create(scope,{operationId:randomUUID(),name:"GitHub",profileId:"github-public-read-v1",targetId:"provider:github",apiKey:"github_pat_connected_fixture_only",expiresAt:new Date(Date.now()+86400000).toISOString(),selections:[{owner:"approved",repository:"public",ref:"main"}]});
  const catalog=await executor.discover(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,transport:"native_http"});
  const bindings=await executor.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,catalogId:catalog.id,selections:["get_repository","resolve_ref","list_tree","read_file"].map(providerOperation=>({providerOperation,resources:connection.resources}))});
  if(withMcp){
   const remote=await executor.discover(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,transport:"mcp_http"});
   bindings.push(...await executor.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:1,catalogId:remote.id,selections:[{providerOperation:"get_file_contents",resources:connection.resources}]}));
  }
  const configuration={...defaultFaqConfiguration(),connectedToolBindingIds:bindings.map(binding=>binding.id)},agent=await platform.createAgent({...scope,name:"Research",configuration}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","connected.read"],sourceRevisionIds:[],connectedToolBindingIds:bindings.map(binding=>binding.id),maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};await platform.createGrant({accountId:account.id,grant});
  const{task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Read approved public sources"});
  return{scope,connection,bindings,task,grant};
 }
 async function call(f:Awaited<ReturnType<typeof fixture>>,name:string,args:object){const binding=f.bindings.find(b=>b.definition.providerOperation===name)!,operationId=`tool:${f.task.id}:${randomUUID()}`;await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:30000,retrySafe:true});return{result:await executor.execute(f.task.id,operationId,binding,args),binding,operationId,args};}
 it("uses safe wrappers, immutable commit/file handles, bounded tail reads and private full response receipts",async()=>{
  const f=await fixture();expect(requests).toHaveLength(0);
  for(const binding of f.bindings){expect(connectedModelTool(binding).function.parameters.additionalProperties).toBe(false);expect(()=>connectedModelArguments(binding,{url:"https://private.test",path:"evil",repository:"approved/public"})).toThrow();}
  const revision=await call(f,"resolve_ref",{repository:"approved/public"}),revisionId=(revision.result.handles as any).revisionId;
  const listing=await call(f,"list_tree",{revisionId}),fileId=(listing.result.handles as any).files[0].fileId;
  const file=await call(f,"read_file",{fileId,offset:5000});expect(file.result.content).toContain("Decisive tail fact");expect(Buffer.byteLength(JSON.stringify(file.result))).toBeLessThanOrEqual(8192);
  expect(requests.filter(path=>path.includes("/commits/"))).toEqual(["/repos/approved/public/commits/main"]);expect(requests.some(path=>path.includes(blobSha))).toBe(true);
  const saved=await pool.query("SELECT * FROM agents_platform.connected_response_bodies WHERE operation_id=$1 ORDER BY ordinal",[file.operationId]);expect(saved.rowCount).toBe(2);expect(Buffer.from(objects.get(saved.rows[0].object_key)!).toString()).toContain("Retain full provider body");
  expect((await pool.query("SELECT count(*) AS count FROM agents_platform.connected_attempts WHERE operation_id=$1",[file.operationId])).rows[0].count).toBe("2");
  const fresh=new ConnectedExecutor(pool,connections,executor.objects,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`});
  const resolve=vi.spyOn(fresh.registry,"resolve").mockImplementation(()=>{throw Error("fixture old adapter release absent");});
  const before=requests.length;expect(await fresh.execute(f.task.id,file.operationId,file.binding,file.args)).toEqual(file.result);expect(requests).toHaveLength(before);expect(resolve).not.toHaveBeenCalled();
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
  const fresh=new ConnectedExecutor(pool,connections,executor.objects,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`});
  await expect(fresh.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});expect(requests).toHaveLength(count);
 });
 it("uses the original operation deadline through private receipt publication and charges actual overrun",async()=>{
  const f=await fixture(),binding=f.bindings.find(binding=>binding.definition.providerOperation==="get_repository")!,operationId=`tool:${f.task.id}:slow-storage`,args={repository:"approved/public"};
  const slow={...executor.objects,put:async(key:string,value:Uint8Array,type:string)=>{await new Promise(done=>setTimeout(done,160));await executor.objects.put(key,value,type);},get:executor.objects.get.bind(executor.objects),delete:executor.objects.delete.bind(executor.objects)};
  const bounded=new ConnectedExecutor(pool,connections,slow,evidence,{testGithubOrigin:origin,testMcpEndpoint:`${origin}/mcp`});
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:100,retrySafe:true});
  await expect(bounded.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});
  expect(requests).toEqual(["/repos/approved/public"]);
  expect((await pool.query("SELECT state,result FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0]).toMatchObject({state:"uncertain",result:null});
  await finishOperation(pool,f.task.id,operationId,"uncertain",null,"CONNECTED_READ_UNCERTAIN",0);
  expect(Number((await pool.query("SELECT active_ms FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0].active_ms)).toBeGreaterThanOrEqual(160);
  const before=requests.length;await expect(bounded.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});expect(requests).toHaveLength(before);
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
 },20000);

 it("does not reissue an orphaned durable read claim and preserves its uncertainty receipt",async()=>{
  const f=await fixture(),binding=f.bindings.find(b=>b.definition.providerOperation==="get_repository")!,args={repository:"approved/public"},operationId=`tool:${f.task.id}:orphan`;
  await beginOperation(pool,f.task.id,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:1000,retrySafe:true});
  await pool.query("INSERT INTO agents_platform.connected_reads(operation_id,task_id,organization_id,root_task_id,connection_id,binding_id,request_digest,state) VALUES($1,$2,$3,$2,$4,$5,$6,'started')",[operationId,f.task.id,f.scope.organizationId,f.connection.id,binding.id,requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args})]);
  await expect(executor.execute(f.task.id,operationId,binding,args)).rejects.toMatchObject({code:"CONNECTED_READ_UNCERTAIN"});expect(requests).toHaveLength(0);
  await expect(pool.query("UPDATE agents_platform.connected_reads SET state='started' WHERE operation_id=$1",[operationId])).rejects.toThrow("immutable");
 });

 it("rejects narrowed specialist MCP bindings at publication and admission before creating child work",async()=>{
  const f=await fixture(true),remote=f.bindings.find(binding=>binding.transport==="mcp_http")!;
  const config=defaultFaqConfiguration();config.connectedToolBindingIds=f.bindings.map(binding=>binding.id);config.tools=["agents.delegate"];
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
