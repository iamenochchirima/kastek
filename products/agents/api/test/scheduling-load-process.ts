/** Controlled local acceptance process. Never imported by production entry points. */
import {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {createServer,type ServerHttp2Session} from 'node:http2';
import {createEndpointHandler} from '@restatedev/restate-sdk';
import {createBusinessWorkflow} from '../src/execution/business/business';
import {buildPlatformApp} from '../src/composition/app';
import {loadPlatformConfig} from '../src/infrastructure/config';
import {startDispatcher} from '../src/execution/lifecycle/dispatcher';
import {databasePoolOptions} from '../src/infrastructure/pool-policy';
import {privateStoreFromEnvironment} from '../src/infrastructure/object-store';
import {EvidenceStore} from '../src/execution/context/evidence';
import {KnowledgeRuntime} from '../src/capabilities/knowledge/knowledge-runtime';
import {TaskArtifactStore} from '../src/execution/artifacts/task-artifacts';
import {actionsFromEnvironment} from '../src/composition/actions';
import {composeInbox} from '../src/composition/inbox';
import {createObservationTelemetry,startObservationPublisher} from '../src/observability/telemetry';
import {createNativeMetrics} from '../src/observability/metrics';
import {observeFixtureDatabaseErrors} from './scheduling-load-diagnostics';
const role=process.env.AGENTS_LOAD_ROLE;
if(!['api','worker'].includes(role??'')||!process.env.AGENTS_LOAD_SIMULATOR_URL)throw Error('Load fixture configuration missing');
const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL,...databasePoolOptions(role as 'api'|'worker')});
observeFixtureDatabaseErrors(pool);
async function main(){
 const telemetry=startObservationPublisher(pool,createObservationTelemetry(`agents-load-${role}`)),nativeMetrics=createNativeMetrics(pool,role!);
 async function closeTelemetry(){await telemetry.stop();await nativeMetrics?.shutdown();}
 let cpu=process.cpuUsage();
 const metrics=setInterval(()=>{const current=process.cpuUsage(),cpuPercent=(current.user+current.system-cpu.user-cpu.system)/10000;cpu=current;process.stdout.write(JSON.stringify({fixtureMetrics:true,role,pid:process.pid,cpuPercent,poolTotal:pool.totalCount,poolIdle:pool.idleCount,poolWaiting:pool.waitingCount,...process.memoryUsage()})+'\n');},1000);metrics.unref();
 if(role==='api'){
  const app=await buildPlatformApp({pool,config:loadPlatformConfig(),logging:false});const endpoint=await app.listen({host:'127.0.0.1',port:0});
  process.stdout.write(JSON.stringify({fixtureReady:true,role,endpoint})+'\n');
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void app.close().then(closeTelemetry).then(()=>pool.end()).then(()=>process.exit(0));});
 }else{
  const simulator=process.env.AGENTS_LOAD_SIMULATOR_URL!,sessions=new Set<ServerHttp2Session>();
  const objects=privateStoreFromEnvironment(),evidence=objects?new EvidenceStore(pool,objects):undefined,artifacts=new TaskArtifactStore(pool,objects),actionServices=actionsFromEnvironment(pool,artifacts);
  const inbox=composeInbox(pool,{publicOrigin:'http://localhost:3100',assertServices:async()=>{}});
  const cancellationTimer=setInterval(()=>{void inbox.drainCancellations().catch(()=>{});},1000);cancellationTimer.unref();
  const workflow=createBusinessWorkflow(pool,{openRouterApiKey:'controlled-fixture-only',evidence,knowledgeRuntime:evidence?new KnowledgeRuntime(pool,evidence):undefined,actions:actionServices?.actions,selectReportArtifact:(taskId,name,output)=>artifacts.prepareReport(taskId,name,output),fetch:async(_url,options)=>{const headers=new Headers(options?.headers);headers.set('x-fixture-worker-id',process.env.AGENTS_LOAD_WORKER_ID??'worker');
   if(process.env.AGENTS_LOAD_TRACE_PHYSICAL==='1'){
    const digest=createHash('sha256').update(String(options?.body)).digest('hex');
    const matches=(await pool.query(`SELECT o.id,o.attempt_id,o.task_id,t.root_task_id FROM agents_platform.context_snapshots s JOIN agents_platform.operations o ON o.task_id=s.task_id AND o.id='model:'||s.task_id::text||':'||s.step::text JOIN agents_platform.tasks t ON t.id=o.task_id WHERE s.digest=$1 AND o.kind='model' AND o.state='started' LIMIT 2`,[digest])).rows;
    headers.set('x-fixture-attribution-count',String(matches.length));
    if(matches.length===1){for(const[key,value]of Object.entries(matches[0]))headers.set(`x-fixture-${key}`,String(value));}
   }
   return fetch(simulator,{...options,headers});}});
  const server=createServer(createEndpointHandler({services:[workflow]}));server.on('session',session=>{sessions.add(session);session.once('close',()=>sessions.delete(session));});
  await new Promise<void>(resolve=>server.listen(Number(process.env.AGENTS_LOAD_WORKER_PORT??0),'0.0.0.0',resolve));const port=(server.address() as {port:number}).port;
  const dispatcher=startDispatcher(pool,{ingressUrl:process.env.RESTATE_INGRESS_URL!,adminUrl:process.env.RESTATE_ADMIN_URL!,policy:{batchSize:128,parallelism:32}});
  process.stdout.write(JSON.stringify({fixtureReady:true,role,port})+'\n');
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{clearInterval(cancellationTimer);void dispatcher.stop().then(closeTelemetry).then(()=>{for(const session of sessions)session.destroy();server.close(()=>{void pool.end().then(()=>process.exit(0));});});});
 }
}
void main().catch(()=>{process.stderr.write('Controlled load process startup failed\n');process.exitCode=1;});
