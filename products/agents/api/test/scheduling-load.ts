/** Authenticated HTTP + real PostgreSQL/outbox/Restate acceptance, controlled model only. */
import {randomUUID,createHash} from 'node:crypto';
import {cpus,totalmem,freemem} from 'node:os';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createHttp2Server,connect,type ClientHttp2Session,type ServerHttp2Session} from 'node:http2';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Pool} from 'pg';
import {setupPlatformSchema} from '../src/composition/setup';
import {PlatformStore} from '../src/product/agents/store';
import {defaultBusinessConfiguration,type AgentConfiguration,terminalTaskStates} from '../src/contracts/contracts';
import {WORKFLOW_NAME,HARNESS_RELEASE} from '../src/contracts/execution';
import {privateStoreFromEnvironment} from '../src/infrastructure/object-store';
import {publishFixtureSource} from './knowledge-fixture';
import {controlledLoadServices} from './scheduling-load-services';
import {exerciseOwnershipControls} from './scheduling-load-controls';
import {loadDiagnostics} from './scheduling-load-diagnostics';
const image='docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742';
const modelDelayMs=Number(process.env.AGENTS_LOAD_MODEL_DELAY_MS??100),slowDelayMs=Number(process.env.AGENTS_LOAD_SLOW_DELAY_MS??1000);
if(!Number.isInteger(modelDelayMs)||modelDelayMs<1||modelDelayMs>10000||!Number.isInteger(slowDelayMs)||slowDelayMs<1||slowDelayMs>10000)throw Error('Invalid controlled provider delay');
const full=process.env.AGENTS_LOAD_FULL==='1',noisy=process.env.AGENTS_LOAD_NOISY==='1';
const barrier=process.env.AGENTS_LOAD_BARRIER??'none';if(!['none','roots','operations'].includes(barrier))throw Error('Invalid controlled concurrency barrier');
let releaseBarrier:()=>void=()=>{},firstHeldProviderAt=0,barrierTimer:ReturnType<typeof setTimeout>|undefined;
const providerBarrier=new Promise<void>(resolve=>{releaseBarrier=resolve;});
const fault=process.env.AGENTS_LOAD_FAULT??'none';if(!['none','duplicate-messages','worker-loss','provider-throttle','collector-outage','lease-expiry','reconnect'].includes(fault))throw Error('Invalid controlled fault');
const databaseErrors:unknown[]=[];const faultEvents:unknown[]=[],activeByWorker:Record<string,number>={};
const processResources:Record<string,{role:string;peakRss:number;peakHeap:number;peakPoolWait:number;peakCpuPercent:number;outOfMemory:boolean}>={},processExits:{role:string;code:number|null;signal:string|null}[]=[];
const rootCount=Number(process.env.AGENTS_LOAD_ROOTS??100),replicas=Number(process.env.AGENTS_LOAD_REPLICAS??1),single=process.env.AGENTS_LOAD_SINGLE_TENANT==='1',baseline=process.env.AGENTS_LOAD_BASELINE==='1';
const workerHeapMiB=rootCount===10000?1024:512;
if(![100,1000,10000].includes(rootCount)||![1,2,4].includes(replicas))throw Error('Use staged100/1000/10000 and1/2/4 replicas');
const runId=randomUUID(),database=`agents_load_${runId.replaceAll('-','')}`,container=`agents-load-${runId}`;
const repository=resolve(__dirname,'../../../..'),api=resolve(__dirname,'..'),children:ChildProcess[]=[];
const admin=new Pool({connectionString:process.env.AGENTS_TEST_DATABASE_URL??process.env.AGENTS_DATABASE_URL,max:1});let pool:Pool|undefined,created=false,ownedContainer=false;
let stopProbes=false,probeLoop:Promise<void>|undefined;
let services:Awaited<ReturnType<typeof controlledLoadServices>>|undefined,diagnostics:ReturnType<typeof loadDiagnostics>|undefined,reviewLoop:Promise<void>|undefined,controls:Awaited<ReturnType<typeof exerciseOwnershipControls>>|undefined;
let stopReviews=false;const reviewErrors:string[]=[],reviewLatencies:number[]=[];
let proxy:ReturnType<typeof createHttp2Server>|undefined;const proxySessions:ClientHttp2Session[]=[];const proxyClients=new Set<ServerHttp2Session>();const modelCallsByWorker:Record<string,number>={};
let activeModels=0,peakModels=0,modelRequests=0,throttled=0,peakRunningRoots=0,peakWaitingRoots=0;
const admissionLatencies:number[]=[],statusLatencies:number[]=[],liveStatusLatencies:number[]=[],states:Record<string,number>={},errors:Record<string,number>={},samples:unknown[]=[];
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim();
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const percentile=(values:number[],q:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]:null;
const simulator=createServer(async(request,response)=>{
 const workerId=String(request.headers['x-fixture-worker-id']??'unknown');modelCallsByWorker[workerId]=(modelCallsByWorker[workerId]??0)+1;
 activeByWorker[workerId]=(activeByWorker[workerId]??0)+1;activeModels++;peakModels=Math.max(peakModels,activeModels);const callOrdinal=++modelRequests;
 try{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
  const content=body.messages.map((m:any)=>m.content??'').join('\n'),used=body.messages.some((m:any)=>m.role==='tool');
  if(barrier!=='none'){if(!firstHeldProviderAt){firstHeldProviderAt=Date.now();barrierTimer=setTimeout(releaseBarrier,85000);}await providerBarrier;}
  await delay(content.includes('SLOW_FIXTURE')?slowDelayMs:modelDelayMs);
  if(fault==='provider-throttle'&&callOrdinal%17===0){throttled++;response.statusCode=429;response.setHeader('retry-after','1');response.end('{}');return;}
  let tool:unknown|undefined;
  if(!used&&content.includes('TOOL_FIXTURE'))tool={id:'memory1',type:'function',function:{name:'memory_search',arguments:JSON.stringify({query:'opening hours'})}};
  if(!used&&content.includes('DELEGATE_FIXTURE'))tool={id:'delegate1',type:'function',function:{name:'agents_delegate',arguments:JSON.stringify({requests:[{bindingId:'leaf',brief:'Return a short fixture answer.'}]})}};
  const citations=[...new Set(JSON.stringify(body.messages).match(/E[a-f0-9]{32}/g)??[])];
  response.setHeader('content-type','application/json');response.end(JSON.stringify({id:`controlled-${callOrdinal}`,choices:[{finish_reason:tool?'tool_calls':'stop',message:{role:'assistant',content:tool?null:`Opening hours are 09:00 to 17:00. ${citations.map(id=>`[${id}]`).join(' ')}`,...(tool?{tool_calls:[tool]}:{})}}],usage:{prompt_tokens:52,completion_tokens:4}}));
 }catch{response.statusCode=500;response.end('{}');}finally{activeModels--;activeByWorker[workerId]--;}
});
async function startProcess(role:'api'|'worker',env:NodeJS.ProcessEnv):Promise<any>{
 const child=spawn(process.execPath,[`--max-old-space-size=${role==='worker'?workerHeapMiB:256}`,'--import',join(api,'node_modules/tsx/dist/loader.mjs'),join(__dirname,'scheduling-load-process.ts')],{cwd:api,env:{...env,AGENTS_LOAD_ROLE:role},stdio:['ignore','pipe','pipe']});children.push(child);
 return new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(Error(`${role} startup timeout`)),20000);
 child.stdout!.on('data',chunk=>{text+=chunk.toString();const lines=text.split('\n');text=lines.pop()??'';for(const line of lines){try{const item=JSON.parse(line);
 if(item.fixtureDatabaseError&&databaseErrors.length<1000)databaseErrors.push({role,code:item.code,boundary:item.boundary,constraint:item.constraint,table:item.table,schema:item.schema});
 if(item.fixtureReady){clearTimeout(timeout);resolve({...item,child});}
 if(item.fixtureMetrics){const key=String(item.pid),previous=processResources[key];processResources[key]={role,peakRss:Math.max(previous?.peakRss??0,item.rss),peakHeap:Math.max(previous?.peakHeap??0,item.heapUsed),peakPoolWait:Math.max(previous?.peakPoolWait??0,item.poolWaiting),peakCpuPercent:Math.max(previous?.peakCpuPercent??0,item.cpuPercent??0),outOfMemory:previous?.outOfMemory??false};}
 }catch{}}});
 child.stderr!.on('data',chunk=>{if(/heap out of memory|allocation failed/i.test(chunk.toString())){const key=String(child.pid),old=processResources[key];processResources[key]={role,peakRss:old?.peakRss??0,peakHeap:old?.peakHeap??0,peakPoolWait:old?.peakPoolWait??0,peakCpuPercent:old?.peakCpuPercent??0,outOfMemory:true};}});
 child.once('exit',(code,signal)=>{processExits.push({role,code,signal});clearTimeout(timeout);reject(Error(`${role} exited:${code}`));});});
}
async function parallel<T>(items:T[],limit:number,work:(item:T,index:number)=>Promise<void>){let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;await work(items[index]!,index);}}));}
async function sourceIdentity(){
 const hash=createHash('sha256');let files=0;
 async function walk(directory:string){for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(/\.(ts|sql)$/.test(entry.name)){hash.update(path.slice(api.length)).update(await readFile(path));files++;}}}
 await walk(join(api,'src'));await walk(join(api,'schema'));for(const name of ['scheduling-load.ts','scheduling-load-process.ts','scheduling-load-services.ts','scheduling-load-controls.ts','scheduling-load-diagnostics.ts','scheduling-workload.v2.json','scheduling-restate.toml','scheduling-restate-10k.toml','knowledge-fixture.ts'])hash.update(await readFile(join(__dirname,name)));
 hash.update(await readFile(join(api,'package.json')));hash.update(await readFile(join(repository,'pnpm-lock.yaml')));
 return {digest:hash.digest('hex'),files};
}
async function main(){
 const sourceBefore=await sourceIdentity();
 await admin.query(`CREATE DATABASE "${database}"`);created=true;const url=new URL(process.env.AGENTS_TEST_DATABASE_URL??process.env.AGENTS_DATABASE_URL!);url.pathname=`/${database}`;
 pool=new Pool({connectionString:url.href,max:8});await setupPlatformSchema(pool);const store=new PlatformStore(pool);
 const workload=JSON.parse(await readFile(join(__dirname,'scheduling-workload.v2.json'),'utf8'));
 if(full){services=await controlledLoadServices(pool,repository,runId);await services.startCollector();}
 await new Promise<void>(resolve=>simulator.listen(0,'127.0.0.1',resolve));const simulatorUrl=`http://127.0.0.1:${(simulator.address() as {port:number}).port}`;
 const policy={maxConcurrentRoots:Math.max(100,rootCount),dailyTokenAllowance:2000000000,productActive:rootCount,tenantActive:rootCount,modelActive:rootCount,toolActive:rootCount,providerActive:rootCount,interactiveActive:rootCount,evaluationActive:rootCount,maxQueued:Math.min(100000,rootCount*3),maxWaitMs:120000};
 const large=rootCount===10000,apiPool=replicas===4?3:large?4:8,workerPool=replicas===4?8:large?16:8,acquireTimeoutMs=large?60000:5000,runtimeMemoryMiB=large?1536:768,runtimeCpus=large?4:2,invokerLimit=large?10000:1000;
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:'test',AGENTS_DATABASE_URL:url.href,AGENTS_PUBLIC_URL:'http://localhost:3100',AGENTS_OIDC_ISSUER_URL:'http://localhost/controlled-load',AGENTS_OIDC_CLIENT_SECRET:'controlled-load-identity-secret-only',OPENROUTER_API_KEY:'controlled-fixture-never-provider',AGENTS_LOAD_SIMULATOR_URL:simulatorUrl,AGENTS_SCHEDULING_POLICY_JSON:JSON.stringify(policy),AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify({total:60,acquireTimeoutMs,api:{replicas,max:apiPool},worker:{replicas,max:workerPool},cleanup:{replicas:0,max:2},evaluation:{replicas:1,max:8},migration:{replicas:1,max:1}}),...services?.environment};
 docker('run','-d','--name',container,'--cpus',String(runtimeCpus),'--memory',`${runtimeMemoryMiB}m`,'--add-host','host.docker.internal:host-gateway','-p','127.0.0.1::8080','-p','127.0.0.1::9070','-v',`${join(__dirname,large?'scheduling-restate-10k.toml':'scheduling-restate.toml')}:/etc/restate-load.toml:ro`,image,'-c','/etc/restate-load.toml');ownedContainer=true;
 const runtimeConfig=docker('exec',container,'/usr/local/bin/restate-server','-c','/etc/restate-load.toml','--dump-config');await writeFile(resolve(repository,'.audit',`agents-restate-config-${runId}.toml`),runtimeConfig);
 const ingress=`http://${docker('port',container,'8080/tcp')}`,runtimeAdmin=`http://${docker('port',container,'9070/tcp')}`;env.RESTATE_INGRESS_URL=ingress;env.RESTATE_ADMIN_URL=runtimeAdmin;
 const apis=await Promise.all(Array.from({length:replicas},()=>startProcess('api',env))),workers=await Promise.all(Array.from({length:replicas},(_,index)=>startProcess('worker',{...env,AGENTS_LOAD_WORKER_ID:`worker-${index}`})));
 let healthy=false;for(let n=0;n<100;n++){try{if((await fetch(runtimeAdmin+'/health')).ok){healthy=true;break;}}catch{}await delay(100);}if(!healthy)throw Error('Restate readiness timeout');
 // One deployment endpoint represents interchangeable replicas of the same pinned worker.
 proxy=createHttp2Server();proxy.on('session',session=>{proxyClients.add(session);session.once('close',()=>proxyClients.delete(session));});let nextWorker=0;
 proxy.on('stream',(stream,headers)=>{
  const index=nextWorker++%workers.length;
  let session=proxySessions[index];if(!session||session.closed||session.destroyed){session=connect(`http://127.0.0.1:${workers[index].port}`);session.on('error',()=>{});proxySessions[index]=session;}
  let upstream:ReturnType<ClientHttp2Session['request']>;
  try{upstream=session.request({...headers,':authority':`127.0.0.1:${workers[index].port}`});}catch{stream.close();return;}
  upstream.on('response',reply=>{if(!stream.destroyed)stream.respond(reply);});
  upstream.on('error',()=>{if(!stream.destroyed)stream.close();});stream.on('error',()=>upstream.close());stream.pipe(upstream);upstream.pipe(stream);
 });
 await new Promise<void>(resolve=>proxy!.listen(0,'0.0.0.0',resolve));const proxyPort=(proxy.address() as {port:number}).port;
 const registration=await fetch(runtimeAdmin+'/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uri:`http://host.docker.internal:${proxyPort}`,force:false})});
 if(!registration.ok)throw Error(`Worker registration:${registration.status}:${await registration.text()}`);
 const tenants:any[]=[];const objects=privateStoreFromEnvironment(env);
 async function apiCall(tenant:any,path:string,method='GET',body?:unknown,index=0){
  const start=Date.now(),response=await fetch(apis[index%apis.length].endpoint+`/api/organizations/${tenant.organizationId}`+path,{method,headers:{cookie:`agents_session=${tenant.token}`,origin:'http://localhost:3100',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  const payload=await response.json() as any;if(!response.ok)throw Object.assign(Error(payload.error?.code??String(response.status)),{code:payload.error?.code??String(response.status),status:response.status});return {payload,latency:Date.now()-start};
 }
 const tenantCount=single?1:baseline?Math.ceil(rootCount/2):Math.min(100,Math.max(10,Math.ceil(rootCount/20)));
 for(let index=0;index<tenantCount;index++){
  const account=await store.ensureAccount({issuer:env.AGENTS_OIDC_ISSUER_URL!,subject:randomUUID(),email:'fixture@example.com',displayName:'Load fixture'}),org=await store.createOrganization(account.id,'Disposable load fixture');
  const session=await store.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+900000)}),tenant={organizationId:org.id,token:session.token,versions:[] as string[]};
  const agents=new Map<string,string>();
  async function publish(configuration:AgentConfiguration){const {payload:{agent}}=await apiCall(tenant,'/agents','POST',{name:'Controlled fixture'});await apiCall(tenant,`/agents/${agent.id}`,'PUT',{configuration,expectedRevision:1});const{payload:{version}}=await apiCall(tenant,`/agents/${agent.id}/versions`,'POST',{expectedRevision:2});agents.set(version.id,agent.id);return version.id;}
  const base=defaultBusinessConfiguration();base.instructions='Return a short controlled fixture answer.';
  const simpleVersion=await publish(base),toolConfig=structuredClone(base);toolConfig.memory.enabled=true;toolConfig.tools=['memory.search'];toolConfig.instructions='TOOL_FIXTURE: First search memory, then answer.';
  const toolVersion=await publish(toolConfig),delegated=structuredClone(base);delegated.instructions='DELEGATE_FIXTURE: Delegate once then answer.';delegated.tools=['agents.delegate'];delegated.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:'leaf',versionId:simpleVersion,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:8000,maxActiveMs:240000}]};
  tenant.versions=[simpleVersion,toolVersion,await publish(delegated)];
  if(full){
   const source=await publishFixtureSource(pool,{accountId:account.id,organizationId:org.id,title:'Approved opening hours',content:'Opening hours are 09:00 to 17:00 Monday to Friday. CONTROLLED_PRIVATE_CANARY',visibility:'public'},objects);
   const faq=structuredClone(base);faq.program={id:'grounded-conversation',version:'1'};faq.sourceRevisionIds=[source.id];faq.instructions='Answer opening-hours questions using supplied evidence and cite its labels.';
   tenant.versions[0]=await publish(faq);
   const {payload:{connection}}=await apiCall(tenant,'/connections','POST',{operationId:randomUUID(),name:'Controlled report delivery',targetId:'controlled-reports',apiKey:services!.reportKey});
   const report=structuredClone(base);report.capabilities.workflows={enabled:true,profileId:'report-delivery-v1',connectionId:connection.id,reportArtifactName:'report.md',title:'Controlled load report'};
   tenant.versions.push(await publish(report));const slow=structuredClone(faq);slow.instructions='SLOW_FIXTURE: Answer opening-hours questions using supplied evidence and cite its labels.';tenant.versions.push(await publish(slow));
   if(index<10){const {payload:{deployment}}=await apiCall(tenant,`/agents/${agents.get(tenant.versions[4])}/deployments`,'POST',{versionId:tenant.versions[4],allowedOrigins:['http://localhost:3100']});(tenant as any).websiteDeploymentId=deployment.id;}
  }
  tenants.push(tenant);
 }
 const firstPage=await apiCall(tenants[0],'/agents/summaries?limit=1','GET',undefined,0);
 const cursor=firstPage.payload.nextCursor;if(!cursor)throw Error('Missing actual roster cursor');
 const nextPage=await apiCall(tenants[0],`/agents/summaries?limit=1&cursor=${encodeURIComponent(cursor)}`,'GET',undefined,replicas-1);
 if(nextPage.payload.agents[0].id===firstPage.payload.agents[0].id)throw Error('Cursor repeated roster item across replicas');
 const admitted:{id:string;tenant:any;index:number}[]=[],started=Date.now();
 diagnostics=loadDiagnostics(pool,container,rows=>{peakRunningRoots=Math.max(peakRunningRoots,rows.filter(row=>row.state==='running').reduce((n,row)=>n+row.n,0));peakWaitingRoots=Math.max(peakWaitingRoots,rows.filter(row=>row.state.startsWith('waiting')||row.state==='accepted').reduce((n,row)=>n+row.n,0));});
 let controlPromise:Promise<void>|undefined;
 if(full){
  controlPromise=(async()=>{await delay(5000);controls=await exerciseOwnershipControls(pool!,apis.map(api=>api.endpoint),tenants.filter(tenant=>tenant.websiteDeploymentId));})();
  reviewLoop=(async()=>{while(!stopReviews){
   const due=(await pool!.query(`SELECT a.id,a.root_task_id,t.organization_id FROM agents_platform.actions a JOIN agents_platform.tasks t ON t.id=a.root_task_id WHERE a.state='pending_review' AND a.created_at<now()-interval '3 seconds' ORDER BY a.created_at LIMIT 20`)).rows;
   for(const row of due){const tenant=tenants.find(tenant=>tenant.organizationId===row.organization_id);if(!tenant)continue;try{const {payload:{actions}}=await apiCall(tenant,`/tasks/${row.root_task_id}/actions`),action=actions.find((action:any)=>action.id===row.id);if(!action)throw Error('Prepared review unavailable');const start=Date.now();await apiCall(tenant,`/tasks/${row.root_task_id}/actions/${row.id}/decision`,'POST',{operationId:randomUUID(),decision:'approve',expectedDigest:action.reviewDigest});reviewLatencies.push(Date.now()-start);}catch(error){reviewErrors.push(error instanceof Error?error.message:'Review failed');}}
   await delay(250);
  }})();
 }
 probeLoop=(async()=>{let n=0;while(!stopProbes){if(admitted.length){const task=admitted[n++%admitted.length]!;try{const result=await apiCall(task.tenant,`/tasks/${task.id}`,'GET',undefined,n);liveStatusLatencies.push(result.latency);}catch(error){const code=`probe:${(error as any).code??'transport'}`;errors[code]=(errors[code]??0)+1;}}await delay(250);}})();
 await parallel(Array.from({length:rootCount},(_,i)=>i),Math.min(128,rootCount),async(_,index)=>{
  if(full&&barrier==='none'){const half=rootCount/2,target=index<half?index/half*30000:30000+(index-half)/half*10000;await delay(Math.max(0,started+target-Date.now()));}
  const tenant=tenants[noisy&&tenants.length>1?(index%5<4?0:1+Math.floor(index/5)%(tenants.length-1)):index%tenants.length],mod=index%10,versionId=tenant.versions[full&&mod===9?4:full&&mod===5?3:mod<6?0:mod<8?1:mod===8?2:0];
  try{const result=await apiCall(tenant,'/tasks','POST',{versionId,requestKey:`load:${runId}:${index}`,input:full?'opening hours':mod===9?'SLOW_FIXTURE: What are the opening hours?':`What are the opening hours? Fixture request ${index}`},index);admissionLatencies.push(result.latency);admitted.push({id:result.payload.task.id,tenant,index});
   if(fault==='lease-expiry'&&!faultEvents.length){const claimed=await pool!.query(`UPDATE agents_platform.task_outbox SET lease_owner=$2,lease_until=now()+interval '2 seconds' WHERE task_id=$1 AND dispatched_at IS NULL AND lease_owner IS NULL RETURNING task_id`,[result.payload.task.id,randomUUID()]);if(claimed.rowCount)faultEvents.push({kind:'abandoned-native-dispatch-lease',taskId:result.payload.task.id,leaseMs:2000});}
  }
  catch(error){const code=(error as any).code??'transport';errors[code]=(errors[code]??0)+1;if((error as any).status===429)throttled++;}
 });
 await controlPromise;
 const barrierFacts=barrier==='none'?null:{targetRoots:rootCount,targetActiveOperations:barrier==='operations'?rootCount:null,rootsAtRelease:0,activeModelsAtRelease:0,heldMs:0,invokerConfiguredLimit:invokerLimit};
 if(barrierFacts){
  if(barrier==='operations')while(activeModels<rootCount&&Date.now()-started<80000)await delay(250);
  barrierFacts.rootsAtRelease=Number((await pool.query(`SELECT count(*)::int n FROM agents_platform.tasks WHERE parent_task_id IS NULL AND channel_binding IS NULL AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')`)).rows[0].n);
  barrierFacts.activeModelsAtRelease=activeModels;barrierFacts.heldMs=firstHeldProviderAt?Date.now()-firstHeldProviderAt:0;releaseBarrier();if(barrierTimer)clearTimeout(barrierTimer);
 }
 const acceptedAt=Date.now();let terminal=0;
 if(full&&fault==='collector-outage'){services!.pauseCollector();faultEvents.push({kind:'collector-paused',at:Date.now()-started});await delay(5000);services!.resumeCollector();faultEvents.push({kind:'collector-resumed',at:Date.now()-started});}
 if(fault==='reconnect'){
  const task=admitted[0]!;const first=await apiCall(task.tenant,`/tasks/${task.id}/events?limit=1`,'GET',undefined,0),next=first.payload.nextCursor;
  const replacement=await startProcess('api',env),previous=apis[0];apis[0]=replacement;previous.child.kill('SIGTERM');
  const page=next?(await apiCall(task.tenant,`/tasks/${task.id}/events?limit=1&cursor=${encodeURIComponent(next)}`,'GET',undefined,0)).payload:null;
  faultEvents.push({kind:'api-process-reconnect',restarted:true,sharedCursorVerified:!!page?.events.length&&page.events[0].sequence!==first.payload.events[0].sequence});
 }
 if(fault==='duplicate-messages'){
  const responses=await Promise.all(admitted.slice(0,20).flatMap(task=>[1,2].map(()=>fetch(`${ingress}/restate/send/${WORKFLOW_NAME}/${task.id}/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:task.id})}))));
  faultEvents.push({kind:'duplicate-messages',sent:responses.length,accepted:responses.filter(r=>r.ok).length});
 }
 if(fault==='worker-loss'){
  for(let attempt=0;attempt<100&&!Object.values(activeByWorker).some(n=>n>0);attempt++)await delay(100);
  const chosen=Object.entries(activeByWorker).sort((a,b)=>b[1]-a[1])[0];
  if(chosen&&chosen[1]>0){const index=Number(chosen[0].split('-')[1]),worker=workers[index];worker.child.kill('SIGKILL');faultEvents.push({kind:'worker-loss',worker:index,activeCalls:chosen[1],elapsedMs:Date.now()-started});
   await delay(500);workers[index]=await startProcess('worker',{...env,AGENTS_LOAD_WORKER_ID:`worker-${index}`});faultEvents.push({kind:'worker-restarted',worker:index,elapsedMs:Date.now()-started});
  }else faultEvents.push({kind:'worker-loss-not-injected',reason:'No active provider call observed'});
 }

 while(Date.now()-acceptedAt<120000){
  const sample=(await pool.query(`SELECT state,count(*)::int n FROM agents_platform.tasks GROUP BY state`)).rows;terminal=sample.filter(r=>terminalTaskStates.has(r.state)).reduce((n,r)=>n+r.n,0);
  const rootSample=(await pool.query(`SELECT state,count(*)::int n FROM agents_platform.tasks WHERE parent_task_id IS NULL AND channel_binding IS NULL GROUP BY state`)).rows;
  const running=rootSample.filter(r=>r.state==='running').reduce((n,r)=>n+r.n,0),waiting=rootSample.filter(r=>r.state.startsWith('waiting')||r.state==='accepted').reduce((n,r)=>n+r.n,0);peakRunningRoots=Math.max(peakRunningRoots,running);peakWaitingRoots=Math.max(peakWaitingRoots,waiting);
  samples.push({elapsedMs:Date.now()-started,rootStates:rootSample,activeModels,pool:{total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount}});
  const done=rootSample.filter(r=>terminalTaskStates.has(r.state)).reduce((n,r)=>n+r.n,0);
  const controlsPending=full?Number((await pool.query(`SELECT count(*)::int n FROM agents_platform.tasks WHERE parent_task_id IS NULL AND channel_binding IS NOT NULL AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')`)).rows[0].n):0;
  if(done===admitted.length&&!controlsPending)break;await delay(500);
 }
 stopProbes=true;stopReviews=true;await probeLoop;await reviewLoop;await diagnostics.stop();
 const snapshot=await pool.connect();await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 for(const row of (await snapshot.query('SELECT state,count(*)::int n FROM agents_platform.tasks WHERE parent_task_id IS NULL AND channel_binding IS NULL GROUP BY state')).rows)states[row.state]=row.n;
 await parallel(admitted.slice(0,Math.min(100,admitted.length)),16,async task=>{const result=await apiCall(task.tenant,`/tasks/${task.id}`,'GET',undefined,task.index);statusLatencies.push(result.latency);});
 let crossTenantLeaks=0;
 if(tenants.length>1)for(const task of admitted.slice(0,10)){const other=tenants.find(t=>t.organizationId!==task.tenant.organizationId);try{await apiCall(other,`/tasks/${task.id}`);crossTenantLeaks++;}catch(error){if(![403,404].includes((error as any).status))throw error;}}
 const anomalies=(await snapshot.query(`SELECT
 (SELECT count(*) FROM agents_platform.tasks t WHERE t.parent_task_id IS NULL AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain'))::int AS nonterminal,
 (SELECT count(*) FROM agents_platform.operation_usage u JOIN agents_platform.operations o ON o.id=u.operation_id WHERE o.task_id<>u.task_id)::int AS incorrect_settlement,
 (SELECT count(*) FROM agents_platform.execution_roots r WHERE r.tokens_used<>(SELECT coalesce(sum(u.accounted_tokens),0) FROM agents_platform.operation_usage u JOIN agents_platform.tasks t ON t.id=u.task_id WHERE t.root_task_id=r.root_task_id))::int AS root_charge_mismatch,
 (SELECT count(*) FROM agents_platform.usage_reservations r JOIN agents_platform.tasks t ON t.id=r.task_id WHERE t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain') AND r.settled_at IS NULL)::int AS unsettled_terminal_reservations,
 (SELECT count(*) FROM agents_platform.tasks WHERE parent_task_id IS NULL)::int AS persisted_roots,
 (SELECT count(*) FROM(SELECT task_id,event_key,count(*) FROM agents_platform.task_events GROUP BY task_id,event_key HAVING count(*)>1) d)::int AS duplicate_events`)).rows[0];
 const coordination=(await snapshot.query(`SELECT
 (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM(dispatched_at-created_at))*1000) FROM agents_platform.task_outbox WHERE dispatched_at IS NOT NULL) AS dispatch_lag_p95_ms,
 (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM(granted_at-created_at))*1000) FROM agents_platform.capacity_requests WHERE granted_at IS NOT NULL) AS permit_wait_p95_ms,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')::int AS current_lock_waiters,
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database())::int AS database_connections`)).rows[0];
 const sourceAfter=await sourceIdentity();
 const outcomes=(await snapshot.query(`SELECT parent_task_id IS NOT NULL AS child,channel_binding IS NOT NULL AS website,state,error_code,count(*)::int n FROM agents_platform.tasks GROUP BY child,website,state,error_code ORDER BY child,website,state,error_code`)).rows;
 const tenantFairness=(await snapshot.query(`SELECT t.organization_id,count(*)::int roots,count(*) FILTER(WHERE t.state='completed')::int completed,percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM(o.dispatched_at-o.created_at))*1000) AS dispatch_p95_ms FROM agents_platform.tasks t LEFT JOIN agents_platform.task_outbox o ON o.task_id=t.id WHERE t.parent_task_id IS NULL AND t.channel_binding IS NULL GROUP BY t.organization_id`)).rows;
 const operationFailures=(await snapshot.query(`SELECT kind,name,state,error_code,count(*)::int n,percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM(completed_at-started_at))*1000) AS elapsed_p95_ms FROM agents_platform.operations WHERE state IN ('failed','uncertain') GROUP BY kind,name,state,error_code`)).rows;
 const controlRoots=Number((await snapshot.query('SELECT count(*)::int n FROM agents_platform.tasks WHERE parent_task_id IS NULL AND channel_binding IS NOT NULL')).rows[0].n);
 const grounding=full?(await snapshot.query(`SELECT count(*)::int configured,count(*) FILTER(WHERE t.state='completed')::int completed,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM agents_platform.evidence_references e WHERE e.task_id=t.id AND e.source_id IS NOT NULL))::int evidence_bound,count(*) FILTER(WHERE t.output~'E[a-f0-9]{32}')::int cited FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE t.parent_task_id IS NULL AND t.channel_binding IS NULL AND jsonb_array_length(coalesce(t.effective_configuration,v.configuration)->'sourceRevisionIds')>0`)).rows[0]:null;
 const physicalEffects=full?(await snapshot.query(`SELECT (SELECT count(*)::int FROM agents_platform.actions WHERE state='delivered') AS delivered,(SELECT count(*)::int FROM report_delivery_receiver.deliveries) AS receiver_deliveries`)).rows[0]:null;
 await snapshot.query('COMMIT');snapshot.release();
 const diagnosticPlans=await diagnostics.plans(),collector=services?.collectorEvidence();
 const report={version:'controlled-platform-load.v1',runId,code:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),source:{before:sourceBefore,after:sourceAfter,stable:sourceBefore.digest===sourceAfter.digest},environment:{node:process.version,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),freeMemoryBytes:freemem()},runtime:{image,configurationDigest:createHash('sha256').update(runtimeConfig).digest('hex'),configurationPath:`.audit/agents-restate-config-${runId}.toml`,sdk:'1.17.3',workflow:WORKFLOW_NAME,harness:HARNESS_RELEASE},configuration:{full,noisy,barrier,runtimeMemoryMiB,runtimeCpus,invokerLimit,apiPool,workerPool,acquireTimeoutMs,workloadContract:full?workload:undefined,fault,controlledProvider:{modelDelayMs,slowDelayMs},childHeapMiB:{api:256,worker:workerHeapMiB},mode:full?'full-mixed-v2':baseline?'pre-capacity-wiring-baseline':'exploratory',rootTarget:rootCount,replicas,tenants:tenantCount,single,policy,workload:{direct:60,tool:20,delegation:10,slow:10},duration:full?'steady30s then burst10s then drain120s':'burst then drain120s'},coordination,barrierFacts,diagnostics:{samples:diagnostics.samples,plans:diagnosticPlans,databaseErrors,operationFailures},controls,controlRoots,tenantFairness,review:{decisions:reviewLatencies.length,p95Ms:percentile(reviewLatencies,.95),errors:reviewErrors},collector,physicalEffects,grounding,faultEvents,processResources,processExits,achieved:{accepted:admitted.length,rejected:rootCount-admitted.length,admissionMs:acceptedAt-started,elapsedMs:Date.now()-started,peakRunningRoots,peakWaitingRoots,peakActiveModelCalls:peakModels,modelRequests,modelCallsByWorker,states,outcomes,throttled,errors},latency:{admissionP50:percentile(admissionLatencies,.5),admissionP95:percentile(admissionLatencies,.95),admissionP99:percentile(admissionLatencies,.99),statusP95:percentile(statusLatencies,.95),liveStatusP95:percentile(liveStatusLatencies,.95),liveStatusSamples:liveStatusLatencies.length},anomalies:{...anomalies,crossTenantLeaks},crossReplicaCursor:{passed:true,replicas},samples,unmet:['approved-source FAQ grounding subset','delayed approval and hot-conversation ownership mix','30s sustained/10s burst timing','worker loss,lease expiry,provider throttling,collector outage,reconnect fault stages','full root-to-physical-effect and per-tenant fairness audit','active concurrency target requires measured peak, accepted backlog is insufficient']};
 if(full){report.unmet=report.unmet.filter(item=>!['approved-source FAQ grounding subset','delayed approval and hot-conversation ownership mix','30s sustained/10s burst timing'].includes(item));if(grounding?.configured!==rootCount*0.6)report.unmet.push('Expected grounded configuration count missing');if(grounding?.completed!==grounding?.cited||grounding?.completed!==grounding?.evidence_bound)report.unmet.push('Grounded completion lacks native evidence/citations');if(fault==='none'&&reviewLatencies.length!==rootCount/10)report.unmet.push('Expected report review decisions missing');if(controls?.errors.length)report.unmet.push('Website control errors: '+controls.errors.join(', '));if(reviewErrors.length)report.unmet.push('Report review failures');if(!collector?.traces||!collector?.metrics)report.unmet.push('Actual Collector trace/metric evidence missing');if(collector?.privateContentLeaked)report.unmet.push('Private canary entered telemetry');if((percentile(liveStatusLatencies,.95)??Infinity)>5000)report.unmet.push('Interactive latency threshold failed');if((percentile(controls?.latencies??[],.95)??Infinity)>5000)report.unmet.push('Ownership control latency threshold failed');if(Number(coordination.dispatch_lag_p95_ms)>30000)report.unmet.push('Queue age threshold failed');}
 if(barrierFacts&&barrierFacts.rootsAtRelease!==rootCount){report.unmet.push('Simultaneous nonterminal-root target not reached');process.exitCode=2;}if(barrier==='operations'&&barrierFacts!.activeModelsAtRelease<rootCount){report.unmet.push('Simultaneous active-model target not reached; recorded invoker/memory/worker limits apply');process.exitCode=2;}if(barrier==='operations'&&barrierFacts!.rootsAtRelease===rootCount&&barrierFacts!.activeModelsAtRelease>=rootCount)report.unmet=report.unmet.filter(item=>item!=='active concurrency target requires measured peak, accepted backlog is insufficient');
 if(full&&report.unmet.some(item=>/threshold failed|evidence missing|canary entered|failures|errors|lacks native|decisions missing/.test(item)))process.exitCode=2;
 const injected=(kind:string)=>faultEvents.some((item:any)=>item.kind===kind);
 if(fault==='worker-loss'&&!injected('worker-loss'))report.unmet.push('Worker loss fault was not injected into an active provider call');
 if(fault==='lease-expiry'&&!injected('abandoned-native-dispatch-lease'))report.unmet.push('Abandoned dispatch lease fault was not injected');
 if(fault==='duplicate-messages'&&!faultEvents.some((item:any)=>item.kind==='duplicate-messages'&&item.sent===40&&item.accepted===40))report.unmet.push('Duplicate delivery fault was not accepted by Restate');
 if(fault==='provider-throttle'&&!throttled)report.unmet.push('Provider throttle fault was not observed');
 if(fault==='collector-outage'&&(!injected('collector-paused')||!injected('collector-resumed')))report.unmet.push('Collector outage fault was not exercised');
 if(fault==='reconnect'&&!faultEvents.some((item:any)=>item.kind==='api-process-reconnect'&&item.sharedCursorVerified))report.unmet.push('API replacement did not verify the shared cursor');
 if(report.unmet.some(item=>/fault was not|did not verify/.test(item)))process.exitCode=2;
 if(sourceBefore.digest!==sourceAfter.digest){report.unmet.push('source changed during run; runtime identity requires frozen rerun');process.exitCode=2;}
 const out=resolve(repository,'.audit',`agents-load-${rootCount}-${replicas}-${single?'single':'many'}-${runId}.json`);await mkdir(resolve(repository,'.audit'),{recursive:true});await writeFile(out,JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({report:out,achieved:report.achieved,latency:report.latency,anomalies,unmet:report.unmet})+'\n');
 if((states.incomplete??0)+(states.failed??0)+(states.uncertain??0)>0||crossTenantLeaks||anomalies.nonterminal||anomalies.incorrect_settlement||anomalies.duplicate_events||anomalies.root_charge_mismatch||anomalies.unsettled_terminal_reservations||anomalies.persisted_roots!==admitted.length+controlRoots||Object.keys(errors).length||reviewErrors.length||controls?.errors.length||controls?.humanBacklogAdmissions||controls?.returnBacklogAdmissions||controls?.postTakeoverAssistantMessages||controls?.duplicateMessages||physicalEffects&&physicalEffects.delivered!==physicalEffects.receiver_deliveries)process.exitCode=2;
}
void main().catch(error=>{process.stderr.write(`Controlled load failed: ${error instanceof Error?error.message:'unknown'}\n`);process.exitCode=1;}).finally(async()=>{
 releaseBarrier();if(barrierTimer)clearTimeout(barrierTimer);stopProbes=true;stopReviews=true;await probeLoop;await reviewLoop;await diagnostics?.stop();
 for(const session of proxySessions)session?.destroy();for(const session of proxyClients)session.destroy();if(proxy)await new Promise<void>(resolve=>proxy!.close(()=>resolve()));
 for(const child of children){if(child.exitCode===null)child.kill('SIGTERM');}
 await delay(500);for(const child of children){if(child.exitCode===null)child.kill('SIGKILL');}
 if(ownedContainer)docker('rm','-f',container);
 await new Promise<void>(resolve=>simulator.close(()=>resolve()));await services?.close();await pool?.end();
 if(created)await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();
});
