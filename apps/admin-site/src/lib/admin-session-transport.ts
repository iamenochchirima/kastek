export function adminSessionTransport(){
 const operations=process.env.OPS_BACKEND_URL;
 return operations?{url:new URL("/auth/session",operations).href,cookie:"labs_admin_session",independent:true}:{url:new URL("/api/admin/me",process.env.CORE_BACKEND_URL??"http://localhost:4000").href,cookie:"kasitek_admin_session",independent:false};
}
export async function loadAdminActor(token:string|undefined){
 if(!token)return null;
 const transport=adminSessionTransport();
 const response=await fetch(transport.url,{headers:{Cookie:`${transport.cookie}=${token}`},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)});
 if(!response.ok)return null;
 const payload=await response.json(),actor=transport.independent?payload.admin:payload;
 if(!actor||!["id","role","name","email"].every(k=>typeof actor[k]==="string")||!["viewer","support","security","operator","admin","owner","superadmin"].includes(actor.role))return null;
 return {id:actor.id,role:actor.role,name:actor.name,email:actor.email} as {id:string;role:string;name:string;email:string};
}
