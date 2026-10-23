import {loadAdminTrends} from "@kasitek-labs/server-support/admin-reporting";
import {AnalyticsReportingClient,ReportingGrantIssuer} from "@kasitek-labs/server-support/analytics-reporting";
import type {AdminReportQuery} from "@kasitek-labs/contracts";
import type {TenantContext} from "./context.js";
export function agencyAdminTrends(context:TenantContext,actor:{id:string;role:string},query:AdminReportQuery) {
  return loadAdminTrends("agency",actor.id,query,async()=>{
    const config=context.config;
    if(!config.analytics_reporting_resolver_token) throw Error("Analytics is not configured");
    const client=new AnalyticsReportingClient(config.analytics_reporting_url,config.analytics_reporting_resolver_token,config.analytics_reporting_timeout_ms);
    if(!query.organizationId) {
      if(!config.env.KASITEK_ADMIN_SERVICE_SECRET) throw Error("Analytics admin reporting is not configured");
      return {client,adminAuthority:{secret:config.env.KASITEK_ADMIN_SERVICE_SECRET,role:actor.role}};
    }
    if(!config.analytics_reporting_private_key) throw Error("Scoped Analytics is not configured");
    return {client,issuer:await ReportingGrantIssuer.fromPem(config.analytics_reporting_private_key,config.analytics_reporting_issuer,config.analytics_reporting_audience || undefined,config.analytics_reporting_key_id || undefined)};
  });
}
