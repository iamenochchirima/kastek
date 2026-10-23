import {cookies} from "next/headers";
import {adminCapabilities, createAdminAuthority, ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
import {customerOperationsEnabled, customerActionEnabled, parseCustomerOperation, parseCustomerPage} from "@kasitek-labs/server-support/admin-customers";
import type {CustomerProduct, CustomerOverview, CustomerRelationship} from "@kasitek-labs/contracts";
import {getAdminSession} from "./admin-auth";
import {validAdminMutationOrigin} from "./admin-request-policy";

export async function customerProxy(request:Request,params:{product:string;customerId:string;resource?:string[]}) {
 const fail=(status:number,error:string)=>Response.json({error},{status,headers:{"Cache-Control":"no-store"}});
 const actor=await getAdminSession();
 if(!actor)return fail(401,"Unauthorized");
 const mode=process.env.KASITEK_ENVIRONMENT??process.env.NODE_ENV;
 const environment:NodeJS.ProcessEnv={...process.env,NODE_ENV:mode==="development"||mode==="test"?mode:"production"};
 if(!customerOperationsEnabled(environment))return fail(503,"Customer operations are disabled");
 if(!["growth","agents","agency"].includes(params.product)||!params.customerId||params.customerId.length>160||/[\u0000-\u0020/\\]/.test(params.customerId))return fail(400,"Invalid customer scope");
 const resource=params.resource??[];
 const read=request.method==="GET";
 if(!adminCapabilities(actor.role).has(read?"admin:read":"admin:operate"))return fail(403,"Forbidden");
 if(!read&&!validAdminMutationOrigin(request))return fail(403,"Invalid request origin");
 if(resource.some(s=>!s||s.length>160||! /^[a-zA-Z0-9_-]+$/.test(s)))return fail(400,"Invalid resource");
 const isOperation=resource[0]==="operations";
 if(read ? resource.length>1&&!(isOperation&&resource.length===2) : !(isOperation&&(resource.length===1||(resource.length===2&&resource[1]==="preview")||(params.product==="growth"&&resource.length===3&&resource[2]==="approve"))))return fail(400,"Unsupported customer route");
 const incoming=new URL(request.url).searchParams;
 if([...incoming.keys()].some(k=>incoming.getAll(k).length!==1))return fail(400,"Repeated query filter");
 let body="",query="";
 try {
  if(read&&resource.length===1){const page=parseCustomerPage(Object.fromEntries(incoming));query=`?limit=${page.limit}${page.cursor?`&cursor=${encodeURIComponent(page.cursor)}`:""}`;}
  else if(incoming.size)return fail(400,"Unexpected query filter");
  if(!read){
   const raw=await request.text();if(Buffer.byteLength(raw)>16384)return fail(413,"Operation is too large");
   const command=parseCustomerOperation(JSON.parse(raw));
   if(!customerActionEnabled(command.action,environment))return fail(403,"This action is disabled");
   const allowed:Record<CustomerProduct,string[]>={growth:["webhook.replay","webhook.replay.approve"],agents:["task.cancel","ingress.retry"],agency:["client.suspend","client.resume"]};
   if(!allowed[params.product as CustomerProduct].includes(command.action))return fail(400,"Action does not belong to this product");
   body=JSON.stringify(command);
  }
 }catch{return fail(400,"Check the operation fields");}
 const path=`/api/admin/customers/${encodeURIComponent(params.customerId)}${resource.length?"/"+resource.map(encodeURIComponent).join("/"):""}${query}`;
 const product=params.product as CustomerProduct;
 const origin=product==="growth"?process.env.CORE_BACKEND_URL??"http://localhost:4000":product==="agency"?process.env.TENANTS_BACKEND_URL??"http://localhost:8090":process.env.AGENTS_BACKEND_URL??"http://localhost:4100";
 const headers:Record<string,string>={"Content-Type":"application/json","Origin":process.env.ADMIN_FRONTEND_URL??new URL(request.url).origin};
 try {
  if(product==="growth")headers.Cookie=`kasitek_admin_session=${(await cookies()).get("kasitek_admin_session")?.value??""}`;
  else {
   const secret=process.env.KASITEK_ADMIN_SERVICE_SECRET;if(!secret)return fail(503,"Product authority is not configured");
   headers[ADMIN_AUTHORITY_HEADER]=createAdminAuthority({secret,audience:product,actor,method:request.method,path,body,capability:read?"admin:read":"admin:operate"});
  }
  const response=await fetch(new URL(path,origin),{method:request.method,headers,body:read?undefined:body,cache:"no-store",signal:AbortSignal.any([request.signal,AbortSignal.timeout(10000)])});
  const data=await response.json();
  if(!response.ok)return fail(response.status,response.status>=500?"Product unavailable":typeof data?.error==="string"?data.error:"Customer operation unavailable");
  if(read&&!resource.length&&product!=="agents") {
   const overview=data as CustomerOverview;
   const linkPath=`/api/admin/customer-links/${product}/${encodeURIComponent(params.customerId)}`;
   try {
    const secret=process.env.KASITEK_ADMIN_SERVICE_SECRET;if(!secret)throw Error();
    const linked=await fetch(new URL(linkPath,process.env.AGENTS_BACKEND_URL??"http://localhost:4100"),{headers:{[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:"agents",actor,method:"GET",path:linkPath,capability:"admin:read"})},cache:"no-store",signal:AbortSignal.any([request.signal,AbortSignal.timeout(5000)])});
    if(!linked.ok)throw Error();
    const {relationships}=await linked.json() as {relationships:CustomerRelationship[]};
    if(!Array.isArray(relationships)||relationships.some(link=>link.product!==product||link.customerId!==params.customerId||!link.executionOrganizationId||!link.mappingId||!["active","revoked"].includes(link.state)))throw Error();
    overview.relationships=relationships;
    overview.sections.push({id:"linked-execution",title:"Execution mapping",status:"available",source:"agents.product_execution_tenants",observedAt:new Date().toISOString(),records:relationships.map(link=>({id:link.mappingId,label:link.executionOrganizationId,state:link.state,facts:[]})),nextCursor:null});
   }catch{overview.relationships=[];overview.sections.push({id:"linked-execution",title:"Execution mapping",status:"unavailable",source:"agents.product_execution_tenants",observedAt:null,records:[],nextCursor:null});}
  }
  return Response.json(data,{status:response.status,headers:{"Cache-Control":"no-store"}});
 } catch {return fail(503,read?"Product unavailable":"Response unavailable. Check the operation receipt before retrying.");}
}
