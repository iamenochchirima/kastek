import {loadServiceEnvironment} from "@kasitek-labs/server-support/config";
import {config as loadEnvironment} from 'dotenv';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
/** Instrument pg/Fastify before loading them, and retain the local .env convention. */
export async function boot():Promise<void> {
 loadServiceEnvironment(fileURLToPath(new URL('../.env',import.meta.url)),path=>loadEnvironment(path===undefined?{}:{path}));
 process.env.TZ='UTC';
 const {initTelemetry}=await import('@kasitek-labs/server-support/telemetry');
 const telemetry=initTelemetry('kasitek-tenants');
 let closing:Promise<void>|undefined;
 const shutdownTelemetry=()=>closing??=telemetry.shutdown();
 try { const {start}=await import('./main.js');await start({shutdownTelemetry}); }
 catch(error){await shutdownTelemetry();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))boot().catch(()=>{
 console.error('Tenant startup failed. Check service configuration, migration state and database availability.');
 process.exitCode=1;
});
