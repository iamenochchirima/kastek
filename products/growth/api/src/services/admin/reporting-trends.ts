import {loadAdminTrends} from "@kasitek-labs/server-support/admin-reporting";
import {AnalyticsReportingClient} from "@kasitek-labs/server-support/analytics-reporting";
import type {AdminReportQuery} from "@kasitek-labs/contracts";
import type {CoreContext} from "../../context.js";
import {reportingDependencies} from "../analytics-reporting.js";
export function growthAdminTrends(context:CoreContext,actor:{id:string;role:string},query:AdminReportQuery) {
  return loadAdminTrends("growth",actor.id,query,async()=>{
    const env=context.config.env;
    if(query.organizationId) return reportingDependencies(context);
    if(!env.ANALYTICS_REPORTING_RESOLVER_TOKEN || !env.KASITEK_ADMIN_SERVICE_SECRET) throw Error("Analytics admin reporting is not configured");
    return {client:new AnalyticsReportingClient(env.ANALYTICS_REPORTING_URL ?? 'http://127.0.0.1:4300',env.ANALYTICS_REPORTING_RESOLVER_TOKEN),
      adminAuthority:{secret:env.KASITEK_ADMIN_SERVICE_SECRET,role:actor.role}};
  });
}
