import {cookies} from "next/headers";
import {adminSessionTransport} from "./admin-session-transport";
import {getAdminSession} from "./admin-auth";
import {adminCapabilities} from "@kasitek-labs/server-support/admin-authority";
import {validAdminMutationOrigin} from "./admin-request-policy";
export async function operationsApi(request:Request,path:string){
 const origin=process.env.OPS_BACKEND_URL;if(!origin)return Response.json({error:"Operations is not configured"},{status:503});
 const actor=await getAdminSession();if(!actor)return Response.json({error:"Unauthorized"},{status:401});
 const read=["GET","HEAD"].includes(request.method),policy=/^\/(rules|maintenance)(\/|$)/.test(path);
 if(!adminCapabilities(actor.role).has(read?(path==="/audit"?"admin:security":"admin:read"):policy?"admin:write":"admin:operate")||!read&&policy&&!["admin","owner","superadmin"].includes(actor.role))return Response.json({error:"Forbidden"},{status:403});
 if(!read&&!validAdminMutationOrigin(request))return Response.json({error:"Invalid request origin"},{status:403});
 if(!/^\/(?:incidents(?:\/[a-zA-Z0-9_-]+(?:\/actions)?)?|rules(?:\/[a-zA-Z0-9_.:-]+)?|maintenance(?:\/[a-zA-Z0-9_-]+\/expire)?|monitors|audit|operators|status)$/.test(path))return Response.json({error:"Unsupported operations route"},{status:400});
 const transport=adminSessionTransport(),token=(await cookies()).get(transport.cookie)?.value;
 const body=read?undefined:await request.text();if(body&&Buffer.byteLength(body)>32768)return Response.json({error:"Request too large"},{status:413});
 try{
  const response=await fetch(new URL(`/v1${path}${new URL(request.url).search}`,origin),{method:request.method,headers:{Cookie:`labs_admin_session=${token??""}`,Origin:process.env.ADMIN_FRONTEND_URL??new URL(request.url).origin,"Content-Type":"application/json"},body,cache:"no-store",redirect:"error",signal:AbortSignal.any([request.signal,AbortSignal.timeout(10000)])});
  const data=await response.json();return Response.json(response.status>=500?{error:"Operations unavailable"}:data,{status:response.status,headers:{"Cache-Control":"no-store"}});
 }catch{return Response.json({error:read?"Operations unavailable":"Response unavailable. Refresh the incident before retrying."},{status:503});}
}
export async function operationsAuthProxy(request:Request,path:string){
 const origin=process.env.OPS_BACKEND_URL;if(!origin)return Response.json({error:"Operations identity is not configured"},{status:503});
 if(!["login","callback","session","logout","backchannel-logout"].includes(path)||["login","callback","session"].includes(path)&&request.method!=="GET"||["logout","backchannel-logout"].includes(path)&&request.method!=="POST")return Response.json({error:"Unsupported identity route"},{status:405});
 if(path==="logout"&&!validAdminMutationOrigin(request))return Response.json({error:"Invalid request origin"},{status:403});
 try{
  const response=await fetch(new URL(`/auth/${path}${new URL(request.url).search}`,origin),{method:request.method,headers:{Cookie:request.headers.get("cookie")??"",Origin:process.env.ADMIN_FRONTEND_URL??new URL(request.url).origin,"Content-Type":request.headers.get("content-type")??"application/json"},...(request.method==="POST"?{body:await request.text()}:{}),cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(12000)});
  const headers=new Headers({"Cache-Control":"no-store"});for(const key of["content-type","location"])if(response.headers.has(key))headers.set(key,response.headers.get(key)!);for(const cookie of response.headers.getSetCookie())headers.append("set-cookie",cookie);
  return new Response(await response.text(),{status:response.status,headers});
 }catch{return Response.json({error:"Identity unavailable"},{status:503});}
}
