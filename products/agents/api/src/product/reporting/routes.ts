import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {verifyAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import {agentsAdminReport} from "./source";
export function registerAdminReportingRoutes(app:FastifyInstance,pool:Pool,secret:string|undefined) {
 app.get("/api/admin/reporting",async(request,reply)=>{
  const token=request.headers[ADMIN_AUTHORITY_HEADER];
  try {if(!secret||typeof token!=="string")throw Error();verifyAdminAuthority(token,{secret,audience:"agents",method:"GET",path:request.url,capability:"admin:report"});}
  catch{return reply.code(403).send({error:"Insufficient reporting authority"});}
  let query;try{query=parseAdminReportQuery(request.query as Record<string,unknown>);}catch(error){return reply.code(400).send({error:(error as Error).message});}
  return agentsAdminReport(pool,query);
 });
}
