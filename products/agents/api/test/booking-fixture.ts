import {connectFixtureModel} from "./model-fixture";
import {nativeProviderConnectors} from "../src/adapters/providers/connector-registry";
import {createServer} from "node:http";
import {randomBytes,randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {PlatformStore} from "../src/product/agents/store";
import {ProviderConnectionStore} from "../src/product/connections/provider-connections";
import {GOOGLE_CALENDAR_SCOPES,type GoogleOAuthPort} from "../src/product/connections/google-calendar-oauth";
import {ConnectionVault} from "../src/infrastructure/vault";
import {BookingService} from "../src/workflows/booking/bookings";
import {defaultBusinessConfiguration,type AdmissionAuthority,type ExecutionGrant} from "../src/contracts/contracts";

export async function createBookingProviderFixture(){
 const state={requests:[] as {method:string;url:string;body:any}[],events:new Map<string,any>(),busy:[] as {start:string;end:string}[],mode:"normal" as "normal"|"lost"|"missing"|"foreign",beforeFreeBusy:undefined as (()=>Promise<void>)|undefined,beforeInsertResponse:undefined as (()=>Promise<void>)|undefined,beforeReconcileResponse:undefined as (()=>Promise<void>)|undefined};
 let calendarId=`appointments-${randomUUID()}@example.test`;const timeZone="Africa/Johannesburg";
 const server=createServer(async(req,res)=>{try{
   let text="";for await(const part of req)text+=part;const body=text?JSON.parse(text):undefined;
   state.requests.push({method:req.method!,url:req.url!,body});res.setHeader("content-type","application/json");
   if(req.headers.authorization!=="Bearer booking-fixture-token"){res.statusCode=401;res.end("{}");return;}
   if(req.url?.includes("calendarList")){res.end(JSON.stringify({items:[{id:calendarId,summary:"Appointments",timeZone,accessRole:"owner"}]}));return;}
   if(req.url?.endsWith("/freeBusy")){await state.beforeFreeBusy?.();res.end(JSON.stringify({calendars:{[calendarId]:{busy:state.busy}}}));return;}
   if(req.method==="POST"&&req.url?.includes("/events?")){
     const event={...body,status:"confirmed"};state.events.set(body.id,event);await state.beforeInsertResponse?.();
     if(state.mode==="lost"||state.mode==="missing"){req.socket.destroy();return;}
     if(state.mode==="foreign")event.summary="Foreign event";
     res.statusCode=201;res.end(JSON.stringify(event));return;
   }
   await state.beforeReconcileResponse?.();
   const id=req.url?.split("/").at(-1),event=state.events.get(id??"");
   if(!event||state.mode==="missing"){res.statusCode=404;res.end("{}");return;}
   res.end(JSON.stringify(event));
 }catch{res.statusCode=500;res.end("{}");}});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/calendar/v3`;
 return {state,get calendarId(){return calendarId;},timeZone,base,reset(){calendarId=`appointments-${randomUUID()}@example.test`;state.requests=[];state.events.clear();state.busy=[];state.mode="normal";state.beforeFreeBusy=undefined;state.beforeInsertResponse=undefined;state.beforeReconcileResponse=undefined;},close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
export type BookingProviderFixture=Awaited<ReturnType<typeof createBookingProviderFixture>>;
export function createBookingOAuthFixture(callbackUrl="https://accounts.example.test/authorize"):GoogleOAuthPort {
 return {async begin(){const state=randomUUID()+randomUUID();return {state,nonce:randomUUID(),verifier:randomUUID(),authorizationUrl:`${callbackUrl}?state=${state}&code=fixture`};},async complete(){return {accessToken:"booking-fixture-token",refreshToken:"booking-fixture-refresh",expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[...GOOGLE_CALENDAR_SCOPES],subject:"google-booking-owner",email:"owner@example.test"};},async refresh(_token,current){return {...current,expiresAt:new Date(Date.now()+3600000).toISOString()};}};
}
export async function createBookingFixture(pool:Pool,provider:BookingProviderFixture,share=true){
 const platform=new PlatformStore(pool),account=await platform.ensureAccount({issuer:"https://booking-platform.example.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
 const organization=await platform.createOrganization(account.id,"Booking test"),scope={accountId:account.id,organizationId:organization.id};
 await connectFixtureModel(pool,scope.accountId,scope.organizationId);
 const oauth=createBookingOAuthFixture();
 const google=new ProviderConnectionStore(pool,new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),{definition:nativeProviderConnectors.find(item=>item.id==="google-calendar")!,oauth,appUrl:"https://agents.example.test",testApiBaseUrl:provider.base});
 const initial=await google.create(scope,{name:"Appointments",operations:["calendar.availability","calendar.book"]}),auth=await google.authorize(scope,initial.id),state=new URL(auth.authorizationUrl).searchParams.get("state");
 await google.complete(account.id,`?state=${state}&code=fixture`);const authorized=await google.get(scope,initial.id);
 let connection=await google.selectCalendar(scope,initial.id,{generation:authorized.generation,calendarId:provider.calendarId});
 if(share)connection=await google.sharing(scope,connection.id,{generation:connection.generation,sharing:"organization_service"});
 const service=new BookingService(pool,{resolveCalendar:(...args)=>google.resolveBookingCalendar(...args),ensureFresh:(...args)=>google.ensureCredentialFresh(...args),testBaseUrl:provider.base});
 const agent=await platform.createAgent({...scope,name:"Booking agent",configuration:defaultBusinessConfiguration()});
 const policyInput={connectionId:connection.id,title:"Consultation",durationMinutes:30,minimumNoticeMinutes:0,maximumAdvanceDays:30,days:[0,1,2,3,4,5,6],opensAt:"08:00",closesAt:"18:00"};
 const start=new Date(Date.now()+86400000);start.setUTCHours(8,0,0,0);
 return {platform,account,organization,scope,google,connection,service,agent,policyInput,start:start.toISOString()};
}
export async function publishBookingFixture(f:Awaited<ReturnType<typeof createBookingFixture>>){
 const policy=await f.service.createPolicy(f.scope,f.agent.id,f.policyInput),configuration=defaultBusinessConfiguration();
 configuration.capabilities.businessActions={enabled:true,profileId:"calendar-booking-v1",permittedOperations:policy.definition.permittedOperations,policyId:policy.id,policyDigest:policy.policyDigest};
 const draft=await f.platform.updateDraft({...f.scope,agentId:f.agent.id,configuration,expectedRevision:1});
 const version=await f.platform.createVersion({...f.scope,agentId:f.agent.id,expectedRevision:draft.draft_revision});
 const authority:AdmissionAuthority={product:"agents",organizationId:f.organization.id,resourceId:f.agent.id,callerClientId:"agents-execution",principal:{kind:"human",issuer:f.account.issuer,subject:f.account.subject}};
 const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","booking.read",...(policy.definition.permittedOperations.includes("calendar.book")?["booking.execute" as const]:[])],sourceRevisionIds:[],connectedToolBindingIds:[],maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
 await f.platform.createGrant({accountId:f.account.id,grant});
 const request={authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Book a consultation."};
 const {task}=await f.platform.admitTask(request);return {...f,policy,configuration,version,authority,grant,request,task};
}
