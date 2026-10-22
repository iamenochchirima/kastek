import {randomBytes,randomUUID} from "node:crypto";
import {execFileSync,spawn,type ChildProcess} from "node:child_process";
import {createServer} from "node:http";
import {createServer as reservePort} from "node:net";
import {resolve} from "node:path";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {buildPlatformApp} from "../src/composition/app";
import {loadPlatformConfig} from "../src/infrastructure/config";
import {PlatformStore} from "../src/product/agents/store";
import {defaultBusinessConfiguration,terminalTaskStates} from "../src/contracts/contracts";
import {dispatchTasksOnce} from "../src/execution/lifecycle/dispatcher";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {createBookingOAuthFixture,createBookingProviderFixture,type BookingProviderFixture} from "./booking-fixture";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("published website booking across durable confirmation, restart and Inbox ownership",()=>{
 let admin:Pool,pool:Pool,app:Awaited<ReturnType<typeof buildPlatformApp>>,provider:BookingProviderFixture,model:ReturnType<typeof createServer>,worker:ChildProcess|undefined;
 let api="",databaseConnection="",modelUrl="",workerPort=0,ingress="",runtimeAdmin="",containerStarted=false;
 const database=`agents_booking_business_${randomUUID().replaceAll("-","")}`,container=`agents-booking-business-${randomUUID()}`,pids:number[]=[],modelRequests:any[]=[];
 const shop="https://booking-shop.fixture.test",keys={"booking-test":randomBytes(32).toString("base64")},root=resolve(__dirname,"../../../..");
 let offeredStart="",offeredEnd="";
 const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",timeout:60000}).trim();
 async function eventually<T>(check:()=>Promise<T|false>,timeout=30000):Promise<T>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value!==false)return value;await new Promise(resolve=>setTimeout(resolve,60));}throw Error("Booking business checkpoint timed out");}
 async function freePort(){const server=reservePort();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
 async function stopWorker(signal:NodeJS.Signals="SIGTERM"){const owned=worker;if(!owned||owned.exitCode!==null||owned.signalCode!==null)return;owned.kill(signal);await new Promise<void>(resolve=>owned.once("exit",()=>resolve()));}
 async function startWorker(){worker=spawn(process.execPath,["--import","tsx",resolve(__dirname,"booking-business-worker.ts")],{cwd:resolve(root,"products/agents/api"),env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"test",OTEL_SDK_DISABLED:"true",AGENTS_DATABASE_URL:databaseConnection,BOOKING_MODEL_URL:modelUrl,BOOKING_ORIGIN:api,BOOKING_GOOGLE_BASE:provider.base,BOOKING_VAULT_KEYS:JSON.stringify(keys),BOOKING_WORKER_PORT:String(workerPort)},stdio:["ignore","pipe","pipe"]});
   const owned=worker;let output="",failed=false;owned.stdout!.on("data",chunk=>{output=(output+String(chunk)).slice(-5000);});owned.stderr!.resume();owned.once("exit",()=>{failed=true;});await eventually(async()=>{if(failed)throw Error("Booking fixture worker exited during startup");return output.includes("BOOKING_WORKER_READY");});pids.push(owned.pid!);
 }
 beforeAll(async()=>{
   admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;databaseConnection=url.href;pool=new Pool({connectionString:databaseConnection,max:16});await setupPlatformSchema(pool);
   provider=await createBookingProviderFixture();const start=new Date(Date.now()+86400000);start.setUTCHours(8,0,0,0);offeredStart=start.toISOString();offeredEnd=new Date(start.getTime()+3600000).toISOString();
   model=createServer(async(req,res)=>{let text="";for await(const part of req)text+=part;const body=JSON.parse(text);modelRequests.push(body);
     const lastUser=body.messages.findLastIndex((message:any)=>message.role==="user"),current=body.messages.slice(lastUser+1),names=current.flatMap((message:any)=>(message.tool_calls??[]).map((call:any)=>call.function.name));
     let message:any,finish="tool_calls";const call=(name:string,args:object)=>({role:"assistant",content:null,tool_calls:[{id:randomUUID(),type:"function",function:{name,arguments:JSON.stringify(args)}}]});
     if(!names.includes("booking_availability"))message=call("booking_availability",{start:offeredStart,end:offeredEnd});
     else if(!names.includes("booking_reserve"))message=call("booking_reserve",{start:offeredStart});
     else {finish="stop";const content=current.findLast((item:any)=>item.role==="tool")?.content??"{}";let receipt:any;try{receipt=JSON.parse(content);}catch{}message={role:"assistant",content:receipt?.state==="confirmed"&&receipt.receiptDigest?`Your consultation is confirmed for ${receipt.start}. Reference ${receipt.bookingId}.`:"The booking was not confirmed."};}
     res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:randomUUID(),choices:[{finish_reason:finish,message}],usage:{prompt_tokens:40,completion_tokens:8}}));
   });await new Promise<void>(resolve=>model.listen(0,"127.0.0.1",resolve));modelUrl=`http://127.0.0.1:${(model.address() as {port:number}).port}`;
   const port=await freePort();api=`http://127.0.0.1:${port}`;workerPort=await freePort();process.env.AGENTS_CONNECTION_ACTIVE_KEY="booking-test";process.env.AGENTS_CONNECTION_KEYS=JSON.stringify(keys);
   const config=loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:databaseConnection,AGENTS_PUBLIC_URL:api,AGENTS_OIDC_ISSUER_URL:"https://booking-identity.fixture.test",AGENTS_OIDC_CLIENT_SECRET:"booking-fixture-session-secret",OPENROUTER_API_KEY:"fixture-model-credential"});
   app=await buildPlatformApp({config,pool,logging:false,testGoogleOAuth:createBookingOAuthFixture(`${api}/api/google-calendar/callback`),testGoogleApiBaseUrl:provider.base});await app.listen({host:"127.0.0.1",port});await startWorker();
   docker("run","-d","--name",container,"--cpus","1","--memory","768m","--add-host","host.docker.internal:host-gateway","-p","127.0.0.1::8080","-p","127.0.0.1::9070","docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742");containerStarted=true;
   ingress=`http://${docker("port",container,"8080/tcp")}`;runtimeAdmin=`http://${docker("port",container,"9070/tcp")}`;
   await eventually(async()=>{try{return(await fetch(`${runtimeAdmin}/health`)).ok;}catch{return false;}});
   const registration=await fetch(`${runtimeAdmin}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:`http://host.docker.internal:${workerPort}`,force:false})});expect(registration.ok,await registration.text()).toBe(true);
 },90000);
 afterAll(async()=>{if(provider)provider.state.beforeFreeBusy=undefined;await stopWorker();if(containerStarted)docker("rm","-f",container);await app?.close();if(model)await new Promise<void>(resolve=>model.close(()=>resolve()));await provider?.close();await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}},30000);
 const insertCount=()=>provider.state.requests.filter(request=>request.method==="POST"&&request.url.includes("/events?")).length;
 async function json(url:string,headers:Record<string,string>,body?:unknown,method=body===undefined?"GET":"POST"){const response=await fetch(url,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});expect(response.ok,await response.clone().text()).toBe(true);return response.json() as Promise<any>;}
 async function setup(){
   provider.reset();
   const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:"https://booking-identity.fixture.test",subject:randomUUID(),email:"booking-owner@example.test",displayName:"Owner"}),org=await store.createOrganization(account.id,"Public booking acceptance"),scope={accountId:account.id,organizationId:org.id};
   const session=await store.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+600000)}),staff={cookie:`agents_session=${session.token}`,origin:api,"content-type":"application/json"};
   const base=`${api}/api/organizations/${org.id}`,google=`${base}/providers/google-calendar/connections`,created=await json(google,staff,{name:"Bookings",operations:["calendar.availability","calendar.book"]});let connection=created.connection;
   const authorize=await json(`${google}/${connection.id}/authorize`,staff,{});const callback=await fetch(authorize.authorizationUrl,{headers:staff,redirect:"manual"});expect(callback.status).toBe(302);
   connection=(await json(`${google}/${connection.id}`,staff)).connection;await json(`${google}/${connection.id}/calendars`,staff);
   connection=(await json(`${google}/${connection.id}/calendar`,staff,{generation:connection.generation,calendarId:provider.calendarId})).connection;
   connection=(await json(`${google}/${connection.id}/sharing`,staff,{generation:connection.generation,sharing:"organization_service"})).connection;
   const configuration=defaultBusinessConfiguration();configuration.program={id:"grounded-conversation",version:"1"};configuration.tools=[];
   const agent=await store.createAgent({...scope,name:"Customer appointments",configuration});
   const policy=(await json(`${base}/agents/${agent.id}/booking-policies`,staff,{connectionId:connection.id,title:"Consultation",durationMinutes:30,minimumNoticeMinutes:0,maximumAdvanceDays:30,days:[0,1,2,3,4,5,6],opensAt:"08:00",closesAt:"18:00"})).policy;
   configuration.capabilities.businessActions={enabled:true,profileId:"calendar-booking-v1",policyId:policy.id,policyDigest:policy.policyDigest};const draft=await store.updateDraft({...scope,agentId:agent.id,configuration,expectedRevision:1}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:draft.draft_revision});
   const deployment=await store.publishWebsite({...scope,agentId:agent.id,versionId:version.id,allowedOrigins:[shop]}),publicBase=`${api}/api/website/${deployment.id}`;
   async function visitor(){const {token}=await json(`${publicBase}/session`,{origin:shop,"content-type":"application/json"},{}),headers={authorization:`Bearer ${token}`,origin:shop,"content-type":"application/json"};const {conversation}=await json(`${publicBase}/customer-conversations`,headers,{});return {headers,conversation,path:`${publicBase}/customer-conversations/${conversation.id}`};}
   const customer=await visitor(),staffPath=`${base}/inbox/${customer.conversation.id}`;
   async function command(action:string){const read=await json(staffPath,staff);return json(`${staffPath}/commands`,staff,{commandId:randomUUID(),expectedRevision:read.conversation.revision,action});}
   async function send(body:string){const {message}=await json(`${customer.path}/messages`,customer.headers,{requestKey:randomUUID(),body});return eventually(async()=>(await pool.query("SELECT t.* FROM agents_platform.tasks t JOIN agents_platform.customer_messages m ON m.task_id=t.id WHERE m.id=$1",[message.id])).rows[0]??false);}
   return {store,scope,agent,version,deployment,customer,staff,staffPath,command,send,visitor};
 }
 async function tick(){await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:runtimeAdmin});}
 async function pending(taskId:string){return eventually(async()=>{await tick();const row=(await pool.query("SELECT b.*,t.state AS task_state FROM agents_platform.booking_intents b JOIN agents_platform.tasks t ON t.id=b.task_id WHERE b.task_id=$1",[taskId])).rows[0];return row?.state==="pending"&&row.task_state==="waiting_review"?row:false;});}
 async function settled(taskId:string){return eventually(async()=>{await tick();const row=(await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];return terminalTaskStates.has(row?.state)?row:false;});}
 it("waits durably with no insert, restarts worker, confirms through scoped public API and delivers authoritative result",async()=>{
   const f=await setup(),before=insertCount(),task=await f.send("Please book the offered consultation."),intent=await pending(task.id);
   expect(insertCount()).toBe(before);expect((await pool.query("SELECT 1 FROM agents_platform.operations WHERE task_id=$1 AND name='booking.reserve'",[task.id])).rowCount).toBe(0);expect(task.principal.kind).toBe("visitor");expect(task.channel_binding.ownershipGeneration).toBe("1");
   const offered=await json(`${f.customer.path}/bookings`,f.customer.headers);expect(offered.bookings).toMatchObject([{id:intent.id,state:"pending",requestDigest:intent.request_digest}]);
   const other=await f.visitor();const forbidden=await fetch(`${f.customer.path}/bookings/${intent.id}/decision`,{method:"POST",headers:other.headers,body:JSON.stringify({decision:"approve",requestDigest:intent.request_digest})});expect(forbidden.status).toBe(403);expect(insertCount()).toBe(before);
   const invocation=(await pool.query("SELECT runtime_invocation_id FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0].runtime_invocation_id;
   await stopWorker("SIGKILL");await startWorker();expect(pids[0]).not.toBe(pids[1]);expect(insertCount()).toBe(before);
   await json(`${f.customer.path}/bookings/${intent.id}/decision`,f.customer.headers,{decision:"approve",requestDigest:intent.request_digest});const result=await settled(task.id);
   expect(result.state).toBe("completed");expect(result.output).toContain("Your consultation is confirmed");expect(result.output).toContain(intent.id);expect(result.runtime_invocation_id).toBe(invocation);expect(insertCount()).toBe(before+1);
   const timeline=await json(`${f.customer.path}/messages`,f.customer.headers);expect(timeline.messages.at(-1).body).toBe(result.output);
   const receipt=(await pool.query("SELECT provider_result FROM agents_platform.booking_intents WHERE id=$1",[intent.id])).rows[0].provider_result;expect(receipt).toMatchObject({state:"confirmed",receiptDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
 },60000);
 it("fences pending confirmation on takeover and admits a new ownership generation only after explicit return",async()=>{
   const f=await setup(),before=insertCount(),first=await f.send("Book a consultation after I confirm."),intent=await pending(first.id);
   await f.command("claim");await f.command("takeover");const forbidden=await fetch(`${f.customer.path}/bookings/${intent.id}/decision`,{method:"POST",headers:f.customer.headers,body:JSON.stringify({decision:"approve",requestDigest:intent.request_digest})});expect(forbidden.ok).toBe(false);
   const ended=await settled(first.id);expect(["cancelled","incomplete"]).toContain(ended.state);expect(insertCount()).toBe(before);
   await f.command("return");const next=await f.send("New booking request after support returned automation."),second=await pending(next.id);expect(BigInt(next.channel_binding.ownershipGeneration)).toBeGreaterThan(BigInt(first.channel_binding.ownershipGeneration));
   await json(`${f.customer.path}/bookings/${second.id}/decision`,f.customer.headers,{decision:"approve",requestDigest:second.request_digest});expect((await settled(next.id)).state).toBe("completed");expect(insertCount()).toBe(before+1);
 },60000);
 it("lets Inbox takeover fence an approved booking between provider availability and event send",async()=>{
   const f=await setup(),before=insertCount(),task=await f.send("Reserve this time after I approve it."),intent=await pending(task.id);
   await f.command("claim");let reached=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
   provider.state.beforeFreeBusy=async()=>{reached=true;await gate;};
   try{
     await json(`${f.customer.path}/bookings/${intent.id}/decision`,f.customer.headers,{decision:"approve",requestDigest:intent.request_digest});
     await eventually(async()=>{await tick();return reached;});await f.command("takeover");expect(insertCount()).toBe(before);
   }finally{provider.state.beforeFreeBusy=undefined;release();}
   const ended=await settled(task.id);expect(["cancelled","incomplete","uncertain"]).toContain(ended.state);expect(insertCount()).toBe(before);expect((await json(f.staffPath,f.staff)).conversation.state).toBe("human_owned");
   const row=(await pool.query("SELECT state,claimed_at FROM agents_platform.booking_intents WHERE id=$1",[intent.id])).rows[0];expect(row.claimed_at).toBeNull();
   expect((await json(`${f.customer.path}/messages`,f.customer.headers)).messages.some((message:any)=>message.body.includes("Your consultation is confirmed"))).toBe(false);
 },60000);

 it("recovers uncertain provider acceptance through the scoped public status endpoint with GET only",async()=>{
   const f=await setup();provider.state.mode="missing";const before=insertCount(),task=await f.send("Book only after I confirm."),intent=await pending(task.id);
   await json(`${f.customer.path}/bookings/${intent.id}/decision`,f.customer.headers,{decision:"approve",requestDigest:intent.request_digest});expect((await settled(task.id)).state).toBe("uncertain");expect(insertCount()).toBe(before+1);
   const original=(await pool.query("SELECT state,error_code,output FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0],operations=(await pool.query("SELECT id,state,error_code FROM agents_platform.operations WHERE task_id=$1 ORDER BY id",[task.id])).rows;
   expect((await json(f.staffPath,f.staff)).conversation).toMatchObject({state:"handoff_pending",hasBookings:true});
   const count=provider.state.requests.length,listed=await json(`${f.staffPath}/bookings`,f.staff);expect(listed.bookings).toMatchObject([{id:intent.id,taskId:task.id,state:"uncertain"}]);expect(provider.state.requests).toHaveLength(count);
   const other=await f.visitor(),foreign=await fetch(`${other.path}/bookings/${intent.id}/reconcile`,{method:"POST",headers:other.headers,body:"{}"});expect(foreign.status).toBe(404);expect(provider.state.requests).toHaveLength(count);
   const unrelated=`${api}/api/organizations/${f.scope.organizationId}/inbox/${other.conversation.id}`;expect((await json(unrelated,f.staff)).conversation.hasBookings).toBe(false);expect((await json(`${unrelated}/bookings`,f.staff)).bookings).toEqual([]);const borrowed=await fetch(`${unrelated}/bookings/${intent.id}/reconcile`,{method:"POST",headers:f.staff,body:"{}"});expect(borrowed.status).toBe(404);expect(provider.state.requests).toHaveLength(count);
   const account=await f.store.ensureAccount({issuer:"https://booking-identity.fixture.test",subject:randomUUID(),email:"foreign-owner@example.test",displayName:"Foreign owner"}),org=await f.store.createOrganization(account.id,"Separate booking organization"),session=await f.store.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+600000)}),headers={cookie:`agents_session=${session.token}`,origin:api,"content-type":"application/json"},foreignPath=`${api}/api/organizations/${org.id}/inbox/${f.customer.conversation.id}`;
   for(const path of [`${foreignPath}/bookings`,`${foreignPath}/bookings/${intent.id}/reconcile`]){const response=await fetch(path,{method:path.endsWith("reconcile")?"POST":"GET",headers,...(path.endsWith("reconcile")?{body:"{}"}:{})});expect(response.status).toBe(403);}expect(provider.state.requests).toHaveLength(count);
   provider.state.mode="normal";const staffResponse=await json(`${f.staffPath}/bookings/${intent.id}/reconcile`,f.staff,{});expect(staffResponse.booking).toMatchObject({id:intent.id,taskId:task.id,state:"confirmed"});
   const response=await json(`${f.customer.path}/bookings/${intent.id}/reconcile`,f.customer.headers,{});expect(response.booking).toMatchObject({id:intent.id,state:"confirmed"});expect(response.booking).not.toHaveProperty("taskId");
   expect(provider.state.requests.slice(count).map(request=>request.method)).toEqual(["GET"]);expect(insertCount()).toBe(before+1);expect((await pool.query("SELECT state,error_code,output FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0]).toEqual(original);expect((await pool.query("SELECT id,state,error_code FROM agents_platform.operations WHERE task_id=$1 ORDER BY id",[task.id])).rows).toEqual(operations);
 },60000);

 it("preserves an uncertain sent booking through human takeover without replacing shared ownership",async()=>{
   const f=await setup();provider.state.mode="missing";const before=insertCount(),task=await f.send("Reserve the offered consultation after approval."),intent=await pending(task.id);
   await f.command("claim");let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});provider.state.beforeInsertResponse=async()=>{entered=true;await gate;};
   try{await json(`${f.customer.path}/bookings/${intent.id}/decision`,f.customer.headers,{decision:"approve",requestDigest:intent.request_digest});await eventually(async()=>{await tick();return entered;});await f.command("takeover");}
   finally{provider.state.beforeInsertResponse=undefined;release();}
   await settled(task.id);expect(insertCount()).toBe(before+1);expect((await json(f.staffPath,f.staff)).conversation.state).toBe("human_owned");
   const operation=(await pool.query("SELECT state,error_code FROM agents_platform.operations WHERE task_id=$1 AND name='booking.reserve'",[task.id])).rows[0];expect(operation.state).toBe("uncertain");expect(["BOOKING_OUTCOME_UNCERTAIN","OPERATION_INTERRUPTED"]).toContain(operation.error_code);
   await eventually(async()=>(await pool.query("SELECT state FROM agents_platform.booking_intents WHERE id=$1",[intent.id])).rows[0]?.state==="uncertain");
   expect((await pool.query("SELECT 1 FROM agents_platform.customer_commands WHERE conversation_id=$1 AND action='request_handoff'",[f.customer.conversation.id])).rowCount).toBe(0);
   expect((await pool.query("SELECT 1 FROM agents_platform.task_events WHERE task_id=$1 AND kind='tool.booking_handoff_failed'",[task.id])).rowCount).toBe(0);
   expect((await json(`${f.customer.path}/bookings`,f.customer.headers)).bookings).toMatchObject([{id:intent.id,state:"uncertain"}]);
 },60000);

});
