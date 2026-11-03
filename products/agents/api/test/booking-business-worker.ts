import {ModelCredentialVault} from "../src/infrastructure/model-credential-vault";
import {ModelProviderStore} from "../src/product/model-providers/store";
import {dispatchBoundModel} from "../src/execution/models/dispatch";
import type {ModelFetch} from "../src/infrastructure/model-network";
import {nativeProviderConnectors} from "../src/adapters/providers/connector-registry";
import {createServer,type ServerHttp2Session} from "node:http2";
import {Pool} from "pg";
import {createEndpointHandler} from "@restatedev/restate-sdk";
import {createBusinessWorkflow} from "../src/execution/business/business";
import {SHARED_HARNESS_RELEASE,SHARED_WORKFLOW_NAME} from "../src/contracts/execution";
import {composeInbox} from "../src/composition/inbox";
import {ProviderConnectionStore} from "../src/product/connections/provider-connections";
import {BookingService} from "../src/workflows/booking/bookings";
import {ConnectionVault} from "../src/infrastructure/vault";
import {createBookingOAuthFixture} from "./booking-fixture";
async function main(){
 const database=process.env.AGENTS_DATABASE_URL!,model=process.env.BOOKING_MODEL_URL!,origin=process.env.BOOKING_ORIGIN!,base=process.env.BOOKING_GOOGLE_BASE!,port=Number(process.env.BOOKING_WORKER_PORT);
 if(!database||!model||!origin||!base||!port)throw Error("Missing booking worker fixture configuration");
 const pool=new Pool({connectionString:database,max:8});
 composeInbox(pool,{publicOrigin:origin,async assertServices(configuration){if(configuration.program.id!=="grounded-conversation"||!configuration.capabilities.businessActions.enabled)throw Error("Booking fixture requires the published customer booking program");}});
 const vault=new ConnectionVault("booking-test",JSON.parse(process.env.BOOKING_VAULT_KEYS!));
 const google=new ProviderConnectionStore(pool,vault,{definition:nativeProviderConnectors.find(item=>item.id==="google-calendar")!,oauth:createBookingOAuthFixture(),appUrl:origin,testApiBaseUrl:base});
 const bookings=new BookingService(pool,{resolveCalendar:(...args)=>google.resolveBookingCalendar(...args),ensureFresh:(...args)=>google.ensureCredentialFresh(...args),testBaseUrl:base});
 const workflow=(runtime?:{release:string;workflow:string})=>createBusinessWorkflow(pool,{bookings,modelProvider:new ModelProviderStore(pool,new ModelCredentialVault(vault)),modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{
   const network=(async(url,request)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error("Fixture destination denied");await policy.beforeDispatch?.();return fetch(model,request);}) as ModelFetch;network.markProgress=()=>{};return network;
 })}},runtime);
 const sessions=new Set<ServerHttp2Session>(),server=createServer(createEndpointHandler({services:[workflow(),workflow({release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME})]}));
 server.on("session",session=>{sessions.add(session);session.once("close",()=>sessions.delete(session));});
 await new Promise<void>(resolve=>server.listen(port,"0.0.0.0",resolve));process.stdout.write("BOOKING_WORKER_READY\n");
 const close=async()=>{for(const session of sessions)session.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();};
 for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void close();});
}
void main().catch(()=>{process.stderr.write("Booking business fixture worker failed\n");process.exitCode=1;});
