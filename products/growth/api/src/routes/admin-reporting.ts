import {growthAdminTrends} from "../services/admin/reporting-trends.js";
import type {FastifyInstance} from "fastify";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import type {CoreContext} from "../context.js";
import {ApiError} from "../error.js";
import {extractAdmin,grantsForRole} from "../identity/admin-session.js";
import {growthAdminReport} from "../services/admin/reporting-source.js";
export function registerAdminReportingRoutes(app:FastifyInstance,context:CoreContext) {
 app.get("/api/admin/reporting",async request=>{
  const actor=await extractAdmin(request,context);
  if(!grantsForRole(actor.role).has("admin:report"))throw new ApiError(403,"forbidden","Insufficient permissions");
  let query;try {query=parseAdminReportQuery(request.query as Record<string,unknown>);}catch(error){throw new ApiError(400,"bad_request",(error as Error).message);}
  if(query.consumer && query.consumer!=="growth")throw new ApiError(400,"bad_request","Invalid consumer for Growth");
  const report=await growthAdminReport(context.pool,query);
  return {...report,trends:await growthAdminTrends(context,actor,query)};
 });
}
