import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { GoogleCalendarClient,type GoogleCalendarOptions,type GoogleCalendarSummary } from "../../adapters/providers/google-calendar";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault } from "../../infrastructure/vault";
import { GOOGLE_CALENDAR_SCOPES,parseGoogleTokens,type GoogleOAuthPort,type GoogleOAuthTokens } from "./google-calendar-oauth";

type Row=Record<string,any>;
export interface GoogleCalendarConnectionDTO {
 id:string;name:string;status:string;account:{subject:string;email:string}|null;calendar:GoogleCalendarSummary|null;
 revision:number;policyRevision:number;generation:number;sharing:"private"|"organization_service";customerDeploymentEligible:boolean;
 readiness:{state:"available"|"unavailable";reasons:{code:string;message:string}[]};
}
export interface ResolvedBookingCalendar {
 connectionId:string;ownerAccountId:string;organizationId:string;calendarId:string;calendarName:string;timeZone:string;
 policyRevision:number;generation:number;accessToken:string;
}
export interface GoogleCalendarStoreOptions {oauth?:GoogleOAuthPort;appUrl:string;testApiBaseUrl?:string}
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const missing=()=>new PlatformError("GOOGLE_CONNECTION_NOT_FOUND",404,"Google Calendar connection not found");
const changed=()=>new PlatformError("CONNECTION_CHANGED",409,"Connection changed; refresh and try again");
const rowQuery=`SELECT c.*,g.status,g.generation,g.sharing,g.account_subject,g.account_email,g.selected_calendar,g.token_expires_at,
 g.granted_scopes,g.refresh_lease,g.refresh_started_at,g.last_error FROM agents_platform.connections c
 JOIN agents_platform.google_calendar_connections g ON g.connection_id=c.id
 WHERE c.organization_id=$1 AND c.account_id=$2 AND c.profile_id='google-calendar-v1'`;
const generationInput=z.strictObject({generation:z.number().int().positive()});
async function owner(db:Pool|PoolClient,scope:ActionScope){await requireActionMember(db,scope);if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"An owner must configure Google Calendar");}
export class GoogleCalendarConnectionStore {
 constructor(readonly pool:Pool,readonly vault:ConnectionVault|undefined,readonly options:GoogleCalendarStoreOptions) {}
 providerStatus(){const available=!!this.vault&&!!this.options.oauth;return {provider:"google-calendar",available,reasons:available?[]:[{code:"GOOGLE_OAUTH_NOT_CONFIGURED",message:"Google Calendar is unavailable until the server OAuth client and encrypted credential storage are configured"}]};}
 private requireProvider(){if(!this.providerStatus().available)throw new PlatformError("GOOGLE_OAUTH_NOT_CONFIGURED",503,"Google Calendar OAuth is not configured");return this.options.oauth!;}
 private async row(db:Pool|PoolClient,scope:ActionScope,id:string,lock=false){z.uuid().parse(id);await owner(db,scope);const row=(await db.query(rowQuery+" AND c.id=$3"+(lock?" FOR UPDATE OF c,g":" FOR SHARE OF c,g"),[scope.organizationId,scope.accountId,id])).rows[0];if(!row)throw missing();return row;}
 private dto(row:Row):GoogleCalendarConnectionDTO {
   const ready=this.providerStatus().available&&row.state==="active"&&new Date(row.expires_at).getTime()>Date.now()&&row.status==="ready"&&!!row.selected_calendar&&!!row.account_subject&&GOOGLE_CALENDAR_SCOPES.every(scope=>row.granted_scopes.includes(scope));
   const reasons=!this.providerStatus().available?this.providerStatus().reasons:ready?[]:[{code:row.state==="revoked"?"GOOGLE_DISCONNECTED":row.status==="reconnect_required"?"GOOGLE_RECONNECT_REQUIRED":row.selected_calendar?"GOOGLE_AUTHORIZATION_REQUIRED":"GOOGLE_CALENDAR_SELECTION_REQUIRED",message:row.status==="reconnect_required"?"Reconnect Google Calendar":row.selected_calendar?"Authorize Google Calendar":"Select a calendar"}];
   return {id:row.id,name:row.name,status:row.state==="revoked"?"disconnected":row.status,account:row.account_subject?{subject:row.account_subject,email:row.account_email}:null,calendar:row.selected_calendar,revision:row.revision,policyRevision:row.policy_revision,generation:row.generation,sharing:row.sharing,customerDeploymentEligible:ready&&row.sharing==="organization_service",readiness:{state:ready?"available":"unavailable",reasons}};
 }
 async list(scope:ActionScope){await owner(this.pool,scope);return (await this.pool.query(rowQuery+" ORDER BY c.created_at DESC LIMIT 100",[scope.organizationId,scope.accountId])).rows.map(row=>this.dto(row));}
 async get(scope:ActionScope,id:string){return this.dto(await this.row(this.pool,scope,id));}
 async create(scope:ActionScope,raw:unknown){this.requireProvider();const input=z.strictObject({name:z.string().trim().min(1).max(120)}).parse(raw);
   return transaction(this.pool,async db=>{await owner(db,scope);const id=randomUUID();await db.query("INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,profile_id,expires_at,resource_handles) VALUES($1,$2,$3,$4,'provider:google-calendar','https://www.googleapis.com/calendar/v3','google-calendar-v1',now()+interval '90 days','[]')",[id,scope.organizationId,scope.accountId,input.name]);await db.query("INSERT INTO agents_platform.google_calendar_connections(connection_id,organization_id) VALUES($1,$2)",[id,scope.organizationId]);return this.dto(await this.row(db,scope,id));});
 }
 async authorize(scope:ActionScope,id:string){const oauth=this.requireProvider();await this.row(this.pool,scope,id);const attempt=await oauth.begin();
   return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.state!=="active")throw changed();const attemptId=randomUUID();
     await db.query("DELETE FROM agents_platform.google_calendar_oauth_attempts WHERE expires_at<now()-interval '1 day'");
     await db.query("UPDATE agents_platform.google_calendar_oauth_attempts SET consumed_at=now() WHERE connection_id=$1 AND consumed_at IS NULL",[id]);
     await db.query("INSERT INTO agents_platform.google_calendar_oauth_attempts(id,connection_id,organization_id,account_id,state_hash,envelope,generation) VALUES($1,$2,$3,$4,$5,$6,$7)",[attemptId,id,scope.organizationId,scope.accountId,hash(attempt.state),JSON.stringify(this.vault!.seal(scope.organizationId,attemptId,1,JSON.stringify({state:attempt.state,nonce:attempt.nonce,verifier:attempt.verifier}))),row.generation]);return {authorizationUrl:attempt.authorizationUrl};});
 }
 async complete(accountId:string,query:string):Promise<{organizationId:string;connectionId:string;redirectTo:string}>{
   const oauth=this.requireProvider(),params=new URLSearchParams(query.replace(/^\?/,"")),state=z.string().min(32).max(512).parse(params.get("state"));z.uuid().parse(accountId);
   // Consume before token exchange. The callback must retain the same authenticated browser account.
   const attempt=await transaction(this.pool,async db=>{const candidate=(await db.query("SELECT * FROM agents_platform.google_calendar_oauth_attempts WHERE state_hash=$1 AND account_id=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",[hash(state),accountId])).rows[0];if(!candidate)throw new PlatformError("GOOGLE_OAUTH_EXPIRED",400,"Google authorization expired");const scope={organizationId:candidate.organization_id,accountId};const row=await this.row(db,scope,candidate.connection_id,true);if(row.state!=="active"||row.generation!==candidate.generation)throw changed();await db.query("UPDATE agents_platform.google_calendar_oauth_attempts SET consumed_at=now() WHERE id=$1",[candidate.id]);return candidate;});
   const secret=JSON.parse(this.vault!.open(attempt.organization_id,attempt.id,1,attempt.envelope));const tokens=await oauth.complete(query,secret);parseGoogleTokens(tokens);
   await transaction(this.pool,async db=>{const scope={organizationId:attempt.organization_id,accountId},row=await this.row(db,scope,attempt.connection_id,true);if(row.generation!==attempt.generation||row.state!=="active")throw changed();const revision=row.revision+1;
     await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)",[row.id,revision,JSON.stringify(this.vault!.seal(scope.organizationId,row.id,revision,JSON.stringify(tokens),65536))]);
     // Every new OAuth grant clears service sharing/calendar, even when the same account reconnects.
     await db.query("UPDATE agents_platform.connections SET revision=$2,policy_revision=policy_revision+1,expires_at=now()+interval '90 days' WHERE id=$1",[row.id,revision]);
     await db.query("UPDATE agents_platform.google_calendar_connections SET status='calendar_required',generation=generation+1,sharing='private',selected_calendar=NULL,account_subject=$2,account_email=$3,token_expires_at=$4,granted_scopes=$5,refresh_lease=NULL,refresh_started_at=NULL,last_error=NULL WHERE connection_id=$1",[row.id,tokens.subject,tokens.email,tokens.expiresAt,tokens.scopes]);});
   const redirect=new URL("/app/connections",this.options.appUrl);redirect.searchParams.set("profile","google-calendar-v1");redirect.searchParams.set("setup",attempt.connection_id);redirect.searchParams.set("setupStatus","connected");return {organizationId:attempt.organization_id,connectionId:attempt.connection_id,redirectTo:redirect.href};
 }
 private async tokens(db:Pool|PoolClient,scope:ActionScope,row:Row):Promise<GoogleOAuthTokens>{this.requireProvider();const stored=(await db.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1 AND revision=$2",[row.id,row.revision])).rows[0];if(!stored?.envelope)throw new PlatformError("GOOGLE_RECONNECT_REQUIRED",401,"Reconnect Google Calendar");return parseGoogleTokens(JSON.parse(this.vault!.open(scope.organizationId,row.id,row.revision,stored.envelope)));}
 async ensureCredentialFresh(scope:ActionScope,id:string):Promise<void>{
   const oauth=this.requireProvider();const acquired=await transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.state!=="active"||!row.account_subject||["disconnected","reconnect_required"].includes(row.status))throw changed();if(new Date(row.expires_at).getTime()<=Date.now())throw changed();
     if(new Date(row.token_expires_at).getTime()>Date.now()+60000)return null;
     if(row.refresh_lease){if(new Date(row.refresh_started_at).getTime()>Date.now()-60000)throw new PlatformError("GOOGLE_REFRESH_IN_PROGRESS",409,"Google credentials are refreshing");
       await db.query("UPDATE agents_platform.google_calendar_connections SET status='reconnect_required',last_error='GOOGLE_REFRESH_UNCERTAIN' WHERE connection_id=$1",[id]);return {uncertain:true as const};}
     const lease=randomUUID(),tokens=await this.tokens(db,scope,row);await db.query("UPDATE agents_platform.google_calendar_connections SET refresh_lease=$2,refresh_started_at=now() WHERE connection_id=$1",[id,lease]);return {uncertain:false as const,row,lease,tokens};});
   if(!acquired)return;if(acquired.uncertain)throw new PlatformError("GOOGLE_RECONNECT_REQUIRED",401,"Reconnect Google Calendar");
   let tokens:GoogleOAuthTokens;try{tokens=await oauth.refresh(acquired.tokens.refreshToken,acquired.tokens);}catch(error){await this.pool.query("UPDATE agents_platform.google_calendar_connections SET status='reconnect_required',last_error='GOOGLE_REFRESH_FAILED',refresh_lease=NULL,refresh_started_at=NULL WHERE connection_id=$1 AND refresh_lease=$2",[id,acquired.lease]);throw error;}
   await transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.refresh_lease!==acquired.lease||row.revision!==acquired.row.revision||row.policy_revision!==acquired.row.policy_revision||row.state!=="active")throw changed();const revision=row.revision+1;
     if(tokens.subject!==row.account_subject||tokens.email!==row.account_email)throw new PlatformError("GOOGLE_ACCOUNT_CHANGED",409,"Reconnect Google Calendar to change accounts");
     await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)",[id,revision,JSON.stringify(this.vault!.seal(scope.organizationId,id,revision,JSON.stringify(tokens),65536))]);await db.query("UPDATE agents_platform.connections SET revision=$2 WHERE id=$1",[id,revision]);await db.query("UPDATE agents_platform.google_calendar_connections SET token_expires_at=$2,granted_scopes=$3,refresh_lease=NULL,refresh_started_at=NULL,last_error=NULL WHERE connection_id=$1",[id,tokens.expiresAt,tokens.scopes]);});
 }
 private async client(scope:ActionScope,id:string):Promise<GoogleCalendarClient>{await this.ensureCredentialFresh(scope,id);const row=await this.row(this.pool,scope,id),tokens=await this.tokens(this.pool,scope,row);const options:GoogleCalendarOptions={deadlineAt:Date.now()+15000,testBaseUrl:this.options.testApiBaseUrl,beforeAttempt:async()=>{const current=await this.row(this.pool,scope,id);if(current.state!=="active"||current.revision!==row.revision||current.policy_revision!==row.policy_revision||current.generation!==row.generation)throw changed();}};return new GoogleCalendarClient(tokens.accessToken,options);}
 async calendars(scope:ActionScope,id:string){return (await this.client(scope,id)).listCalendars();}
 async selectCalendar(scope:ActionScope,id:string,raw:unknown){const input=generationInput.extend({calendarId:z.string().min(1).max(1024)}).parse(raw),initial=await this.row(this.pool,scope,id);if(initial.generation!==input.generation)throw changed();const items=await this.calendars(scope,id),selected=items.items.find(item=>item.id===input.calendarId);if(!selected)throw new PlatformError("GOOGLE_CALENDAR_NOT_WRITABLE",400,"Select a writable calendar");
   return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.generation!==input.generation||row.state!=="active"||row.policy_revision!==initial.policy_revision)throw changed();await db.query("UPDATE agents_platform.connections SET policy_revision=policy_revision+1 WHERE id=$1",[id]);await db.query("UPDATE agents_platform.google_calendar_connections SET selected_calendar=$2,status='ready',sharing='private',generation=generation+1 WHERE connection_id=$1",[id,JSON.stringify(selected)]);return this.dto(await this.row(db,scope,id));});
 }
 async sharing(scope:ActionScope,id:string,raw:unknown){const input=generationInput.extend({sharing:z.enum(["private","organization_service"])}).parse(raw);this.requireProvider();return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.generation!==input.generation||row.state!=="active"||row.status!=="ready"||!row.selected_calendar)throw changed();await db.query("UPDATE agents_platform.connections SET policy_revision=policy_revision+1 WHERE id=$1",[id]);await db.query("UPDATE agents_platform.google_calendar_connections SET sharing=$2,generation=generation+1 WHERE connection_id=$1",[id,input.sharing]);return this.dto(await this.row(db,scope,id));});}
 async disconnect(scope:ActionScope,id:string,raw:unknown){const input=generationInput.parse(raw);return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.generation!==input.generation)throw changed();await db.query("UPDATE agents_platform.connections SET state='revoked',policy_revision=policy_revision+1 WHERE id=$1",[id]);await db.query("UPDATE agents_platform.google_calendar_connections SET status='disconnected',sharing='private',generation=generation+1,refresh_lease=NULL,refresh_started_at=NULL WHERE connection_id=$1",[id]);await db.query("UPDATE agents_platform.google_calendar_oauth_attempts SET consumed_at=now() WHERE connection_id=$1 AND consumed_at IS NULL",[id]);return this.dto(await this.row(db,scope,id));});}
 async resolveBookingCalendar(db:PoolClient,scope:ActionScope,id:string,policyRevision:number,options:{requireOrganizationService?:boolean}={}):Promise<ResolvedBookingCalendar>{
   const row=await this.row(db,scope,id);if(row.state!=="active"||row.policy_revision!==policyRevision||row.status!=="ready"||!row.selected_calendar||new Date(row.expires_at).getTime()<=Date.now()||!GOOGLE_CALENDAR_SCOPES.every(item=>row.granted_scopes.includes(item))||options.requireOrganizationService&&row.sharing!=="organization_service")throw new PlatformError("GOOGLE_AUTHORITY_CHANGED",409,"Google Calendar authority changed");
   if(new Date(row.token_expires_at).getTime()<=Date.now()+5000)throw new PlatformError("GOOGLE_REFRESH_REQUIRED",401,"Google credentials need refreshing");const tokens=await this.tokens(db,scope,row);
   if(tokens.subject!==row.account_subject||tokens.email!==row.account_email||Date.parse(tokens.expiresAt)<=Date.now()+5000||!GOOGLE_CALENDAR_SCOPES.every(scope=>tokens.scopes.includes(scope)))throw new PlatformError("GOOGLE_CREDENTIAL_MISMATCH",409,"Google credentials no longer match selected authority");
   return {connectionId:id,ownerAccountId:scope.accountId,organizationId:scope.organizationId,calendarId:row.selected_calendar.id,calendarName:row.selected_calendar.name,timeZone:row.selected_calendar.timeZone,policyRevision:row.policy_revision,generation:row.generation,accessToken:tokens.accessToken};
 }
}
