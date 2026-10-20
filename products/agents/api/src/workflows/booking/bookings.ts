import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError,requestDigest,terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentAuthority,loadExecution } from "../../execution/lifecycle/execution";
import { notifyActionTask,requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { channelPorts } from "../../infrastructure/channel-ports";
import { channelBindingSchema } from "../../contracts/channel";
import { recordEvent } from "../../observability/event-store";
import { bookingPolicySchema,bookingWindow,loadBookingPolicy,type BookingPolicy } from "./policy";
import { GoogleCalendarClient,type GoogleBookingIntent } from "../../adapters/providers/google-calendar";

export interface ResolvedBookingCalendar {
  connectionId:string;ownerAccountId:string;organizationId:string;calendarId:string;calendarName:string;timeZone:string;
  policyRevision:number;generation:number;accessToken:string;
}
export interface BookingOptions {
  resolveCalendar(db:PoolClient,scope:ActionScope,id:string,policyRevision:number,options:{requireOrganizationService:boolean}):Promise<ResolvedBookingCalendar>;
  ensureFresh(scope:ActionScope,id:string):Promise<void>;
  testBaseUrl?:string;
}
export interface BookingConfirmation {id:string;taskId:string;state:string;start:string;end:string;timeZone:string;title:string;requestDigest:string;expiresAt:string}
const missing=()=>new PlatformError("BOOKING_NOT_FOUND",404,"Booking not found");
const denied=()=>new PlatformError("BOOKING_SCOPE_DENIED",403,"Booking permission is unavailable");
const dto=(row:Record<string,any>,policy:BookingPolicy):BookingConfirmation=>({id:row.id,taskId:row.task_id,state:row.state==="pending"&&new Date(row.expires_at).getTime()<=Date.now()?"expired":row.state,start:new Date(row.starts_at).toISOString(),end:new Date(row.ends_at).toISOString(),timeZone:policy.timeZone,title:policy.title,requestDigest:row.request_digest,expiresAt:new Date(row.expires_at).toISOString()});

export class BookingService {
  constructor(readonly pool:Pool,readonly options:BookingOptions){}
  private async uncertainHandoff(taskId:string,operationId:string):Promise<void> {
    try {
      await transaction(this.pool,async db=>{
        const execution=await loadExecution(db,taskId,true);
        if(!execution.task.channel_binding)return;
        const binding=channelBindingSchema.parse(execution.task.channel_binding),ports=channelPorts(db);
        await ports.assertBinding(db,binding,execution.task);
        await ports.requestHandoff(db,binding,taskId);
      });
    }catch(error){
      if(error instanceof PlatformError&&["CHANNEL_OWNERSHIP_CHANGED","CHANNEL_INPUT_DENIED"].includes(error.code))return;
      // An escalation failure cannot turn an unknown external effect into a safe retry.
      await recordEvent(this.pool,taskId,`booking-handoff-failed:${operationId}`,"tool.booking_handoff_failed",{operationId,outcome:"failed"}).catch(()=>undefined);
    }
  }
  private async owner(db:PoolClient,scope:ActionScope) {
    await requireActionMember(db,scope);
    if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)throw denied();
  }
  async listPolicies(scope:ActionScope,agentId:string) {
    return transaction(this.pool,async db=>{await requireActionMember(db,scope);
      return (await db.query("SELECT id,digest AS \"policyDigest\",state,definition FROM agents_platform.booking_policies WHERE organization_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id",[scope.organizationId,z.uuid().parse(agentId)])).rows;
    });
  }
  async createPolicy(scope:ActionScope,agentId:string,raw:unknown) {
    const input=z.strictObject(bookingPolicySchema.shape).omit({ownerAccountId:true,calendarId:true,timeZone:true,connectionPolicyRevision:true}).parse(raw);
    await transaction(this.pool,db=>this.owner(db,scope));
    await this.options.ensureFresh(scope,input.connectionId);
    return transaction(this.pool,async db=>{
      await this.owner(db,scope);
      if(!(await db.query("SELECT 1 FROM agents_platform.agents WHERE id=$1 AND organization_id=$2",[z.uuid().parse(agentId),scope.organizationId])).rowCount)throw missing();
      const connection=(await db.query("SELECT policy_revision FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND state='active' FOR SHARE",[input.connectionId,scope.organizationId,scope.accountId])).rows[0];
      if(!connection)throw denied();
      const selected=await this.options.resolveCalendar(db,scope,input.connectionId,connection.policy_revision,{requireOrganizationService:true});
      const definition=bookingPolicySchema.parse({...input,ownerAccountId:scope.accountId,connectionPolicyRevision:selected.policyRevision,calendarId:selected.calendarId,timeZone:selected.timeZone});
      new Intl.DateTimeFormat("en-US",{timeZone:definition.timeZone}).format();
      const id=randomUUID(),digest=requestDigest(definition);
      await db.query("INSERT INTO agents_platform.booking_policies(id,organization_id,agent_id,owner_account_id,definition,digest) VALUES($1,$2,$3,$4,$5,$6)",[id,scope.organizationId,agentId,scope.accountId,definition,digest]);
      return {id,policyDigest:digest,state:"active",definition};
    });
  }
  async withdrawPolicy(scope:ActionScope,agentId:string,id:string) {
    return transaction(this.pool,async db=>{await this.owner(db,scope);
      if(!(await db.query("UPDATE agents_platform.booking_policies SET state='withdrawn' WHERE id=$1 AND organization_id=$2 AND agent_id=$3 RETURNING id",[z.uuid().parse(id),scope.organizationId,z.uuid().parse(agentId)])).rowCount)throw missing();
      return {withdrawn:true};
    });
  }
  private async authority(db:PoolClient,taskId:string) {
    const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
    const reference=execution.configuration.capabilities.businessActions;
    if(!reference.enabled||execution.task.parent_task_id)throw denied();
    const policy=await loadBookingPolicy(db,execution.task.organization_id,execution.agentId,reference);
    const principal=execution.task.principal;
    if(principal.kind==="human") {
      const account=(await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2",[principal.issuer,principal.subject])).rows[0];
      if(account?.id!==policy.ownerAccountId)throw denied();
    }else if(principal.kind!=="visitor"||!execution.task.channel_binding)throw denied();
    return {execution,policy,scope:{organizationId:execution.task.organization_id,accountId:policy.ownerAccountId}};
  }
  async prepare(taskId:string,operationId:string,start:string):Promise<BookingConfirmation> {
    return transaction(this.pool,async db=>{
      const {execution,policy}=await this.authority(db,taskId),window=bookingWindow(policy,start);
      const digest=requestDigest({policy:execution.configuration.capabilities.businessActions,principal:execution.task.principal,...window});
      const prior=(await db.query("SELECT * FROM agents_platform.booking_intents WHERE task_id=$1 AND operation_id=$2",[taskId,operationId])).rows[0];
      if(prior){if(prior.request_digest!==digest)throw new PlatformError("BOOKING_INTENT_CHANGED",409,"The appointment changed");return dto(prior,policy);}
      if(Number((await db.query("SELECT count(*) FROM agents_platform.booking_intents WHERE task_id=$1",[taskId])).rows[0].count)>=8)throw new PlatformError("BOOKING_INTENT_LIMIT",409,"Too many appointment proposals");
      const row=(await db.query(`INSERT INTO agents_platform.booking_intents(id,organization_id,task_id,operation_id,policy_id,request_digest,principal,starts_at,ends_at,state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',LEAST($10::timestamptz,now()+interval '10 minutes')) RETURNING *`,
        [randomUUID(),execution.task.organization_id,taskId,operationId,execution.configuration.capabilities.businessActions.enabled?execution.configuration.capabilities.businessActions.policyId:null,digest,execution.task.principal,window.start,window.end,execution.task.deadline_at])).rows[0];
      return dto(row,policy);
    });
  }
  async listForPrincipal(taskId:string,principal:unknown):Promise<BookingConfirmation[]> {
    return transaction(this.pool,async db=>{
      const task=(await db.query("SELECT principal,organization_id FROM agents_platform.tasks WHERE id=$1",[z.uuid().parse(taskId)])).rows[0];
      if(!task||requestDigest(task.principal)!==requestDigest(principal))throw missing();
      const rows=(await db.query("SELECT i.*,p.definition FROM agents_platform.booking_intents i JOIN agents_platform.booking_policies p ON p.id=i.policy_id WHERE i.task_id=$1 ORDER BY i.created_at,i.id LIMIT 8",[taskId])).rows;
      return rows.map(row=>dto(row,bookingPolicySchema.parse(row.definition)));
    });
  }
  async decide(taskId:string,principal:unknown,id:string,input:{decision:"approve"|"reject";requestDigest:string}) {
    z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(input);
    return transaction(this.pool,async db=>{
      const {execution,policy}=await this.authority(db,taskId);
      if(requestDigest(execution.task.principal)!==requestDigest(principal))throw missing();
      const row=(await db.query("SELECT * FROM agents_platform.booking_intents WHERE id=$1 AND task_id=$2 FOR UPDATE",[z.uuid().parse(id),taskId])).rows[0];
      if(!row||row.request_digest!==input.requestDigest)throw missing();
      const state=input.decision==="approve"?"approved":"rejected";
      if(row.state===state)return dto(row,policy);
      if(row.state!=="pending"||new Date(row.expires_at).getTime()<=Date.now())throw new PlatformError("BOOKING_CONFIRMATION_EXPIRED",409,"This appointment proposal has expired");
      const updated=(await db.query("UPDATE agents_platform.booking_intents SET state=$2,approved_at=CASE WHEN $2='approved' THEN now() ELSE NULL END WHERE id=$1 RETURNING *",[id,state])).rows[0];
      await notifyActionTask(db,taskId);return dto(updated,policy);
    });
  }
  async reconcile(taskId:string,principal:unknown,id:string,staffScope?:ActionScope):Promise<BookingConfirmation> {
    const lease=randomUUID();
    const target=await transaction(this.pool,async db=>{
      const execution=await loadExecution(db,z.uuid().parse(taskId),true);
      if(staffScope){await requireActionMember(db,staffScope);if(staffScope.organizationId!==execution.task.organization_id)throw missing();}
      else if(requestDigest(principal)!==requestDigest(execution.task.principal))throw missing();
      const reference=execution.configuration.capabilities.businessActions;if(!reference.enabled)throw missing();
      const policy=await loadBookingPolicy(db,execution.task.organization_id,execution.agentId,reference);
      const row=(await db.query("SELECT * FROM agents_platform.booking_intents WHERE id=$1 AND task_id=$2 FOR UPDATE",[z.uuid().parse(id),taskId])).rows[0];
      if(!row)throw missing();
      if(row.state!=="claimed"&&row.state!=="uncertain")return {execution,policy,row,settled:true};
      if(row.state==="claimed"&&!terminalTaskStates.has(execution.task.state)&&new Date(row.claimed_at).getTime()+60000>Date.now())
        throw new PlatformError("BOOKING_IN_PROGRESS",409,"The appointment is still being confirmed");
      if(row.reconcile_lease&&new Date(row.reconcile_until).getTime()>Date.now())throw new PlatformError("BOOKING_RECONCILING",409,"Appointment status is being checked");
      await db.query("UPDATE agents_platform.booking_intents SET reconcile_lease=$2,reconcile_until=now()+interval '45 seconds',state='uncertain' WHERE id=$1",[id,lease]);
      return {execution,policy,row,settled:false};
    });
    if(target.settled)return dto(target.row,target.policy);
    const scope={organizationId:target.execution.task.organization_id,accountId:target.policy.ownerAccountId};
    try {
      await this.options.ensureFresh(scope,target.policy.connectionId);
      const calendar=await transaction(this.pool,db=>this.options.resolveCalendar(db,scope,target.policy.connectionId,target.policy.connectionPolicyRevision,{requireOrganizationService:true}));
      const beforeAttempt=()=>transaction(this.pool,async db=>{
        if(staffScope)await requireActionMember(db,staffScope);
        await loadBookingPolicy(db,scope.organizationId,target.execution.agentId,target.execution.configuration.capabilities.businessActions as Parameters<typeof loadBookingPolicy>[3]);
        await this.options.resolveCalendar(db,scope,target.policy.connectionId,target.policy.connectionPolicyRevision,{requireOrganizationService:true});
        if(!(await db.query("SELECT 1 FROM agents_platform.booking_intents WHERE id=$1 AND reconcile_lease=$2 AND reconcile_until>now() FOR SHARE",[id,lease])).rowCount)throw new PlatformError("BOOKING_RECONCILING",409,"Appointment status check changed");
      });
      const intent:GoogleBookingIntent={organizationId:scope.organizationId,bookingId:id,calendarId:calendar.calendarId,start:new Date(target.row.starts_at).toISOString(),end:new Date(target.row.ends_at).toISOString(),timeZone:calendar.timeZone,summary:target.policy.title,requestDigest:target.row.request_digest};
      const receipt=await this.client(calendar,Date.now()+30000,undefined,beforeAttempt,id).reconcileBooking(intent);
      const result=await transaction(this.pool,async db=>{
        const result={state:receipt.state,bookingId:id,start:intent.start,end:intent.end,...(receipt.state==="confirmed"?{receiptDigest:receipt.receiptDigest}:{})};
        const row=(await db.query("UPDATE agents_platform.booking_intents SET state=$3,result=$4,provider_result=$5,reconcile_lease=NULL,reconcile_until=NULL WHERE id=$1 AND reconcile_lease=$2 RETURNING *",[id,lease,receipt.state,result,receipt])).rows[0];
        if(!row)throw new PlatformError("BOOKING_RECONCILING",409,"Appointment status check changed");
        await db.query("UPDATE agents_platform.booking_slots SET state=$2 WHERE booking_id=$1",[id,receipt.state]);
        await recordEvent(db,taskId,`booking-reconcile:${id}:${lease}`,"tool.booking_reconciled",{operationId:target.row.operation_id,connectionId:calendar.connectionId,policyRevision:calendar.policyRevision,outcome:receipt.state==="confirmed"?"completed":"uncertain"});
        return dto(row,target.policy);
      });
      if(result.state==="uncertain")await this.uncertainHandoff(taskId,target.row.operation_id);
      return result;
    }finally {await this.pool.query("UPDATE agents_platform.booking_intents SET reconcile_lease=NULL,reconcile_until=NULL WHERE id=$1 AND reconcile_lease=$2",[id,lease]);}
  }
  private client(calendar:ResolvedBookingCalendar,deadlineAt:number,signal:AbortSignal|undefined,beforeAttempt:()=>Promise<void>,bookingId?:string) {
    let ordinal:number|undefined;
    return new GoogleCalendarClient(calendar.accessToken,{deadlineAt,signal,testBaseUrl:this.options.testBaseUrl,
      beforeAttempt:async operation=>{
        await beforeAttempt();
        if(!bookingId)return;
        ordinal=await transaction(this.pool,async db=>{
          await db.query("SELECT id FROM agents_platform.booking_intents WHERE id=$1 FOR UPDATE",[bookingId]);
          const next=Number((await db.query("SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM agents_platform.booking_attempts WHERE booking_id=$1",[bookingId])).rows[0].ordinal);
          if(next>16)throw new PlatformError("BOOKING_REQUEST_LIMIT",429,"Appointment status checks reached their request limit; contact support");
          await db.query("INSERT INTO agents_platform.booking_attempts(booking_id,ordinal,phase,state) VALUES($1,$2,$3,'started')",[bookingId,next,operation==="insert"?"create":operation==="reconcile"?"reconcile":"availability"]);
          return next;
        });
      },
      onAttempt:async attempt=>{if(bookingId&&ordinal)await this.pool.query("UPDATE agents_platform.booking_attempts SET state='completed',receipt=$3 WHERE booking_id=$1 AND ordinal=$2",[bookingId,ordinal,{status:attempt.status,requestBytes:attempt.requestBytes,responseBytes:attempt.responseBytes,elapsedMs:attempt.elapsedMs,outcome:attempt.outcome}]);},
    });
  }
  private async operationDeadline(db:PoolClient,taskId:string,operationId:string,name:string) {
    const row=(await db.query(`SELECT LEAST(o.started_at+make_interval(secs=>o.reserved_ms::double precision/1000),t.deadline_at) AS deadline
      FROM agents_platform.operations o JOIN agents_platform.tasks t ON t.id=o.task_id
      WHERE o.id=$1 AND o.task_id=$2 AND o.name=$3 AND o.kind='tool' AND o.state='started' FOR SHARE OF o`,[operationId,taskId,name])).rows[0];
    if(!row)throw new PlatformError("BOOKING_OPERATION_REQUIRED",403,"A current admitted booking operation is required");
    const deadline=new Date(row.deadline).getTime();
    if(deadline<=Date.now())throw new PlatformError("BOOKING_OPERATION_EXPIRED",409,"The booking operation reached its deadline");
    return deadline;
  }
  async availability(taskId:string,operationId:string,range:{start:string;end:string},signal?:AbortSignal) {
    const prepared=await transaction(this.pool,async db=>({...await this.authority(db,taskId),deadline:await this.operationDeadline(db,taskId,operationId,"booking.availability")}));
    const start=new Date(range.start).getTime(),end=new Date(range.end).getTime();
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>7*86400000)throw new PlatformError("BOOKING_RANGE_INVALID",400,"Choose a range of at most seven days");
    await this.options.ensureFresh(prepared.scope,prepared.policy.connectionId);
    const calendar=await transaction(this.pool,db=>this.options.resolveCalendar(db,prepared.scope,prepared.policy.connectionId,prepared.policy.connectionPolicyRevision,{requireOrganizationService:true}));
    const provider=this.client(calendar,prepared.deadline,signal,async()=>{await transaction(this.pool,async db=>{await this.authority(db,taskId);await this.operationDeadline(db,taskId,operationId,"booking.availability");});});
    const busy=await provider.freeBusy(calendar.calendarId,{start:range.start,end:range.end});
    const held=(await this.pool.query("SELECT starts_at,ends_at FROM agents_platform.booking_slots WHERE calendar_id=$1 AND state<>'released' AND starts_at<$3 AND ends_at>$2",[calendar.calendarId,range.start,range.end])).rows;
    const intervals=[...busy.busy.map(span=>({start:Date.parse(span.start),end:Date.parse(span.end)})),...held.map(span=>({start:new Date(span.starts_at).getTime(),end:new Date(span.ends_at).getTime()}))];
    const slots:{start:string;end:string}[]=[];
    for(let cursor=Math.ceil(start/300000)*300000;cursor<end&&slots.length<100;cursor+=300000) {
      try{const slot=bookingWindow(prepared.policy,new Date(cursor).toISOString());
        if(Date.parse(slot.end)>end||intervals.some(span=>span.start<Date.parse(slot.end)&&span.end>cursor))continue;
        const local=new Intl.DateTimeFormat("en-US",{timeZone:prepared.policy.timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(cursor));
        const values=Object.fromEntries(local.map(part=>[part.type,part.value])),minutes=Number(values.hour)*60+Number(values.minute);
        const [hour,minute]=prepared.policy.opensAt.split(":").map(Number);
        if((minutes-hour!*60-minute!)%prepared.policy.durationMinutes!==0)continue;
        slots.push(slot);
      }catch(error){if(!(error instanceof PlatformError))throw error;}
    }
    await recordEvent(this.pool,taskId,`booking-availability:${operationId}`,"tool.booking_availability",{operationId,connectionId:calendar.connectionId,policyRevision:calendar.policyRevision,count:slots.length,outcome:"completed"});
    return {slots,timeZone:calendar.timeZone};
  }
  async execute(taskId:string,operationId:string,start:string,signal?:AbortSignal) {
    const existing=(await this.pool.query("SELECT * FROM agents_platform.booking_intents WHERE task_id=$1 AND operation_id=$2",[taskId,operationId])).rows[0];
    if(!existing)throw missing();
    if(new Date(existing.starts_at).toISOString()!==new Date(start).toISOString())throw new PlatformError("BOOKING_INTENT_CHANGED",409,"The appointment changed");
    if(existing.state==="confirmed"||existing.state==="conflict")return existing.result;
    if(existing.state==="claimed"||existing.state==="uncertain"){
      if(existing.state==="uncertain")await this.uncertainHandoff(taskId,operationId);
      throw new PlatformError("BOOKING_OUTCOME_UNCERTAIN",409,"The appointment outcome is uncertain; it was not submitted again");
    }
    const prepared=await transaction(this.pool,async db=>{
      const authorized=await this.authority(db,taskId),window=bookingWindow(authorized.policy,start);
      const row=(await db.query("SELECT * FROM agents_platform.booking_intents WHERE id=$1 FOR UPDATE",[existing.id])).rows[0];
      if(row.state!=="approved"||new Date(row.expires_at).getTime()<=Date.now()||new Date(row.starts_at).toISOString()!==window.start)throw new PlatformError("BOOKING_CONFIRMATION_REQUIRED",409,"Confirm the exact appointment first");
      const deadline=await this.operationDeadline(db,taskId,operationId,"booking.reserve");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`booking:google-calendar:${authorized.policy.calendarId}`]);
      await db.query(`UPDATE agents_platform.booking_slots s SET state='released' FROM agents_platform.booking_intents i
        WHERE s.booking_id=i.id AND s.calendar_id=$1 AND s.state='held' AND i.state IN ('approved','expired','rejected') AND i.expires_at<=now()`,[authorized.policy.calendarId]);
      const overlap=await db.query("SELECT 1 FROM agents_platform.booking_slots WHERE calendar_id=$1 AND state<>'released' AND booking_id<>$2 AND starts_at<$4 AND ends_at>$3 LIMIT 1",[authorized.policy.calendarId,row.id,window.start,window.end]);
      if(overlap.rowCount){const result={state:"conflict",bookingId:row.id,...window};await db.query("UPDATE agents_platform.booking_intents SET state='conflict',result=$2 WHERE id=$1",[row.id,result]);return {...authorized,row,window,deadline,conflict:result};}
      await db.query("INSERT INTO agents_platform.booking_slots(booking_id,connection_id,calendar_id,starts_at,ends_at,state) VALUES($1,$2,$3,$4,$5,'held') ON CONFLICT(booking_id) DO NOTHING",[row.id,authorized.policy.connectionId,authorized.policy.calendarId,window.start,window.end]);
      return {...authorized,row,window,deadline};
    });
    if("conflict" in prepared)return prepared.conflict;
    let claimed=false;
    try {
    await this.options.ensureFresh(prepared.scope,prepared.policy.connectionId);
    const calendar=await transaction(this.pool,db=>this.options.resolveCalendar(db,prepared.scope,prepared.policy.connectionId,prepared.policy.connectionPolicyRevision,{requireOrganizationService:true}));
    const admit=async(effect:boolean)=>{const didClaim=await transaction(this.pool,async db=>{
      if(!claimed)await this.authority(db,taskId);
      await this.operationDeadline(db,taskId,operationId,"booking.reserve");
      await this.options.resolveCalendar(db,prepared.scope,prepared.policy.connectionId,prepared.policy.connectionPolicyRevision,{requireOrganizationService:true});
      if(effect&&!claimed) {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`booking:google-calendar:${prepared.policy.calendarId}`]);
        const slot=(await db.query("SELECT state FROM agents_platform.booking_slots WHERE booking_id=$1 FOR UPDATE",[prepared.row.id])).rows[0];
        const overlap=await db.query("SELECT 1 FROM agents_platform.booking_slots WHERE calendar_id=$1 AND state<>'released' AND booking_id<>$2 AND starts_at<$4 AND ends_at>$3 LIMIT 1",[prepared.policy.calendarId,prepared.row.id,prepared.window.start,prepared.window.end]);
        if(slot?.state!=="held"||overlap.rowCount)throw new PlatformError("BOOKING_SLOT_CHANGED",409,"The appointment slot is no longer reserved");
        const row=(await db.query("UPDATE agents_platform.booking_intents SET state='claimed',claimed_at=now() WHERE id=$1 AND state='approved' AND expires_at>now() RETURNING id",[prepared.row.id])).rows[0];
        if(!row)throw new PlatformError("BOOKING_CONFIRMATION_REQUIRED",409,"Appointment confirmation is unavailable");
        await recordEvent(db,taskId,`booking-claim:${prepared.row.id}`,"tool.booking_claimed",{operationId,connectionId:calendar.connectionId,policyRevision:calendar.policyRevision,outcome:"started"});
        return true;
      }
      return false;
    });if(didClaim)claimed=true;};
      const available=await this.client(calendar,prepared.deadline,signal,()=>admit(false),prepared.row.id).freeBusy(calendar.calendarId,prepared.window);
      if(available.busy.some(span=>Date.parse(span.start)<Date.parse(prepared.window.end)&&Date.parse(span.end)>Date.parse(prepared.window.start))) {
        const result={state:"conflict",bookingId:prepared.row.id,...prepared.window};
        await transaction(this.pool,async db=>{const changed=await db.query("UPDATE agents_platform.booking_intents SET state='conflict',result=$2 WHERE id=$1 AND state='approved'",[prepared.row.id,result]);if(!changed.rowCount)throw new PlatformError("BOOKING_CONFIRMATION_REQUIRED",409,"Appointment confirmation is unavailable");await db.query("UPDATE agents_platform.booking_slots SET state='released' WHERE booking_id=$1 AND state='held'",[prepared.row.id]);});return result;
      }
      const intent:GoogleBookingIntent={organizationId:calendar.organizationId,bookingId:prepared.row.id,calendarId:calendar.calendarId,...prepared.window,timeZone:calendar.timeZone,summary:prepared.policy.title,requestDigest:prepared.row.request_digest};
      const receipt=await this.client(calendar,prepared.deadline,signal,()=>admit(true),prepared.row.id).createBooking(intent);
      const result={state:receipt.state,bookingId:prepared.row.id,...prepared.window,...(receipt.state==="confirmed"?{receiptDigest:receipt.receiptDigest}:{})};
      await transaction(this.pool,async db=>{
        await db.query("UPDATE agents_platform.booking_intents SET state=$2,result=$3,provider_result=$4 WHERE id=$1 AND state='claimed'",[prepared.row.id,receipt.state,result,receipt]);
        await db.query("UPDATE agents_platform.booking_slots SET state=$2 WHERE booking_id=$1",[prepared.row.id,receipt.state]);
        await recordEvent(db,taskId,`booking-result:${prepared.row.id}`,"tool.booking_result",{operationId,connectionId:calendar.connectionId,policyRevision:calendar.policyRevision,outcome:receipt.state==="confirmed"?"completed":"uncertain"});
      });
      if(receipt.state==="uncertain")throw new PlatformError("BOOKING_OUTCOME_UNCERTAIN",409,"The appointment outcome is uncertain; it was not submitted again");
      return result;
    }catch(error) {
      await transaction(this.pool,async db=>{
        if(claimed)await db.query("UPDATE agents_platform.booking_intents SET state='uncertain' WHERE id=$1 AND state='claimed'",[prepared.row.id]);
        await db.query(`UPDATE agents_platform.booking_slots s SET state=$2 FROM agents_platform.booking_intents i WHERE s.booking_id=i.id AND s.booking_id=$1 AND s.state='held' AND i.state=$3`,[prepared.row.id,claimed?"uncertain":"released",claimed?"uncertain":"approved"]);
      });
      if(claimed){await this.uncertainHandoff(taskId,operationId);throw new PlatformError("BOOKING_OUTCOME_UNCERTAIN",409,"The appointment outcome is uncertain; it was not submitted again");}
      throw error;
    }
  }
}
