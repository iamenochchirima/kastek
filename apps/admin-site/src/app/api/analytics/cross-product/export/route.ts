import {randomUUID} from "node:crypto";
import {reportCsv} from "@kasitek-labs/server-support/admin-reporting";
import {crossProductReport,reportError} from "@/lib/cross-product-reporting";
import {fetchFromCore} from "@/lib/admin-auth";
export async function POST(request:Request){
 const id=randomUUID();let started=false;let scope:Record<string,unknown>={};
 const audit=async(status:string)=>{
  const response=await fetchFromCore("/api/admin/reporting/export/audit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status,scope})});
  if(!response.ok)throw Error("Export audit unavailable");
 };
 try{
  const report=await crossProductReport(request,true);
  scope={...report.query,product:new URL(request.url).searchParams.get("product")??"all",domain:new URL(request.url).searchParams.get("domain")??"overview"};
  await audit("REQUESTED");started=true;
  const csv=reportCsv(report.products);
  await audit("SUCCEEDED");
  return new Response(csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=kasitek-product-report.csv","Cache-Control":"no-store"}});
 }catch(error){if(started)await audit("FAILED").catch(()=>{});return reportError(error);}
}
