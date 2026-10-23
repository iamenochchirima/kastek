import type {FastifyInstance} from "fastify";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import type {TenantContext} from "../context.js";
import {bad} from "../error.js";
import {requireServiceAdmin} from "../admin-authority.js";
import {agencyAdminReport} from "../admin-reporting-source.js";
export function registerAdminReportingRoutes(app:FastifyInstance,context:TenantContext) {
 app.get("/api/admin/reporting",async request=>{
  await requireServiceAdmin(request,context);
  let query;try {query=parseAdminReportQuery(request.query as Record<string,unknown>);}catch(error){throw bad((error as Error).message);}
  if(query.consumer && query.consumer!=="agency")throw bad("Invalid consumer for Agency");
  return agencyAdminReport(context.pool,query);
 });
}
