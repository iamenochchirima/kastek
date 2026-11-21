/** Controlled local acceptance process. Never imported by production entry points. */
import {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {createServer,type ServerHttp2Session} from 'node:http2';
import {createEndpointHandler} from '@restatedev/restate-sdk';
import {createBusinessWorkflow} from '../src/execution/business/business';
import {buildPlatformApp} from '../src/composition/app';
import {loadPlatformConfig} from '../src/infrastructure/config';
import {requestDigest as canonicalDigest} from '../src/contracts/contracts';
import {startDispatcher} from '../src/execution/lifecycle/dispatcher';
import {SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME} from '../src/contracts/execution';
import {dispatchPolicyFromEnvironment} from '../src/execution/scheduling/dispatch-claims';
import {databasePoolOptions} from '../src/infrastructure/pool-policy';
import {privateStoreFromEnvironment} from '../src/infrastructure/object-store';
import {fixtureModelProviders} from './model-fixture';
import {dispatchBoundModel} from '../src/execution/models/dispatch';
import {MemoryStore} from '../src/platform/memory/memory';
import {skillPackageCodec} from '../src/capabilities/skills/package';
import {EvidenceStore} from '../src/execution/context/evidence';
import {KnowledgeRuntime} from '../src/platform/knowledge/knowledge-runtime';
import {TaskArtifactStore} from '../src/execution/artifacts/task-artifacts';
import {actionsFromEnvironment} from '../src/composition/actions';
import {composeInbox} from '../src/composition/inbox';
import {createObservationTelemetry,startObservationPublisher} from '../src/observability/telemetry';
import {createNativeMetrics} from '../src/observability/metrics';
import {observeFixtureDatabaseErrors} from './scheduling-load-diagnostics';
import {dispatcherPhaseTimings} from './scheduling-load-phases';
import {fixtureProfiler,profilePath} from './scheduling-load-profile';
import {resolve} from 'node:path';
const role=process.env.AGENTS_LOAD_ROLE;
const dispatcherPhases=dispatcherPhaseTimings();
if(!['api','worker'].includes(role??'')||!process.env.AGENTS_LOAD_SIMULATOR_URL)throw Error('Load fixture configuration missing');
const dispatchPolicy=dispatchPolicyFromEnvironment();
const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL,...databasePoolOptions(role as 'api'|'worker')});
const profiler=process.env.AGENTS_LOAD_PROFILE_RUN?fixtureProfiler({path:profilePath(resolve(__dirname,'../../../..'),process.env.AGENTS_LOAD_PROFILE_RUN,role!,Number(process.env.AGENTS_LOAD_PROFILE_INDEX)),emit:item=>process.stdout.write(JSON.stringify(item)+'\n')}):undefined;
if(profiler)process.on('SIGUSR2',profiler.start);
observeFixtureDatabaseErrors(pool,profiler?.timings);
async function main(){
 const telemetry=startObservationPublisher(pool,createObservationTelemetry(`agents-load-${role}`)),nativeMetrics=createNativeMetrics(pool,role!);
 async function closeTelemetry(){await profiler?.stop('shutdown');await telemetry.stop();await nativeMetrics?.shutdown();}
 let cpu=process.cpuUsage();
 const metrics=setInterval(()=>{const current=process.cpuUsage(),cpuPercent=(current.user+current.system-cpu.user-cpu.system)/10000;cpu=current;process.stdout.write(JSON.stringify({fixtureMetrics:true,role,pid:process.pid,cpuPercent,poolTotal:pool.totalCount,poolIdle:pool.idleCount,poolWaiting:pool.waitingCount,...process.memoryUsage(),...(role==='worker'?{dispatcherPhases:dispatcherPhases.snapshot()}:{})})+'\n');},1000);metrics.unref();
 if(role==='api'){
  const app=await buildPlatformApp({pool,config:loadPlatformConfig(),logging:false});const endpoint=await app.listen({host:'127.0.0.1',port:0});
  process.stdout.write(JSON.stringify({fixtureReady:true,role,endpoint})+'\n');
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void Promise.resolve(profiler?.stop('shutdown')).then(()=>app.close()).then(closeTelemetry).then(()=>pool.end()).then(()=>process.exit(0));});
 }else{
  const simulator=process.env.AGENTS_LOAD_SIMULATOR_URL!,sessions=new Set<ServerHttp2Session>();
  const objects=privateStoreFromEnvironment(),evidence=objects?new EvidenceStore(pool,objects):undefined,artifacts=new TaskArtifactStore(pool,objects),actionServices=actionsFromEnvironment(pool,artifacts);
  const inbox=composeInbox(pool,{publicOrigin:'http://localhost:3100',assertServices:async()=>{}});
  const cancellationTimer=setInterval(()=>{void inbox.drainCancellations().catch(()=>{});},1000);cancellationTimer.unref();
  const payloadAttribution=new Map<string,{operationId?:string;attemptId?:string;taskId?:string;rootTaskId?:string}>();
  const controlledFetch=async(_url:string,options:RequestInit|undefined)=>{
   const headers=new Headers(options?.headers);headers.set('x-fixture-worker-id',process.env.AGENTS_LOAD_WORKER_ID??'worker');
   if(process.env.AGENTS_LOAD_TRACE_PHYSICAL==='1'){
    const payload=JSON.parse(String(options?.body)),attrs=payloadAttribution.get(canonicalDigest(payload));
    if(attrs){
     headers.set('x-fixture-attribution-count','1');
     if(attrs.operationId)headers.set('x-fixture-id',attrs.operationId);
     if(attrs.attemptId)headers.set('x-fixture-attempt_id',attrs.attemptId);
     if(attrs.taskId)headers.set('x-fixture-task_id',attrs.taskId);
     if(attrs.rootTaskId)headers.set('x-fixture-root_task_id',attrs.rootTaskId);
    }
   }
   const response=await fetch(simulator,{...options,headers});
   if(response.status!==200||response.headers.get('content-type')?.includes('text/event-stream'))return response;
   const result=await response.json(),choice=result.choices?.[0];
   const delta={...choice?.message,...(choice?.message?.tool_calls?{tool_calls:choice.message.tool_calls.map((call:any,index:number)=>({...call,index}))}:{})};
   return new Response(`data: ${JSON.stringify({id:result.id,model:result.model,choices:[{index:0,delta,finish_reason:choice?.finish_reason}],usage:result.usage})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const workflow=createBusinessWorkflow(pool,{modelProvider:fixtureModelProviders(pool),modelRuntime:{dispatch:input=>dispatchBoundModel({...input,
    onPhysicalPayload:(digest,operationId,attemptId)=>{payloadAttribution.set(digest,{operationId,attemptId,taskId:input.taskId,rootTaskId:input.rootTaskId});input.onPhysicalPayload?.(digest,operationId,attemptId);},beforePayloadDispatch:async(payload,count)=>{await input.beforePayloadDispatch?.(payload,count);}},()=>{
    const network=(async(url,init)=>controlledFetch(String(url),init)) as typeof fetch&{markProgress?:()=>void};network.markProgress=()=>{};return network;
  })},readers:{memory:new MemoryStore(pool,skillPackageCodec)},evidence,knowledgeRuntime:evidence?new KnowledgeRuntime(pool,evidence):undefined,actions:actionServices?.actions,selectReportArtifact:(taskId,name,output)=>artifacts.prepareReport(taskId,name,output)},{release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME});
  const server=createServer(createEndpointHandler({services:[workflow]}));server.on('session',session=>{sessions.add(session);session.once('close',()=>sessions.delete(session));});
  await new Promise<void>(resolve=>server.listen(Number(process.env.AGENTS_LOAD_WORKER_PORT??0),'0.0.0.0',resolve));const port=(server.address() as {port:number}).port;
  const dispatcher=startDispatcher(pool,{ingressUrl:process.env.RESTATE_INGRESS_URL!,adminUrl:process.env.RESTATE_ADMIN_URL!,runtimeRoutes:{[SHARED_HARNESS_RELEASE]:{ingressUrl:process.env.RESTATE_INGRESS_URL!,adminUrl:process.env.RESTATE_ADMIN_URL!,workflowName:SHARED_WORKFLOW_NAME}},policy:dispatchPolicy,onPhase:(phase,durationMs,success)=>{dispatcherPhases.observe(phase,durationMs,success);nativeMetrics?.dispatcherPhase(phase,durationMs,success);}});
  process.stdout.write(JSON.stringify({fixtureReady:true,role,port,dispatchPolicy})+'\n');
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{clearInterval(cancellationTimer);void Promise.resolve(profiler?.stop('shutdown')).then(()=>dispatcher.stop()).then(closeTelemetry).then(()=>{for(const session of sessions)session.destroy();server.close(()=>{void pool.end().then(()=>process.exit(0));});});});
 }
}
void main().catch(()=>{process.stderr.write('Controlled load process startup failed\n');process.exitCode=1;});
