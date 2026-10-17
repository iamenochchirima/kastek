import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createServer,type ServerHttp2Session} from "node:http2";
import {createEndpointHandler} from "@restatedev/restate-sdk";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {setupPlatformSchema} from "../src/platform/setup";
import {PlatformStore} from "../src/platform/store";
import {defaultFaqConfiguration} from "../src/platform/contracts";
import {AutomationService,type AutomationConfig} from "../src/platform/automations";
import {createAutomationWorkflow,dispatchAutomationTimersOnce} from "../src/platform/automation-runtime";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("real Restate automation timers and occurrence recovery",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore,service:AutomationService,server:ReturnType<typeof createServer>,workflow:ReturnType<typeof createAutomationWorkflow>;
 let ingress:string,adminUrl:string,port:number,bridge:string,started=false;
 const sessions=new Set<ServerHttp2Session>(),observed=new Set<string>(),container=`agents-timer-test-${randomUUID()}`,database=`agents_timer_${randomUUID().replaceAll("-","")}`;
 const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",timeout:60000}).trim();
 const delay=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
 async function eventually<T>(check:()=>Promise<T|false>,timeout=15000):Promise<T>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value!==false)return value;await delay(50);}throw Error("Automation timer verification timed out");}
 async function listen(listenPort=0){server=createServer(createEndpointHandler({services:[workflow]}));server.on("session",session=>{sessions.add(session);session.once("close",()=>sessions.delete(session));});await new Promise<void>(done=>server.listen(listenPort,bridge,done));port=(server.address() as {port:number}).port;}
 async function stopWorker(){for(const session of sessions)session.destroy();await new Promise<void>(done=>server.close(()=>done()));}
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
  store=new PlatformStore(pool);service=new AutomationService(pool);
  const snapshot=service.timerSnapshot.bind(service);service.timerSnapshot=async(id,revision)=>{const value=await snapshot(id,revision);observed.add(`${id}:${revision}`);return value;};
  workflow=createAutomationWorkflow(service);
  // Unsigned SDK fixture binds only the private Docker bridge, never a LAN address.
  bridge=docker("network","inspect","bridge","--format","{{(index .IPAM.Config 0).Gateway}}");await listen();
  docker("run","-d","--name",container,"--cpus","2","--memory","768m","--add-host","host.docker.internal:host-gateway","-p","127.0.0.1::8080","-p","127.0.0.1::9070","docker.restate.dev/restatedev/restate:1.7.13");started=true;
  ingress=`http://${docker("port",container,"8080/tcp")}`;adminUrl=`http://${docker("port",container,"9070/tcp")}`;
  await eventually(async()=>{try{return(await fetch(`${adminUrl}/health`)).ok;}catch{return false;}});
  const registration=await fetch(`${adminUrl}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:`http://host.docker.internal:${port}`,force:false})});expect(registration.ok,await registration.text()).toBe(true);
 },60000);
 afterAll(async()=>{if(server?.listening)await stopWorker();if(started)docker("rm","-f",container);await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();}});
 async function fixture(schedule:AutomationConfig["schedule"],historical=false){
  const account=await store.ensureAccount({issuer:"http://localhost/timers",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),organization=await store.createOrganization(account.id,"Timer tests"),scope={accountId:account.id,organizationId:organization.id};
  const agent=await store.createAgent({...scope,name:"Scheduled FAQ",configuration:defaultFaqConfiguration()}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const input={name:"Scheduled work",versionId:version.id,input:"Summarize the permitted knowledge",reviewerAccountId:account.id,expiresAt:new Date(Date.now()+3600000).toISOString(),maxOccurrencesPerDay:20,schedule};
  let automation:{id:string;revision:number};
  if(historical){
   // Seed a valid immutable revision representing an old, still-unacknowledged timer outbox.
   const id=randomUUID();await pool.query("INSERT INTO agents_platform.automations(id,organization_id,owner_account_id,name) VALUES($1,$2,$3,$4)",[id,organization.id,account.id,input.name]);
   await pool.query("INSERT INTO agents_platform.automation_revisions(automation_id,revision,version_id,configuration,created_at) VALUES($1,1,$2,$3,now()-interval '10 minutes')",[id,version.id,input]);
   await pool.query("INSERT INTO agents_platform.automation_timer_outbox(automation_id,revision) VALUES($1,1)",[id]);automation={id,revision:1};
  }else automation=await service.create(scope,randomUUID(),input);
  return{account,organization,scope,automation,input};
 }
 async function occurrences(id:string){return(await pool.query("SELECT * FROM agents_platform.automation_occurrences WHERE automation_id=$1 ORDER BY created_at,id",[id])).rows;}
 async function accepted(id:string){return eventually(async()=>{const rows=await occurrences(id);return rows.find(row=>row.status==="accepted")??false;});}
 async function oneReservation(id:string){const row=(await pool.query("SELECT count(*)::int AS count FROM agents_platform.usage_reservations u JOIN agents_platform.automation_occurrences o ON o.task_id=u.task_id WHERE o.automation_id=$1",[id])).rows[0];expect(row.count).toBe(1);}
 it("keeps a durable due timer across worker loss and admits one original root",async()=>{
  const due=Date.now()+6000,f=await fixture({kind:"once",at:new Date(due).toISOString()});await dispatchAutomationTimersOnce(pool,ingress);
  await eventually(async()=>observed.has(`${f.automation.id}:1`));await delay(75);expect(Date.now()).toBeLessThan(due);await stopWorker();
  try{await delay(Math.max(1,due-Date.now()+150));expect(await occurrences(f.automation.id)).toHaveLength(0);}finally{await listen(port);}
  const occurrence=await accepted(f.automation.id);expect(new Date(occurrence.scheduled_at).getTime()).toBe(due);
  expect(await occurrences(f.automation.id)).toHaveLength(1);await oneReservation(f.automation.id);
 },30000);
 it("reuses the same runtime invocation after the timer outbox acknowledgement is lost",async()=>{
  const f=await fixture({kind:"once",at:new Date(Date.now()+1200).toISOString()}),invocations:string[]=[];
  await expect(dispatchAutomationTimersOnce(pool,ingress,async(url,init)=>{const response=await fetch(url,init);invocations.push((await response.clone().json() as {invocationId:string}).invocationId);throw Error("Injected acknowledgement loss after runtime acceptance");})).rejects.toThrow();
  await dispatchAutomationTimersOnce(pool,ingress,async(url,init)=>{const response=await fetch(url,init);invocations.push((await response.clone().json() as {invocationId:string}).invocationId);return response;});
  expect(invocations).toHaveLength(2);expect(invocations[0]).toBe(invocations[1]);await accepted(f.automation.id);
  expect(await occurrences(f.automation.id)).toHaveLength(1);await oneReservation(f.automation.id);
 },30000);
 it("fences old timers while paused or edited and resumes only the future revision",async()=>{
  const oldDue=Date.now()+1200,f=await fixture({kind:"once",at:new Date(oldDue).toISOString()});await dispatchAutomationTimersOnce(pool,ingress);await eventually(async()=>observed.has(`${f.automation.id}:1`));
  const paused=await service.change(f.scope,f.automation.id,randomUUID(),1,"pause"),newDue=Date.now()+2500;
  const edited=await service.change(f.scope,f.automation.id,randomUUID(),paused.revision,"edit",{...f.input,schedule:{kind:"once",at:new Date(newDue).toISOString()}});await dispatchAutomationTimersOnce(pool,ingress);
  await delay(Math.max(1,oldDue-Date.now()+100));expect(await occurrences(f.automation.id)).toHaveLength(0);
  const resumed=await service.change(f.scope,f.automation.id,randomUUID(),edited.revision,"resume");await dispatchAutomationTimersOnce(pool,ingress);
  const occurrence=await accepted(f.automation.id);expect(occurrence.revision).toBe(resumed.revision);expect(new Date(occurrence.scheduled_at).getTime()).toBe(newDue);
  const pausedAgain=await service.change(f.scope,f.automation.id,randomUUID(),resumed.revision,"pause");await expect(service.change(f.scope,f.automation.id,randomUUID(),pausedAgain.revision,"resume")).rejects.toMatchObject({code:"AUTOMATION_SCHEDULE_INVALID"});await dispatchAutomationTimersOnce(pool,ingress);await delay(200);
  expect(await occurrences(f.automation.id)).toHaveLength(1);await oneReservation(f.automation.id);
 },30000);
 it("coalesces a historical pending interval timer into one eligible root and a skipped summary",async()=>{
  const anchor=Date.now()-10*60000-500,f=await fixture({kind:"interval",anchor:new Date(anchor).toISOString(),everySeconds:60},true);
  await dispatchAutomationTimersOnce(pool,ingress);const occurrence=await accepted(f.automation.id),rows=await occurrences(f.automation.id);
  expect(rows.filter(row=>row.status==="accepted")).toHaveLength(1);expect(new Date(occurrence.scheduled_at).getTime()).toBeGreaterThan(Date.now()-60000);
  const skipped=rows.find(row=>row.status==="skipped_coalesced");expect(skipped).toBeDefined();expect(skipped.coalesced_count).toBeGreaterThanOrEqual(8);
  await oneReservation(f.automation.id);
 },30000);
});
