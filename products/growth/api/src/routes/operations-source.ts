import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {OPERATIONS_AUTHORITY_HEADER,verifyOperationsServiceAuthority} from "@kasitek-labs/server-support/operations-authority";
import {readOperationsSource,readOperationsAudit,publicationMeasurements,type OperationsMeasurement} from "@kasitek-labs/server-support/operations-source";
const webhookFrom=`FROM "PublicApiWebhookDelivery" d JOIN "PublicApiWebhookSubscription" s ON s.id=d."subscriptionId"`;
// Match the owning delivery worker's five-minute claim recovery and retry scheduling.
const webhookDue=`s.status='ACTIVE' AND d."nextAttemptAt"<=now() AND (d.status='PENDING' OR (d.status='DELIVERING' AND d."updatedAt"<now()-interval '5 minutes'))`;
const webhookEligibleAt=`CASE WHEN d.status='DELIVERING' THEN GREATEST(d."nextAttemptAt",d."updatedAt"+interval '5 minutes') ELSE d."nextAttemptAt" END`;
export const growthWebhookMeasurements:OperationsMeasurement[]=[
 {key:'webhook.overdue_seconds',group:'webhooks',unit:'seconds',sql:`SELECT COALESCE(GREATEST(0,floor(extract(epoch FROM now()-min(${webhookEligibleAt}))))::text,'0') value ${webhookFrom} WHERE ${webhookDue}`,sampleSql:`SELECT 'webhook_delivery' resource_type,d.id resource_id,s."orgId" customer_id ${webhookFrom} WHERE ${webhookDue} ORDER BY ${webhookEligibleAt},d.id LIMIT 20`},
 {key:'webhook.failed',group:'webhooks',unit:'count',sql:`SELECT count(*)::text value ${webhookFrom} WHERE d.status='FAILED'`,sampleSql:`SELECT 'webhook_delivery' resource_type,d.id resource_id,s."orgId" customer_id ${webhookFrom} WHERE d.status='FAILED' ORDER BY d."updatedAt" DESC,d.id LIMIT 20`}
];
export const growthOperationsMeasurements:OperationsMeasurement[]=[...publicationMeasurements,...growthWebhookMeasurements,
 {key:"recovery.pending_age_seconds",group:"recovery",unit:"seconds",sql:`SELECT COALESCE(GREATEST(0,floor(extract(epoch FROM now()-min("updatedAt"))))::text,'0') value FROM "AdminWebhookReplayCommand" WHERE status='completed' AND \"customerId\" IS NOT NULL AND \"settledStatus\" IS NULL`},

];
export const growthAuditSql=`SELECT 'replay:'||a.id id,a."actorId" actor_id,'webhook.replay.'||a.action action,'recorded' status,c."customerId" customer_id,'webhook_replay' resource_type,a."commandId" resource_id,a."commandId" operation_id,NULL::text code,a."createdAt" occurred_at FROM "AdminWebhookReplayAuditEvent" a JOIN "AdminWebhookReplayCommand" c ON c.id=a."commandId" UNION ALL SELECT 'support:'||a.id,a."actorId",'support.'||a.action,'recorded',g."organizationId",'support_grant',a."grantId",a."grantId",NULL::text,a."createdAt" FROM "AdminSupportAccessAuditEvent" a JOIN "AdminSupportAccessGrant" g ON g.id=a."grantId" UNION ALL SELECT 'export:'||id,"adminId",'report.export',status,NULL::text,'report',"reportKey",id,NULL::text,"createdAt" FROM "AdminReportExportAuditEvent" UNION ALL SELECT 'commercial:'||id,"actorId",action,'recorded',NULL::text,'commercial',"resourceId",id,NULL::text,"createdAt" FROM "AdminCommercialAudit"`;
export function registerOperationsSource(app:FastifyInstance,pool:Pool,env:NodeJS.ProcessEnv=process.env){
 app.get("/internal/operations/signals",async(request,reply)=>{
  const secret=env.OPS_OBSERVER_SECRET,token=request.headers[OPERATIONS_AUTHORITY_HEADER];
  try{if(!secret||typeof token!=="string")throw Error();verifyOperationsServiceAuthority(token,{secret,audience:"growth",scope:"signals:read",method:"GET",path:request.url,environment:env.OPS_ENVIRONMENT??"development"});}catch{return reply.code(403).send({error:"Insufficient observer authority"});}
  return readOperationsSource(pool,"growth",env,growthOperationsMeasurements);
 });
}
export function readSourceAudit(pool:Pool,env:NodeJS.ProcessEnv,query:Record<string,unknown>){return readOperationsAudit(pool,"growth",env.OPS_ENVIRONMENT??"development",growthAuditSql,query);}
