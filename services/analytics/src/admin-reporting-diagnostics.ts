import {registerOperationsSource} from "./operations-source.js";
import type {FastifyInstance} from "fastify";
import type {AnalyticsContext} from "./context.js";
import {unavailableDiagnostics,recordDiagnosticMeasurements} from "@kasitek-labs/server-support/admin-reporting-diagnostics";
import {verifyAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
export function registerAdminReportingDiagnostics(app:FastifyInstance,context:AnalyticsContext){
 registerOperationsSource(app,context);
 app.get("/v1/admin/reporting/diagnostics",async(request,reply)=>{
  const secret=context.config.admin_reporting_secret,token=request.headers[ADMIN_AUTHORITY_HEADER];
  try{if(!secret||typeof token!=="string")throw Error();verifyAdminAuthority(token,{secret,audience:"analytics",method:"GET",path:request.url,capability:"admin:report"});}
  catch{return reply.code(403).send({error:"Insufficient reporting authority"});}
  const report=unavailableDiagnostics("analytics");report.configuration={state:"ready"};
  const db=await context.pool.connect();
  try{
   await db.query("BEGIN READ ONLY");await db.query("SET LOCAL statement_timeout='2s'");
   report.connectivity={state:"ready"};
   report.projection=(await db.query("SELECT analytics.admin_reporting_diagnostics() AS diagnostic")).rows[0].diagnostic;
   report.schema={state:"ready"};report.reads={state:report.projection?.ingestedAt?"ready":"no_activity"};
   await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK").catch(()=>{});const code=(error as {code?:string}).code;report.schema={state:code==="42883"||code==="42P01"?"incompatible_schema":"unknown"};report.reads={state:"unknown",code:code==="42501"?"read_denied":"read_unavailable"};}
  finally{db.release();}
  recordDiagnosticMeasurements(report);
  return report;
 });
}
