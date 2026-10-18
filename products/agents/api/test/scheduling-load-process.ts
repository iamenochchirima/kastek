/** Controlled local acceptance process. Never imported by production entry points. */
import {Pool} from 'pg';
import {createServer,type ServerHttp2Session} from 'node:http2';
import {createEndpointHandler} from '@restatedev/restate-sdk';
import {createBusinessWorkflow} from '../src/execution/business/business';
import {buildPlatformApp} from '../src/composition/app';
import {loadPlatformConfig} from '../src/infrastructure/config';
import {startDispatcher} from '../src/execution/lifecycle/dispatcher';
import {databasePoolOptions} from '../src/infrastructure/pool-policy';
const role=process.env.AGENTS_LOAD_ROLE;
if(!['api','worker'].includes(role??'')||!process.env.AGENTS_LOAD_SIMULATOR_URL)throw Error('Load fixture configuration missing');
const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL,...databasePoolOptions(role as 'api'|'worker')});
async function main(){
 if(role==='api'){
  const app=await buildPlatformApp({pool,config:loadPlatformConfig(),logging:false});const endpoint=await app.listen({host:'127.0.0.1',port:0});
  process.stdout.write(JSON.stringify({fixtureReady:true,role,endpoint})+'\n');
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void app.close().then(()=>pool.end()).then(()=>process.exit(0));});
 }else{
  const simulator=process.env.AGENTS_LOAD_SIMULATOR_URL!,sessions=new Set<ServerHttp2Session>();
  const workflow=createBusinessWorkflow(pool,{openRouterApiKey:'controlled-fixture-only',fetch:(_url,options)=>{const headers=new Headers(options?.headers);headers.set('x-fixture-worker-id',process.env.AGENTS_LOAD_WORKER_ID??'worker');return fetch(simulator,{...options,headers});}});
  const server=createServer(createEndpointHandler({services:[workflow]}));server.on('session',session=>{sessions.add(session);session.once('close',()=>sessions.delete(session));});
  await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));const port=(server.address() as {port:number}).port;
  const dispatcher=startDispatcher(pool,{ingressUrl:process.env.RESTATE_INGRESS_URL!,adminUrl:process.env.RESTATE_ADMIN_URL!,policy:{batchSize:128,parallelism:32}});
  process.stdout.write(JSON.stringify({fixtureReady:true,role,port})+'\n');
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void dispatcher.stop();for(const session of sessions)session.destroy();server.close(()=>{void pool.end().then(()=>process.exit(0));});});
 }
}
void main().catch(()=>{process.stderr.write('Controlled load process startup failed\n');process.exitCode=1;});
