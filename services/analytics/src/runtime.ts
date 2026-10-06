import {config as loadDotenv} from 'dotenv';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readConfig} from './config.js';
import {loadRegistry} from './registry.js';
import {createPool} from './db.js';
import {ProcessMetrics} from './metrics.js';
import {buildApp} from './app.js';
import type {ProcessKind} from './contracts.js';
import {initTelemetry} from '@kasitek-labs/server-support/telemetry';

export function loadLocalEnvironment():void{
 const local=fileURLToPath(new URL('../.env',import.meta.url));
 const loaded=loadDotenv({path:local});
 if(loaded.error)loadDotenv();
}

export async function runApi():Promise<void>{
 loadLocalEnvironment();
 const config=readConfig(),telemetry=initTelemetry('kasitek-analytics-api'),registry=await loadRegistry(),pool=createPool(config),metrics=new ProcessMetrics();
 metrics.log('info','service.startup',{process:'analytics-api',phase:'registry_loaded',registry_sha256:registry.sha256,metrics_registry_version:registry.metrics_registry_version});
 const app=await buildApp({pool,config,registry,metrics},'analytics-api');
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  await app.close().catch(()=>{});
  await pool.end().catch(()=>{});
  await telemetry.shutdown();
 })();
 const shutdown=()=>{void close().then(()=>process.exit(0),()=>process.exit(1));};
 process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 try{
  await app.listen({host:config.api_host,port:config.api_port});
  metrics.log('info','service.startup',{process:'analytics-api',port:config.api_port});
 }catch(error){
  await close();
  throw error;
 }
}

export async function runWorkerProcess():Promise<void>{
 loadLocalEnvironment();
 const config=readConfig(),telemetry=initTelemetry('kasitek-analytics-worker'),registry=await loadRegistry(),pool=createPool(config),metrics=new ProcessMetrics();
 const {runWorker}=await import('./worker.js'),controller=new AbortController();
 const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 metrics.log('info','service.startup',{process:'analytics-worker',phase:'registry_loaded',registry_sha256:registry.sha256,metrics_registry_version:registry.metrics_registry_version});
 try{await runWorker(pool,registry,controller.signal,metrics);}
 finally{await pool.end();await telemetry.shutdown();}
}

export async function runMigrationsProcess():Promise<void>{
 loadLocalEnvironment();
 const config=readConfig(),telemetry=initTelemetry('kasitek-analytics-migrate'),registry=await loadRegistry();
 const {connectPool}=await import('./db.js'),{run}=await import('./migrations.js'),pool=await connectPool(config);
 const metrics=new ProcessMetrics();metrics.log('info','service.startup',{process:'analytics-migrate',phase:'registry_loaded',registry_sha256:registry.sha256,metrics_registry_version:registry.metrics_registry_version});
 try{metrics.log('info','migration.started',{process:'analytics-migrate',environment:config.environment});await run(pool);metrics.log('info','migration.completed',{process:'analytics-migrate'});}
 finally{await pool.end();await telemetry.shutdown();}
}

export async function runRegistryProcess(args=process.argv.slice(2)):Promise<void>{
 const write=args.includes('--write'),check=args.includes('--check');
 if(write&&check)throw Error('Choose only one of --write or --check');
 if(args.some(arg=>arg!=='--write'&&arg!=='--check'))throw Error('Usage: analytics-registry [--check|--write]');
 const {checkGeneratedBindings,loadRegistry,writeGeneratedBindings}=await import('./registry.js'),registry=await loadRegistry();
 if(write)await writeGeneratedBindings(registry);else await checkGeneratedBindings(registry);
 process.stdout.write(`${write?'Generated':'Validated'} analytics registry bindings: metrics_registry=${registry.metrics_registry_version} contracts=${registry.contracts.length} metrics=${registry.metrics.length} dimensions=${registry.dimensions.length} metric_sets=${registry.metric_sets.length} sha256=${registry.sha256}\n`);
}

export function isEntrypoint(moduleUrl:string):boolean{return resolve(process.argv[1]??'')===resolve(fileURLToPath(moduleUrl));}
