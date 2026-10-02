import type {FastifyInstance} from 'fastify';
import {resultSpan} from '@kasitek/server-support/telemetry';
import {readConfig} from './config.js';
import {createPool} from './db.js';
import {runMigrations} from './migrate.js';
import {buildApp} from './app.js';
import {routes} from './routes.js';
import {runAnalyticsPublisher,type Log} from './analytics-publisher.js';
import {runAnalyticsBackfill} from './analytics-backfill.js';
export function processWorkers(mode:string|undefined):('publisher'|'backfill')[]|null {
 if(mode==='analytics-publisher')return ['publisher','backfill'];
 if(mode==='analytics-backfill-worker')return ['backfill'];
 return null;
}
export async function start(runtime?:{shutdownTelemetry():Promise<void>}):Promise<void> {
 const config=readConfig();
 const pool=createPool(config);
 const abort=new AbortController();
 let app:FastifyInstance|undefined;
 let workerTask:Promise<void>|undefined;
 let closing:Promise<void>|undefined;
 let ready=false;
 const shutdown=()=>closing??=(async()=>{
  abort.abort();
  try {await app?.close();await workerTask?.catch(()=>{});}
  finally {await pool.end();await runtime?.shutdownTelemetry();process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);}
 })();
 const onSignal=()=>{abort.abort();if(ready)void shutdown().catch(()=>{process.exitCode=1;});};
 process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
 try {
  await resultSpan('database','postgres.connect',()=>pool.query('SELECT 1'));
  await resultSpan('migration','tenants.sqlx_migrate',()=>runMigrations(pool));
  if(abort.signal.aborted){await shutdown();return;}
  const workers=processWorkers(process.env.KASITEK_PROCESS);
  if(workers) {
   const log:Log={info:(fields,message)=>console.info(JSON.stringify({level:'info',...fields,message})),warn:(fields,message)=>console.warn(JSON.stringify({level:'warn',...fields,message})),error:(fields,message)=>console.error(JSON.stringify({level:'error',...fields,message}))};
   ready=true;
   workerTask=Promise.all(workers.map(worker=>resultSpan('worker',worker==='publisher'?'analytics_publisher':'analytics_backfill',()=>worker==='publisher'?runAnalyticsPublisher(pool,process.env,log,abort.signal):runAnalyticsBackfill(pool,process.env,log,abort.signal)))).then(()=>{});
   try {await workerTask;}finally{await shutdown();}
   return;
  }
  app=await buildApp({pool,config},routes);
  if(abort.signal.aborted){await shutdown();return;}
  await app.listen({host:'0.0.0.0',port:config.port});
  ready=true;
  if(abort.signal.aborted){await shutdown();return;}
  app.log.info({event:'service.startup',service:'kasitek-tenants',process:'api',port:config.port},'Tenant server started');
 } catch(error) {
  abort.abort();
  await shutdown().catch(()=>{});
  throw error;
 } finally {
  if(abort.signal.aborted){process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);}
 }
}
