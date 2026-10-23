import {cookies} from "next/headers";
import {adminCapabilities,createAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
import {collectReportingDiagnostics,unavailableDiagnostics} from "@kasitek-labs/server-support/admin-reporting-diagnostics";
import type {AdminDiagnosticService} from "@kasitek-labs/contracts";
import {getAdminSession} from "@/lib/admin-auth";
import {adminSessionTransport} from "@/lib/admin-session-transport";
export async function GET(request:Request){
 const actor=await getAdminSession();
 if(!actor)return Response.json({error:"Unauthorized"},{status:401});
 if(!adminCapabilities(actor.role).has("admin:report"))return Response.json({error:"Forbidden"},{status:403});
 const params=new URL(request.url).searchParams,source=params.get("source")??"all";
 if([...params.keys()].some(key=>key!=="source")||params.getAll("source").length>1||!["all","growth","agency","agents","analytics"].includes(source))return Response.json({error:"Invalid source"},{status:400});
 const cookie=(await cookies()).get("kasitek_admin_session")?.value;
 const services:AdminDiagnosticService[]=source==="all"?["growth","agents","agency","analytics"]:[source as AdminDiagnosticService];
 const origins={growth:process.env.CORE_BACKEND_URL??"http://localhost:4000",agency:process.env.TENANTS_BACKEND_URL??"http://localhost:8090",agents:process.env.AGENTS_BACKEND_URL??"http://localhost:4100",analytics:process.env.ANALYTICS_REPORTING_URL??"http://localhost:4300"};
 const secret=process.env.KASITEK_ADMIN_SERVICE_SECRET;
 const reports=await Promise.all(services.map(async service=>{
  if((service!=="growth"||adminSessionTransport().independent)&&(!secret||Buffer.byteLength(secret)<32))return unavailableDiagnostics(service,"not_configured");
  try {
  const path=service==="analytics"?"/v1/admin/reporting/diagnostics":"/api/admin/reporting/diagnostics";
  const headers:Record<string,string>=service==="growth"&&!adminSessionTransport().independent?{Cookie:`kasitek_admin_session=${cookie??""}`}:(secret&&Buffer.byteLength(secret)>=32?{[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:service,actor,method:"GET",path,capability:"admin:report"})}:{});
  return await collectReportingDiagnostics(service,new URL(path,origins[service]).href,headers,request.signal);
  }catch{if(request.signal.aborted)throw request.signal.reason;return unavailableDiagnostics(service,"not_configured");}
 }));
 return Response.json({reports},{headers:{"Cache-Control":"no-store"}});
}
