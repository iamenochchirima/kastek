import {randomUUID} from "node:crypto";
import {beginOperation,finishOperation,settleTask} from "../src/execution/lifecycle/execution";
import {Pool} from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import {createBookingFixture,createBookingProviderFixture,publishBookingFixture,type BookingProviderFixture} from "./booking-fixture";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("standing booking policy and exact customer confirmation",()=>{
 let admin:Pool,pool:Pool,provider:BookingProviderFixture;
 const database=`agents_booking_${randomUUID().replaceAll("-","")}`;
 beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);provider=await createBookingProviderFixture();});
 afterAll(async()=>{await provider?.close();await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 beforeEach(()=>provider.reset());
 const inserts=()=>provider.state.requests.filter(request=>request.method==="POST"&&request.url.includes("/events?"));
 async function prepared(){const f=await publishBookingFixture(await createBookingFixture(pool,provider)),operationId=randomUUID();const intent=await f.service.prepare(f.task.id,operationId,f.start);return {...f,operationId,intent};}
 async function admit(taskId:string,id:string,name="booking.reserve",request:unknown={}){const admission=await beginOperation(pool,taskId,{id,kind:"tool",name,request,reservedTokens:0,reservedMs:30000});expect(admission.waiting).not.toBe(true);}
 async function approved(){const f=await prepared();await f.service.decide(f.task.id,f.authority.principal,f.intent.id,{decision:"approve",requestDigest:f.intent.requestDigest});await admit(f.task.id,f.operationId,"booking.reserve",{start:f.start});return f;}
 it("requires explicit organization service sharing before policy creation and immutable publication",async()=>{
   const f=await createBookingFixture(pool,provider,false);await expect(f.service.createPolicy(f.scope,f.agent.id,f.policyInput)).rejects.toMatchObject({code:"GOOGLE_AUTHORITY_CHANGED"});
   expect(inserts()).toHaveLength(0);
   f.connection=await f.google.sharing(f.scope,f.connection.id,{generation:f.connection.generation,sharing:"organization_service"});
   const published=await publishBookingFixture(f);expect(published.version.configuration.capabilities.businessActions).toMatchObject({enabled:true,policyId:published.policy.id});
 });
 it("requires exact customer approval and never executes proposals or changed intent",async()=>{
   const f=await prepared();expect(f.intent.state).toBe("pending");expect(await f.service.prepare(f.task.id,f.operationId,f.start)).toEqual(f.intent);
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_CONFIRMATION_REQUIRED"});
   const changed=new Date(Date.parse(f.start)+3600000).toISOString();await expect(f.service.prepare(f.task.id,f.operationId,changed)).rejects.toMatchObject({code:"BOOKING_INTENT_CHANGED"});
   await expect(f.service.decide(f.task.id,f.authority.principal,f.intent.id,{decision:"approve",requestDigest:"0".repeat(64)})).rejects.toMatchObject({code:"BOOKING_NOT_FOUND"});
   await f.service.decide(f.task.id,f.authority.principal,f.intent.id,{decision:"reject",requestDigest:f.intent.requestDigest});
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_CONFIRMATION_REQUIRED"});expect(inserts()).toHaveLength(0);
 });
 it("inserts once with authoritative receipt and replays without a second provider operation",async()=>{
   const f=await approved(),result=await f.service.execute(f.task.id,f.operationId,f.start);expect(result).toMatchObject({state:"confirmed",bookingId:f.intent.id,receiptDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
   await finishOperation(pool,f.task.id,f.operationId,"completed",result,null,0);
   const count=provider.state.requests.length;expect(await f.service.execute(f.task.id,f.operationId,f.start)).toEqual(result);expect(provider.state.requests).toHaveLength(count);expect(inserts()).toHaveLength(1);
   const body=inserts()[0]!.body;expect(body.attendees).toBeUndefined();expect(body.extendedProperties.private.kasitekRequest).toBe(f.intent.requestDigest);
   const row=(await pool.query("SELECT state,provider_result FROM agents_platform.booking_intents WHERE id=$1",[f.intent.id])).rows[0];expect(row.state).toBe("confirmed");expect(row.provider_result).toMatchObject({state:"confirmed",eventId:body.id});
   const slot=(await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0];expect(slot.state).toBe("confirmed");
 });
 it("offers only policy-grid slots excluding provider busy intervals and durable local reservations",async()=>{
   const f=await prepared(),halfHour=1800000,secondStart=new Date(Date.parse(f.start)+halfHour).toISOString(),operationId=randomUUID();
   await expect(f.service.prepare(f.task.id,randomUUID(),new Date(Date.parse(f.start)+300000).toISOString())).rejects.toMatchObject({code:"BOOKING_SLOT_INVALID"});
   const second=await f.service.prepare(f.task.id,operationId,secondStart);await f.service.decide(f.task.id,f.authority.principal,second.id,{decision:"approve",requestDigest:second.requestDigest});
   await admit(f.task.id,operationId,"booking.reserve",{start:secondStart});const booked=await f.service.execute(f.task.id,operationId,secondStart);await finishOperation(pool,f.task.id,operationId,"completed",booked,null,0);provider.state.busy=[{start:f.start,end:secondStart}];
   const availabilityId=randomUUID(),range={start:f.start,end:new Date(Date.parse(f.start)+4*halfHour).toISOString()};await admit(f.task.id,availabilityId,"booking.availability",range);
   const result=await f.service.availability(f.task.id,availabilityId,range);
   expect(result.slots.map(slot=>slot.start)).toEqual([new Date(Date.parse(f.start)+2*halfHour).toISOString(),new Date(Date.parse(f.start)+3*halfHour).toISOString()]);expect(result.timeZone).toBe(provider.timeZone);expect(inserts()).toHaveLength(1);
 });
 it("enforces provider conflicts without inserts and releases the local hold",async()=>{
   const f=await approved();provider.state.busy=[{start:f.start,end:new Date(Date.parse(f.start)+1800000).toISOString()}];
   expect(await f.service.execute(f.task.id,f.operationId,f.start)).toMatchObject({state:"conflict"});expect(inserts()).toHaveLength(0);
   expect((await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0].state).toBe("released");
 });
 it("enforces local conflicts across separate confirmed intents without another provider read or insert",async()=>{
   const f=await approved();const booked=await f.service.execute(f.task.id,f.operationId,f.start);await finishOperation(pool,f.task.id,f.operationId,"completed",booked,null,0);
   const operationId=randomUUID(),intent=await f.service.prepare(f.task.id,operationId,f.start);await f.service.decide(f.task.id,f.authority.principal,intent.id,{decision:"approve",requestDigest:intent.requestDigest});
   await admit(f.task.id,operationId,"booking.reserve",{start:f.start});
   const count=provider.state.requests.length;expect(await f.service.execute(f.task.id,operationId,f.start)).toMatchObject({state:"conflict",bookingId:intent.id});expect(provider.state.requests).toHaveLength(count);expect(inserts()).toHaveLength(1);
 });
 it("reserves the same provider calendar across different authorized connection IDs",async()=>{
   const first=await approved(),second=await approved();let release!:()=>void,entered!:()=>void,reads=0;
   const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
   provider.state.beforeFreeBusy=async()=>{if(++reads===1){entered();await gate;}};
   const winner=first.service.execute(first.task.id,first.operationId,first.start);
   try{await started;expect(await second.service.execute(second.task.id,second.operationId,second.start)).toMatchObject({state:"conflict"});}
   finally{release();await winner;}
   expect(await winner).toMatchObject({state:"confirmed"});expect(inserts()).toHaveLength(1);
 });
 it("reconciles lost acknowledgment once and never resends an uncertain insertion",async()=>{
   const f=await approved();provider.state.mode="missing";
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_OUTCOME_UNCERTAIN"});
   expect(inserts()).toHaveLength(1);expect(provider.state.requests.filter(request=>request.method==="GET"&&request.url.includes("/events/"))).toHaveLength(1);
   const count=provider.state.requests.length;await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_OUTCOME_UNCERTAIN"});expect(provider.state.requests).toHaveLength(count);
   expect((await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0].state).toBe("uncertain");
 });
 it("denies cross-principal confirmation and revoked owner policy before sending",async()=>{
   const f=await prepared(),other={...f.authority.principal,subject:randomUUID()};
   await expect(f.service.decide(f.task.id,other,f.intent.id,{decision:"approve",requestDigest:f.intent.requestDigest})).rejects.toMatchObject({code:"BOOKING_NOT_FOUND"});
   await expect(f.service.listForPrincipal(f.task.id,other)).rejects.toMatchObject({code:"BOOKING_NOT_FOUND"});
   await f.service.decide(f.task.id,f.authority.principal,f.intent.id,{decision:"approve",requestDigest:f.intent.requestDigest});await f.service.withdrawPolicy(f.scope,f.agent.id,f.policy.id);
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_POLICY_UNAVAILABLE"});expect(inserts()).toHaveLength(0);
 });
 it("rechecks connection revocation after availability before any physical insert",async()=>{
   const f=await approved();provider.state.beforeFreeBusy=async()=>{await f.google.disconnect(f.scope,f.connection.id,{generation:f.connection.generation});};
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toThrow();expect(inserts()).toHaveLength(0);
   expect((await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0].state).toBe("released");
 });
 it("preserves a winner's held slot when a concurrent same-intent caller loses its single-send claim",async()=>{
   const f=await approved();let entered=0,releaseReads!:()=>void,releaseInsert!:()=>void,insertStarted!:()=>void;
   const reads=new Promise<void>(resolve=>{releaseReads=resolve;}),insertGate=new Promise<void>(resolve=>{releaseInsert=resolve;}),started=new Promise<void>(resolve=>{insertStarted=resolve;});
   provider.state.beforeFreeBusy=async()=>{if(++entered===2)releaseReads();await reads;};
   provider.state.beforeInsertResponse=async()=>{insertStarted();await insertGate;};
   const attempts=[f.service.execute(f.task.id,f.operationId,f.start),f.service.execute(f.task.id,f.operationId,f.start)];
   const observed=attempts.map(attempt=>attempt.then(value=>({value}),error=>({error})));
   try{await started;const loser=await Promise.race(observed);expect(loser).toHaveProperty("error");
     expect((await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0].state).toBe("held");
     expect((await pool.query("SELECT state FROM agents_platform.booking_intents WHERE id=$1",[f.intent.id])).rows[0].state).toBe("claimed");
   }finally{releaseReads();releaseInsert();await Promise.all(observed);}
   const results=await Promise.all(observed);expect(results.filter(result=>"value" in result)).toHaveLength(1);expect(inserts()).toHaveLength(1);
   expect((await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0].state).toBe("confirmed");
 });
 it("reconciles a lost successful insertion with one GET and authoritative confirmation",async()=>{
   const f=await approved();provider.state.mode="lost";
   expect(await f.service.execute(f.task.id,f.operationId,f.start)).toMatchObject({state:"confirmed"});expect(inserts()).toHaveLength(1);
   expect(provider.state.requests.filter(request=>request.method==="GET"&&request.url.includes("/events/"))).toHaveLength(1);
 });
 it("denies a different workspace member's task despite a valid grant to the published version",async()=>{
   const f=await approved(),member=await f.platform.ensureAccount({issuer:f.account.issuer,subject:randomUUID(),email:"member@example.test",displayName:"Member"});
   await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.scope.organizationId,member.id]);
   const principal={kind:"human" as const,issuer:member.issuer,subject:member.subject},grant={...f.grant,id:randomUUID(),principal};
   await f.platform.createGrant({accountId:member.id,grant});const {task}=await f.platform.admitTask({...f.request,authority:{...f.authority,principal},grantId:grant.id,requestKey:randomUUID()});
   await expect(f.service.prepare(task.id,randomUUID(),f.start)).rejects.toMatchObject({code:"BOOKING_SCOPE_DENIED"});expect(inserts()).toHaveLength(0);
 });
 it("withdraws booking authority when the policy owner loses workspace membership",async()=>{
   const f=await approved();await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.scope.organizationId,f.scope.accountId]);
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"MEMBERSHIP_INACTIVE"});expect(inserts()).toHaveLength(0);
 });
 it("does not allow a claimed insertion to be taken over or resent after a crash",async()=>{
   const f=await approved();await pool.query("UPDATE agents_platform.booking_intents SET state='claimed',claimed_at=now() WHERE id=$1",[f.intent.id]);
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_OUTCOME_UNCERTAIN"});expect(inserts()).toHaveLength(0);
 });
 it("requires a started matching tool operation and preserves its original deadline before any provider request",async()=>{
   const f=await prepared();await f.service.decide(f.task.id,f.authority.principal,f.intent.id,{decision:"approve",requestDigest:f.intent.requestDigest});const before=provider.state.requests.length;
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_OPERATION_REQUIRED"});
   await expect(f.service.availability(f.task.id,randomUUID(),{start:f.start,end:new Date(Date.parse(f.start)+3600000).toISOString()})).rejects.toMatchObject({code:"BOOKING_OPERATION_REQUIRED"});expect(provider.state.requests).toHaveLength(before);
   await admit(f.task.id,f.operationId,"booking.reserve",{start:f.start});await pool.query("UPDATE agents_platform.operations SET started_at=now()-interval '31 seconds' WHERE id=$1",[f.operationId]);
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_OPERATION_EXPIRED"});expect(provider.state.requests).toHaveLength(before);expect((await pool.query("SELECT 1 FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rowCount).toBe(0);
 });
 it("does not renew the original operation deadline between availability and event insertion",async()=>{
   const f=await approved();provider.state.beforeFreeBusy=async()=>{await pool.query("UPDATE agents_platform.operations SET started_at=now()-interval '31 seconds' WHERE id=$1",[f.operationId]);};
   await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_OPERATION_EXPIRED"});expect(inserts()).toHaveLength(0);expect((await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0].state).toBe("released");
 });
 async function uncertain(){
   const f=await approved();provider.state.mode="missing";await expect(f.service.execute(f.task.id,f.operationId,f.start)).rejects.toMatchObject({code:"BOOKING_OUTCOME_UNCERTAIN"});
   await finishOperation(pool,f.task.id,f.operationId,"uncertain",null,"BOOKING_OUTCOME_UNCERTAIN",0);await settleTask(pool,f.task.id,{state:"uncertain",errorCode:"BOOKING_OUTCOME_UNCERTAIN"});return f;
 }
 it("recovers an accepted event by GET only without rewriting the original uncertain task or operation",async()=>{
   const f=await uncertain(),before=provider.state.requests.length;
   const history=async()=>({task:(await pool.query("SELECT state,error_code,output FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0],operation:(await pool.query("SELECT state,error_code,output FROM agents_platform.operations WHERE id=$1",[f.operationId])).rows[0]});const original=await history();
   provider.state.mode="normal";expect(await f.service.reconcile(f.task.id,f.authority.principal,f.intent.id)).toMatchObject({state:"confirmed"});
   expect(provider.state.requests.slice(before).map(request=>request.method)).toEqual(["GET"]);expect(inserts()).toHaveLength(1);expect(await history()).toEqual(original);
   expect((await pool.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1",[f.intent.id])).rows[0].state).toBe("confirmed");
   const attempts=(await pool.query("SELECT phase,state,receipt FROM agents_platform.booking_attempts WHERE booking_id=$1 ORDER BY ordinal",[f.intent.id])).rows;
   expect(attempts.map(row=>row.phase)).toEqual(["availability","create","reconcile","reconcile"]);expect(attempts.every(row=>row.state==="completed")).toBe(true);expect(JSON.stringify(attempts)).not.toContain("booking-fixture-token");
 });
 it("denies foreign status lookup and withdrawn service policy without contacting Google",async()=>{
   const f=await uncertain(),other=await createBookingFixture(pool,provider),before=provider.state.requests.length;
   await expect(f.service.reconcile(f.task.id,{...f.authority.principal,subject:randomUUID()},f.intent.id)).rejects.toMatchObject({code:"BOOKING_NOT_FOUND"});
   await expect(f.service.reconcile(f.task.id,undefined,f.intent.id,other.scope)).rejects.toMatchObject({code:"BOOKING_NOT_FOUND"});
   await f.service.withdrawPolicy(f.scope,f.agent.id,f.policy.id);await expect(f.service.reconcile(f.task.id,f.authority.principal,f.intent.id)).rejects.toMatchObject({code:"BOOKING_POLICY_UNAVAILABLE"});expect(provider.state.requests).toHaveLength(before);expect(inserts()).toHaveLength(1);
 });
 it("leases concurrent status checks outside database locks and performs one provider GET",async()=>{
   const f=await uncertain();provider.state.mode="normal";let release!:()=>void,entered!:()=>void;
   const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});provider.state.beforeReconcileResponse=async()=>{entered();await gate;};
   const before=provider.state.requests.length,first=f.service.reconcile(f.task.id,f.authority.principal,f.intent.id);
   try{await started;await expect(f.service.reconcile(f.task.id,f.authority.principal,f.intent.id)).rejects.toMatchObject({code:"BOOKING_RECONCILING"});
     const db=await pool.connect();try{await db.query("BEGIN");await db.query("SELECT 1 FROM agents_platform.booking_intents WHERE id=$1 FOR UPDATE NOWAIT",[f.intent.id]);await db.query("ROLLBACK");}finally{db.release();}
   }finally{provider.state.beforeReconcileResponse=undefined;release();}
   expect(await first).toMatchObject({state:"confirmed"});expect(provider.state.requests.slice(before).map(request=>request.method)).toEqual(["GET"]);expect(inserts()).toHaveLength(1);
 });
 it("recovers an abandoned claimed record after terminal settlement without taking over an active insertion",async()=>{
   const f=await uncertain();await pool.query("UPDATE agents_platform.booking_intents SET state='claimed',claimed_at=now()-interval '2 minutes',result=NULL,provider_result=NULL WHERE id=$1",[f.intent.id]);
   provider.state.mode="normal";const before=provider.state.requests.length;expect(await f.service.reconcile(f.task.id,f.authority.principal,f.intent.id)).toMatchObject({state:"confirmed"});expect(provider.state.requests.slice(before).map(request=>request.method)).toEqual(["GET"]);expect(inserts()).toHaveLength(1);
   const active=await approved();await pool.query("UPDATE agents_platform.booking_intents SET state='claimed',claimed_at=now() WHERE id=$1",[active.intent.id]);const count=provider.state.requests.length;
   await expect(active.service.reconcile(active.task.id,active.authority.principal,active.intent.id)).rejects.toMatchObject({code:"BOOKING_IN_PROGRESS"});expect(provider.state.requests).toHaveLength(count);
 });
 it("caps physical status requests at sixteen across repeated manual checks without another insertion",async()=>{
   const f=await uncertain();for(let index=0;index<13;index++)expect(await f.service.reconcile(f.task.id,f.authority.principal,f.intent.id)).toMatchObject({state:"uncertain"});
   const count=provider.state.requests.length;expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.booking_attempts WHERE booking_id=$1",[f.intent.id])).rows[0].count).toBe(16);
   expect(await f.service.reconcile(f.task.id,f.authority.principal,f.intent.id)).toMatchObject({state:"uncertain"});expect(provider.state.requests).toHaveLength(count);expect(inserts()).toHaveLength(1);
 });
 it("refreshes an expired but refreshable credential outside policy creation locks",async()=>{
   const f=await createBookingFixture(pool,provider),oauth=f.google.options.oauth!,original=oauth.refresh.bind(oauth);let refreshes=0;
   oauth.refresh=async(...args)=>{refreshes++;const db=await pool.connect();try{await db.query("BEGIN");await db.query("SELECT 1 FROM agents_platform.connections WHERE id=$1 FOR UPDATE NOWAIT",[f.connection.id]);await db.query("SELECT 1 FROM agents_platform.google_calendar_connections WHERE connection_id=$1 FOR UPDATE NOWAIT",[f.connection.id]);await db.query("ROLLBACK");}finally{db.release();}return original(...args);};
   await pool.query("UPDATE agents_platform.google_calendar_connections SET token_expires_at=now()-interval '1 minute' WHERE connection_id=$1",[f.connection.id]);
   expect(await f.service.createPolicy(f.scope,f.agent.id,f.policyInput)).toMatchObject({state:"active"});expect(refreshes).toBe(1);const current=await f.google.get(f.scope,f.connection.id);expect(current.policyRevision).toBe(f.connection.policyRevision);expect(current.revision).toBe(f.connection.revision+1);expect(inserts()).toHaveLength(0);
 });

});
