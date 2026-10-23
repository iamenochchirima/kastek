import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {OPERATIONS_AUTHORITY_HEADER,verifyOperationsServiceAuthority} from "@kasitek-labs/server-support/operations-authority";
import {readOperationsSource,readOperationsAudit,publicationMeasurements,type OperationsMeasurement} from "@kasitek-labs/server-support/operations-source";
export const agencyOperationsMeasurements:OperationsMeasurement[]=[...publicationMeasurements,
 {key:"execution.failure_rate_bps",group:"execution",unit:"basis_points",unsupported:true},
 {key:"recovery.pending_age_seconds",group:"recovery",unit:"seconds",unsupported:true},

];
export const agencyAuditSql=`SELECT id,actor_id,action,status,workspace_id customer_id,'client'::text resource_type,target_id resource_id,id operation_id,code,created_at occurred_at FROM admin_customer_operations UNION ALL SELECT 'audit:'||id,actor_id,action,'recorded',workspace_id,COALESCE(entity_type,'admin'),COALESCE(entity_id,id),id,NULL::text,created_at FROM audit_logs WHERE actor_type IN ('admin','platform_admin')`;
export function registerOperationsSource(app:FastifyInstance,pool:Pool,env:NodeJS.ProcessEnv=process.env){
 app.get("/internal/operations/signals",async(request,reply)=>{
  const secret=env.OPS_OBSERVER_SECRET,token=request.headers[OPERATIONS_AUTHORITY_HEADER];
  try{if(!secret||typeof token!=="string")throw Error();verifyOperationsServiceAuthority(token,{secret,audience:"agency",scope:"signals:read",method:"GET",path:request.url,environment:env.OPS_ENVIRONMENT??"development"});}catch{return reply.code(403).send({error:"Insufficient observer authority"});}
  return readOperationsSource(pool,"agency",env,agencyOperationsMeasurements);
 });
}
export function readSourceAudit(pool:Pool,env:NodeJS.ProcessEnv,query:Record<string,unknown>){return readOperationsAudit(pool,"agency",env.OPS_ENVIRONMENT??"development",agencyAuditSql,query);}
