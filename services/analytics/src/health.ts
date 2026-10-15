import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {FOUNDATION_MIGRATION_VERSION} from './migrations.js';
import {SERVICE_NAME,type ProcessKind,type LivenessResponse,type ReadinessResponse} from './contracts.js';
import type {ProcessMetrics} from './metrics.js';

export function readinessResponse(process:ProcessKind,postgresReady:boolean,migrationsReady:boolean,now=new Date()):ReadinessResponse{
 const ready=postgresReady&&migrationsReady;
 return {status:ready?'ready':'not_ready',service:SERVICE_NAME,process,timestamp:now.toISOString(),dependencies:{postgres:{status:postgresReady?'ready':'unavailable'},migrations:{status:!postgresReady?'unavailable':migrationsReady?'ready':'pending'}}};
}

export function registerHealthRoutes(app:FastifyInstance,pool:Pool,process:ProcessKind,metrics:ProcessMetrics):void {
 const live=():LivenessResponse=>{metrics.recordLiveness();return {status:'ok',service:SERVICE_NAME,process,timestamp:new Date().toISOString()};};
 app.get('/health',async(_request,reply)=>reply.code(200).send(live()));
 app.get('/health/live',async(_request,reply)=>reply.code(200).send(live()));
 app.get('/health/ready',async(_request,reply)=>{
  let postgresReady=false,migrationsReady=false;
  try {
   await pool.query('SELECT 1');postgresReady=true;
   const result=await pool.query<{ready:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') AND EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = $1 AND success = TRUE) AS ready`,[FOUNDATION_MIGRATION_VERSION.toString()]);
   migrationsReady=result.rows[0]?.ready===true;
  } catch { /* Health response reports dependency state without leaking database details. */ }
  const body=readinessResponse(process,postgresReady,migrationsReady);
  metrics.recordReadiness(body.status==='ready');
  return reply.code(body.status==='ready'?200:503).send(body);
 });
}
