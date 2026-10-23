import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {verifyAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import {loadAdminTrends} from "@kasitek-labs/server-support/admin-reporting-trends";
import {AnalyticsReportingClient} from "@kasitek-labs/server-support/analytics-reporting";
import {agentsAdminReport} from "./source";
export function registerAdminReportingRoutes(app:FastifyInstance,pool:Pool,secret:string|undefined,environment:NodeJS.ProcessEnv=process.env) {
 app.get("/api/admin/reporting",async(request,reply)=>{
  const token=request.headers[ADMIN_AUTHORITY_HEADER];
  let actor;
  try {if(!secret||typeof token!=="string")throw Error();actor=verifyAdminAuthority(token,{secret,audience:"agents",method:"GET",path:request.url,capability:"admin:report"});}
  catch{return reply.code(403).send({error:"Insufficient reporting authority"});}
  let query;try{query=parseAdminReportQuery(request.query as Record<string,unknown>);}catch(error){return reply.code(400).send({error:(error as Error).message});}
  const report=await agentsAdminReport(pool,query);
  if(query.consumer && query.consumer!=="agents")return report;
  const trends=await loadAdminTrends("agents",actor.id,query,async()=>{
   if(!environment.ANALYTICS_REPORTING_URL || !secret)throw Error("Analytics reporting is not configured");
   return {client:new AnalyticsReportingClient(environment.ANALYTICS_REPORTING_URL,environment.ANALYTICS_REPORTING_RESOLVER_TOKEN??"",7000),adminAuthority:{secret,role:actor.role}};
  });
  return {...report,trends};
 });
}
