import type {FastifyInstance} from "fastify";
import type {AnalyticsContext} from "./context.js";
import {OPERATIONS_AUTHORITY_HEADER,verifyOperationsServiceAuthority} from "@kasitek-labs/server-support/operations-authority";
import {ADMIN_AUTHORITY_HEADER,verifyAdminAuthority} from "@kasitek-labs/server-support/admin-authority";
import {readOperationsSource,readOperationsAudit} from "@kasitek-labs/server-support/operations-source";
export function registerOperationsSource(app:FastifyInstance,context:AnalyticsContext){
 app.get('/internal/operations/signals',async(request,reply)=>{const env=process.env,token=request.headers[OPERATIONS_AUTHORITY_HEADER],secret=env.OPS_OBSERVER_SECRET;
 try{if(!secret||typeof token!=='string')throw Error();verifyOperationsServiceAuthority(token,{secret,audience:'analytics',scope:'signals:read',method:'GET',path:request.url,environment:env.OPS_ENVIRONMENT??'development'});}catch{return reply.code(403).send({error:'Insufficient observer authority'});}
 return readOperationsSource(context.pool,'analytics',env,[{key:'projection.overdue_seconds',group:'projection',unit:'seconds',sql:`SELECT analytics.operations_projection_overdue_seconds() value`}]);});
 app.get('/api/admin/operations/audit',async(request,reply)=>{const token=request.headers[ADMIN_AUTHORITY_HEADER],secret=context.config.admin_reporting_secret;
 try{if(!secret||typeof token!=='string')throw Error();verifyAdminAuthority(token,{secret,audience:'analytics',method:'GET',path:request.url,capability:'admin:read'});}catch{return reply.code(403).send({error:'Insufficient admin authority'});}
 return readOperationsAudit(context.pool,'analytics',process.env.OPS_ENVIRONMENT??'development',`SELECT id::text id,actor_id,'report.read'::text action,'recorded'::text status,NULL::text customer_id,'report'::text resource_type,request_id resource_id,request_id operation_id,NULL::text code,created_at occurred_at FROM analytics.admin_reporting_audit`,request.query as Record<string,unknown>);});
}
