import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {OPERATIONS_AUTHORITY_HEADER,verifyOperationsServiceAuthority} from "@kasitek-labs/server-support/operations-authority";
import {readOperationsSource,readOperationsAudit,publicationMeasurements,type OperationsMeasurement} from "@kasitek-labs/server-support/operations-source";
export const agentsOperationsMeasurements:OperationsMeasurement[]=[...publicationMeasurements,
 {key:"execution.failure_rate_bps",group:"execution",unit:"basis_points",minimumSamples:20,sql:`SELECT CASE WHEN count(*)=0 THEN NULL ELSE (count(*) FILTER(WHERE state IN ('failed','uncertain'))*10000/count(*))::text END value,count(*)::text denominator,now()-interval '5 minutes' window_start,now() window_end FROM agents_platform.tasks WHERE evaluation_trial_id IS NULL AND state IN ('completed','failed','uncertain','cancelled','refused','incomplete') AND updated_at>=now()-interval '5 minutes'`,sampleSql:`SELECT 'task' resource_type,id::text resource_id,organization_id::text customer_id FROM agents_platform.tasks WHERE evaluation_trial_id IS NULL AND state IN ('failed','uncertain') AND updated_at>=now()-interval '5 minutes' ORDER BY updated_at DESC,id LIMIT 20`},
 {key:"execution.dispatch_overdue_seconds",group:"execution",unit:"seconds",sql:`SELECT COALESCE(GREATEST(0,floor(extract(epoch FROM now()-min(o.available_at))))::text,'0') value FROM agents_platform.task_outbox o JOIN agents_platform.tasks t ON t.id=o.task_id WHERE o.dispatched_at IS NULL AND o.available_at<=now() AND (o.lease_until IS NULL OR o.lease_until<=now()) AND t.state='accepted' AND t.evaluation_trial_id IS NULL`,sampleSql:`SELECT 'task' resource_type,t.id::text resource_id,t.organization_id::text customer_id FROM agents_platform.task_outbox o JOIN agents_platform.tasks t ON t.id=o.task_id WHERE o.dispatched_at IS NULL AND o.available_at<=now() AND (o.lease_until IS NULL OR o.lease_until<=now()) AND t.state='accepted' AND t.evaluation_trial_id IS NULL ORDER BY o.available_at,t.id LIMIT 20`},
 {key:"recovery.pending_age_seconds",group:"recovery",unit:"seconds",sql:`SELECT COALESCE(GREATEST(0,floor(extract(epoch FROM now()-min(created_at))))::text,'0') value FROM agents_platform.admin_customer_operations WHERE status='pending'`},

];
export const agentsAuditSql=`SELECT id,actor_id,action,status,organization_id::text customer_id,'task'::text resource_type,target_id::text resource_id,id operation_id,code,created_at occurred_at FROM agents_platform.admin_customer_operations`;
export function registerOperationsSource(app:FastifyInstance,pool:Pool,env:NodeJS.ProcessEnv=process.env){
 app.get("/internal/operations/signals",async(request,reply)=>{
  const secret=env.OPS_OBSERVER_SECRET,token=request.headers[OPERATIONS_AUTHORITY_HEADER];
  try{if(!secret||typeof token!=="string")throw Error();verifyOperationsServiceAuthority(token,{secret,audience:"agents",scope:"signals:read",method:"GET",path:request.url,environment:env.OPS_ENVIRONMENT??"development"});}catch{return reply.code(403).send({error:"Insufficient observer authority"});}
  return readOperationsSource(pool,"agents",env,agentsOperationsMeasurements);
 });
}
export function readSourceAudit(pool:Pool,env:NodeJS.ProcessEnv,query:Record<string,unknown>){return readOperationsAudit(pool,"agents",env.OPS_ENVIRONMENT??"development",agentsAuditSql,query);}
