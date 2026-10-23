import {cookies} from "next/headers";
import {adminCapabilities,createAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
import {parseAdminReportQuery,collectAdminProductReports,applyAdminPopulationCoverage,type AdminReportSourceRequest} from "@kasitek-labs/server-support/admin-reporting";
import {ADMIN_REPORT_METRICS,type AdminCrossProductReport,type AdminReportProduct} from "@kasitek-labs/contracts";
import {getAdminSession} from "./admin-auth";
export async function crossProductReport(request:Request,exporting=false):Promise<AdminCrossProductReport> {
 const actor=await getAdminSession();
 if(!actor)throw Object.assign(Error("Unauthorized"),{status:401});
 if(!adminCapabilities(actor.role).has(exporting?"admin:export":"admin:report"))throw Object.assign(Error("Forbidden"),{status:403});
 const params=new URL(request.url).searchParams;
 if([...params.keys()].some(key=>params.getAll(key).length!==1))throw Object.assign(Error("Repeated report filter"),{status:400});
 const product=params.get("product")??"all";
 if(!["all","growth","agents","agency"].includes(product))throw Object.assign(Error("Invalid product"),{status:400});
 params.delete("product");
 const domain=params.get("domain")??"overview";
 if(!["overview","customers","adoption","usage","revenue","reliability"].includes(domain)||(params.has("consumer")||params.has("view")))throw Object.assign(Error("Invalid report domain"),{status:400});
 params.delete("domain");
 if(params.has("search")){if(domain!=="customers")throw Object.assign(Error("Search requires customers domain"),{status:400});params.set("customerSearch",params.get("search")!);params.delete("search");}
 if(product==="all"&&params.has("organizationId"))throw Object.assign(Error("Select a product before an organization"),{status:400});
 let query;try{query=parseAdminReportQuery({...Object.fromEntries(params),view:domain==="customers"?"customers":"activity"});}catch(error){throw Object.assign(error as Error,{status:400});}
 const secret=process.env.KASITEK_ADMIN_SERVICE_SECRET;
 const cookie=(await cookies()).get("kasitek_admin_session")?.value;
 const sources:AdminReportSourceRequest[]=[];
 const append=(source:AdminReportProduct,consumer?:AdminReportProduct)=>{
  const scoped={...query,...(consumer?{consumer}: {})};
  const search=new URLSearchParams(Object.entries(scoped).map(([key,value])=>[key,typeof value==="object"?JSON.stringify(value):String(value)]));
  const path="/api/admin/reporting?"+search;
  const origin=source==="growth"?process.env.CORE_BACKEND_URL??"http://localhost:4000":source==="agency"?process.env.TENANTS_BACKEND_URL??"http://localhost:8090":process.env.AGENTS_BACKEND_URL??"http://localhost:4100";
  let headers:Record<string,string>={};
  if(source==="growth")headers={Cookie:`kasitek_admin_session=${cookie??""}`};
  else if(secret&&Buffer.byteLength(secret)>=32)headers={[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:source,actor,method:"GET",path,capability:"admin:report"})};
  sources.push({product:source,query:scoped,url:new URL(path,origin).href,headers});
 };
 if(product==="all"||product==="growth")append("growth");
 if(product==="all"||product==="agency")append("agency");
 append("agents",product==="all"?undefined:product as AdminReportProduct);
 const products=await collectAdminProductReports(sources,request.signal);
 for(const report of products)applyAdminPopulationCoverage(report);
 if(domain!=="overview")for(const report of products){
  report.metrics=report.metrics.filter(metric=>metric.key==="source"||ADMIN_REPORT_METRICS.some(def=>def.key===metric.key&&def.domain===domain));
  report.trends=report.trends?.filter(trend=>trend.domain===domain);
 }
 return {contractVersion:"1",generatedAt:new Date().toISOString(),query,products};
}
export function reportError(error:unknown):Response {
 const status=(error as {status?:number})?.status??500;
 return Response.json({error:status===500?"Reporting unavailable":(error as Error).message},{status,headers:{"Cache-Control":"no-store"}});
}
