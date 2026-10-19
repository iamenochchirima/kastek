import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

type Tenant={organizationId:string;token:string;websiteDeploymentId:string};
type Result={tenants:number;latencies:number[];reconnects:number;duplicateMessages:number;humanBacklogAdmissions:number;returnBacklogAdmissions:number;postTakeoverAssistantMessages:number;errors:string[]};
/** Drive actual visitor and staff endpoints; SQL only verifies hidden admission facts. */
export async function exerciseOwnershipControls(pool:Pool,endpoints:string[],tenants:Tenant[]):Promise<Result>{
 const result:Result={tenants:tenants.length,latencies:[],reconnects:0,duplicateMessages:0,humanBacklogAdmissions:0,returnBacklogAdmissions:0,postTakeoverAssistantMessages:0,errors:[]};
 await Promise.all(tenants.map(async(tenant,index)=>{
  const endpoint=endpoints[index%endpoints.length]!,other=endpoints[(index+1)%endpoints.length]!,website=`/api/website/${tenant.websiteDeploymentId}`;
  let visitorToken='';
  async function call(path:string,body?:unknown,staff=false,origin=endpoint){
   const started=Date.now(),response=await fetch(origin+path,{method:body?'POST':'GET',headers:{origin:'http://localhost:3100',...(staff?{cookie:`agents_session=${tenant.token}`} :visitorToken?{authorization:`Bearer ${visitorToken}`} :{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
   const data=await response.json() as any;if(!response.ok)throw Error(data.error?.code??String(response.status));if(staff&&body)result.latencies.push(Date.now()-started);return data;
  }
  try{
   visitorToken=(await call(website+'/session',{})).token;
   const {conversation}=await call(website+'/customer-conversations',{}),path=`${website}/customer-conversations/${conversation.id}/messages`,staffPath=`/api/organizations/${tenant.organizationId}/inbox/${conversation.id}`;
   const first={requestKey:randomUUID(),body:'opening hours'};
   const [sent,replayed]=await Promise.all([call(path,first),call(path,first,false,other)]);if(sent.message.id!==replayed.message.id)result.duplicateMessages++;
   let current=(await call(staffPath,undefined,true)).conversation;
   async function command(action:string,body?:string){current=(await call(staffPath+'/commands',{commandId:randomUUID(),expectedRevision:current.revision,action,...(body?{body}:{})},true)).conversation;}
   await command('claim');await command('takeover');
   const taken=await call(path),sequence=taken.nextSequence;
   const roots=async()=>Number((await pool.query('SELECT count(*)::int n FROM agents_platform.customer_messages WHERE conversation_id=$1 AND task_id IS NOT NULL',[conversation.id])).rows[0].n);
   const before=await roots();await call(path,{requestKey:randomUUID(),body:'Please handle this manually.'});result.humanBacklogAdmissions+=await roots()-before;
   await command('reply','A support team member is helping.');await command('return');result.returnBacklogAdmissions+=await roots()-before;
   const reconnected=await call(path+'?after='+encodeURIComponent(sequence),undefined,false,other);
   if(reconnected.messages.some((message:any)=>message.authorKind==='human'))result.reconnects++;else result.errors.push('Missing human reply after cross-replica reconnect');
   result.postTakeoverAssistantMessages+=reconnected.messages.filter((message:any)=>message.authorKind==='assistant').length;
   await call(path,{requestKey:randomUUID(),body:'opening hours'});
   if(await roots()!==before+1)result.errors.push('New input after return did not admit exactly one root');
  }catch(error){result.errors.push(error instanceof Error?error.message:'Unknown control failure');}
 }));return result;
}
