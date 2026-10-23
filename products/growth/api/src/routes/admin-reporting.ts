import {registerOperationsNotifications} from "./operations-notifications.js";
import {registerOperationsSource,readSourceAudit} from "./operations-source.js";
import {readProductDiagnostics} from "@kasitek-labs/server-support/admin-reporting-diagnostics";
import {growthAdminTrends} from "../services/admin/reporting-trends.js";
import {canonicalJson} from "@kasitek-labs/server-support/json";
import type {FastifyInstance} from "fastify";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import type {CoreContext} from "../context.js";
import {ApiError} from "../error.js";
import {extractAdmin,grantsForRole} from "../identity/admin-session.js";
import {growthAdminReport} from "../services/admin/reporting-source.js";
export function registerAdminReportingRoutes(app:FastifyInstance,context:CoreContext) {
 registerOperationsSource(app,context.pool,context.config.env);
 registerOperationsNotifications(app,context.pool,context.config.env);
 app.get('/api/admin/operations/audit',async request=>{const actor=await extractAdmin(request,context);if(!grantsForRole(actor.role).has('admin:security'))throw new ApiError(403,'forbidden','Insufficient permissions');return readSourceAudit(context.pool,context.config.env,request.query as Record<string,unknown>);});
 app.get("/api/admin/reporting/diagnostics",async request=>{
  const actor=await extractAdmin(request,context);
  if(!grantsForRole(actor.role).has("admin:report"))throw new ApiError(403,"forbidden","Insufficient permissions");
  return readProductDiagnostics(context.pool,"growth",context.config.env);
 });
 app.get("/api/admin/reporting",async request=>{
  const actor=await extractAdmin(request,context);
  if(!grantsForRole(actor.role).has("admin:report"))throw new ApiError(403,"forbidden","Insufficient permissions");
  let query;try {query=parseAdminReportQuery(request.query as Record<string,unknown>);}catch(error){throw new ApiError(400,"bad_request",(error as Error).message);}
  if(query.consumer && query.consumer!=="growth")throw new ApiError(400,"bad_request","Invalid consumer for Growth");
  const report=await growthAdminReport(context.pool,query);
  return {...report,trends:await growthAdminTrends(context,actor,query)};
 });
 app.post("/api/admin/reporting/export/audit",async request=>{
  const actor=await extractAdmin(request,context);
  if(!grantsForRole(actor.role).has("admin:export"))throw new ApiError(403,"forbidden","Insufficient permissions");
  const body=request.body as {id?:unknown;status?:unknown;scope?:unknown};
  if(!body||typeof body.id!=="string"||!/^[0-9a-f-]{36}$/.test(body.id)||!["REQUESTED","SUCCEEDED","FAILED"].includes(String(body.status)))throw new ApiError(400,"bad_request","Invalid export audit");
  const scope=body.scope as Record<string,unknown>;
  if(!scope||typeof scope!=="object"||Array.isArray(scope)||Buffer.byteLength(canonicalJson(scope))>8192)throw new ApiError(400,"bad_request","Invalid export scope");
  if(body.status==="REQUESTED"){
   const product=scope.product??"all",domain=scope.domain??"overview";
   if(!["all","growth","agents","agency"].includes(String(product))||!["overview","usage","customers","adoption","revenue","reliability"].includes(String(domain)))throw new ApiError(400,"bad_request","Invalid export scope");
   let query;try{query=parseAdminReportQuery(Object.fromEntries(Object.entries(scope).filter(([key])=>key!=="product"&&key!=="domain")));}catch{throw new ApiError(400,"bad_request","Invalid export scope");}
   if(product==="all"&&query.organizationId)throw new ApiError(400,"bad_request","Select a product before an organization");
   await context.pool.query(`INSERT INTO "AdminReportExportAuditEvent"(id,"adminId","reportKey",days,format,status,scope,"createdAt") VALUES($1,$2,'cross-product', $3,'csv','REQUESTED',$4,now())`,[body.id,actor.id,Math.ceil((Date.parse(query.end)-Date.parse(query.start))/86400000),JSON.stringify({...query,product,domain,definitionVersion:"1"})]);
  }else{
   const updated=await context.pool.query(`UPDATE "AdminReportExportAuditEvent" SET status=$3 WHERE id=$1 AND "adminId"=$2 AND status='REQUESTED' RETURNING id`,[body.id,actor.id,body.status]);
   if(!updated.rowCount)throw new ApiError(409,"conflict","Export audit not pending");
  }
  return {id:body.id,status:body.status};
 });

}
