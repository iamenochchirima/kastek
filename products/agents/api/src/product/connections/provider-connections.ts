import { observeConnectionControl,captureConnectionAuthority } from "../../observability/connection-telemetry";
import {connectorExecutionDigest,type NativeConnectorConfiguration} from "../../adapters/providers/connector-registry";
import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { calendarClient } from "../../adapters/providers/calendar-client";
import type { CalendarSummary } from "../../adapters/providers/calendar-contracts";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault } from "../../infrastructure/vault";
import {providerScopes,parseProviderTokens,type ProviderOAuthPort,type ProviderOAuthTokens} from "./provider-oauth";
import type { ConnectionDTO,ConnectionProfile } from "../../contracts/connections";
import { createNativeProviderCatalog,nativeProviderBindings } from "../../capabilities/connected-tools/native-provider-tools";

type Row=Record<string,any>;
export interface ProviderConnectionDTO {
 id:string;providerId:string;operations:string[];bindingIds:string[];name:string;status:string;account:{subject:string;email:string}|null;calendar:CalendarSummary|null;
 authorizationVerifiedAt:string|null;credentialExpiresAt:string|null;grantedScopes:string[];
 revision:number;policyRevision:number;generation:number;sharing:"private"|"organization_service";customerDeploymentEligible:boolean;
 readiness:{state:"available"|"unavailable";reasons:{code:string;message:string}[]};
}
export interface ResolvedBookingCalendar {
 providerId:string;connectionId:string;ownerAccountId:string;organizationId:string;calendarId:string;calendarName:string;timeZone:string;
 policyRevision:number;generation:number;accessToken:string;
}
export interface ProviderStoreOptions {definition:NativeConnectorConfiguration;oauth?:ProviderOAuthPort;appUrl:string;testApiBaseUrl?:string}
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const missing=()=>new PlatformError("PROVIDER_CONNECTION_NOT_FOUND",404,"Provider account connection not found");
const changed=()=>new PlatformError("CONNECTION_CHANGED",409,"Connection changed; refresh and try again");
const rowQuery=`SELECT c.*,g.provider_id,g.status,g.generation,g.sharing,g.account_subject,g.account_email,g.selected_calendar,g.token_expires_at,
 g.connector_digest,g.granted_scopes,g.refresh_lease,g.refresh_started_at,g.last_error,g.selected_operations,g.binding_ids,g.current_oauth_attempt_id,g.last_verified_at FROM agents_platform.connections c
 JOIN agents_platform.native_provider_connections g ON g.connection_id=c.id
 WHERE c.organization_id=$1 AND c.account_id=$2`;
const generationInput=z.strictObject({generation:z.number().int().positive()});
async function owner(db:Pool|PoolClient,scope:ActionScope){await requireActionMember(db,scope);if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"An owner must configure provider accounts");}
export class ProviderConnectionStore {
 constructor(readonly pool:Pool,readonly vault:ConnectionVault|undefined,readonly options:ProviderStoreOptions) {}
 get definition(){return this.options.definition;}
 private scopes(row:Row){return providerScopes(this.definition,row.selected_operations);}
 private definitionDigest(){return requestDigest({connector:connectorExecutionDigest(this.definition),client:this.options.oauth?.configurationDigest??null});}
 private assertDefinition(row:Row){if(row.connector_digest!==this.definitionDigest())throw new PlatformError("PROVIDER_CONFIGURATION_CHANGED",409,"Provider connector configuration changed; authorize the account again");}
 providerStatus(){const available=!!this.vault&&!!this.options.oauth;return {provider:this.definition.id,available,reasons:available?[]:[{code:"PROVIDER_OAUTH_NOT_CONFIGURED",message:"Provider account is unavailable until the server OAuth client and encrypted credential storage are configured"}]};}
 private requireProvider(){if(!this.providerStatus().available)throw new PlatformError("PROVIDER_OAUTH_NOT_CONFIGURED",503,"Provider account OAuth is not configured");return this.options.oauth!;}
 private async row(db:Pool|PoolClient,scope:ActionScope,id:string,lock=false){z.uuid().parse(id);await owner(db,scope);const row=(await db.query(rowQuery+" AND c.id=$3 AND c.profile_id=$4 AND g.provider_id=$5"+(lock?" FOR UPDATE OF c,g":" FOR SHARE OF c,g"),[scope.organizationId,scope.accountId,id,this.definition.profileId,this.definition.id])).rows[0];if(!row)throw missing();captureConnectionAuthority(row);return row;}
 private dto(row:Row):ProviderConnectionDTO {
   captureConnectionAuthority(row);
   const definitionCurrent=row.connector_digest===this.definitionDigest(),calendar=this.definition.setup?.kind==="calendar_service";
   const authorizationExpired=new Date(row.expires_at).getTime()<=Date.now();
   const permissions=this.scopes(row).every(scope=>row.granted_scopes.includes(scope));
   const ready=definitionCurrent&&this.providerStatus().available&&row.state==="active"&&new Date(row.expires_at).getTime()>Date.now()&&row.status==="ready"&&(!calendar||!!row.selected_calendar)&&!!row.account_subject&&permissions;
   let reasons:{code:string;message:string}[]=[];
   if(!definitionCurrent)reasons=[{code:"PROVIDER_CONFIGURATION_CHANGED",message:"Provider configuration changed. Reconnect the account."}];
   else if(!this.providerStatus().available)reasons=this.providerStatus().reasons;
   else if(!ready){
     const code=row.state==="revoked"?"PROVIDER_DISCONNECTED":row.status==="reconnect_required"||authorizationExpired?"PROVIDER_RECONNECT_REQUIRED":!row.account_subject||!permissions?"PROVIDER_AUTHORIZATION_REQUIRED":calendar?"PROVIDER_CALENDAR_SELECTION_REQUIRED":"PROVIDER_ACTION_SELECTION_REQUIRED";
     reasons=[{code,message:code==="PROVIDER_DISCONNECTED"?"Account disconnected":code==="PROVIDER_RECONNECT_REQUIRED"||code==="PROVIDER_AUTHORIZATION_REQUIRED"?"Reconnect the account":calendar?"Choose a calendar":"Choose permitted actions"}];
   }
   return {id:row.id,providerId:this.definition.id,operations:row.selected_operations,bindingIds:row.binding_ids,name:row.name,status:row.state==="revoked"?"disconnected":!definitionCurrent||authorizationExpired?"reconnect_required":row.status,account:row.account_subject?{subject:row.account_subject,email:row.account_email}:null,calendar:row.selected_calendar,authorizationVerifiedAt:row.last_verified_at?new Date(row.last_verified_at).toISOString():null,credentialExpiresAt:row.token_expires_at?new Date(row.token_expires_at).toISOString():null,grantedScopes:[...row.granted_scopes],revision:row.revision,policyRevision:row.policy_revision,generation:row.generation,sharing:row.sharing,customerDeploymentEligible:ready&&row.sharing==="organization_service"&&(calendar?row.selected_operations.some((operation:string)=>["calendar.availability","calendar.book"].includes(operation)):row.selected_operations.includes("contacts.create")),readiness:{state:ready?"available":"unavailable",reasons}};
 }
 async list(scope:ActionScope){await owner(this.pool,scope);return (await this.pool.query(rowQuery+" AND c.profile_id=$3 AND g.provider_id=$4 ORDER BY c.created_at DESC LIMIT 100",[scope.organizationId,scope.accountId,this.definition.profileId,this.definition.id])).rows.map(row=>this.dto(row));}
 async get(scope:ActionScope,id:string){return this.dto(await this.row(this.pool,scope,id));}
 async catalogueConnections(scope:ActionScope):Promise<ConnectionDTO[]>{await owner(this.pool,scope);return (await this.pool.query(rowQuery+" AND c.profile_id=$3 AND g.provider_id=$4 ORDER BY c.created_at DESC LIMIT 100",[scope.organizationId,scope.accountId,this.definition.profileId,this.definition.id])).rows.map(row=>this.connectionDTO(row));}
 private connectionDTO(row:Row):ConnectionDTO {const dto=this.dto(row);return {id:row.id,name:row.name,targetId:row.target_id,targetLabel:this.definition.name,resource:row.resource,profileId:this.definition.profileId as ConnectionProfile,authentication:"bearer",policyRevision:row.policy_revision,resources:row.resource_handles,selections:[],stashItemIds:[],revision:row.revision,state:(this.definition.setup?.kind==="calendar_service"?dto.customerDeploymentEligible:dto.readiness.state==="available")?"active":"revoked",createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};}
 async operationChoices(scope:ActionScope,id:string){const row=await this.row(this.pool,scope,id);return {generation:row.generation,operations:this.definition.operations.map(operation=>({...operation,selected:row.selected_operations.includes(operation.id)}))};}
 async selectOperations(scope:ActionScope,id:string,raw:unknown){return observeConnectionControl(this.pool,"native_provider","select",{organizationId:scope.organizationId,connectionId:id},async()=>{
   const input=generationInput.extend({operationIds:z.array(z.string()).min(1).max(8)}).parse(raw),scopes=providerScopes(this.definition,input.operationIds);
   this.requireProvider();
   return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);this.assertDefinition(row);if(row.generation!==input.generation||row.state!=="active"||!row.account_subject)throw changed();
     const policyRevision=row.policy_revision+1,authorized=scopes.every(scope=>row.granted_scopes.includes(scope));
     await db.query("UPDATE agents_platform.connections SET policy_revision=$2,resource_handles=$3 WHERE id=$1",[id,policyRevision,JSON.stringify(authorized?[{kind:"provider.account",id:row.account_subject}]:[])]);
     let bindingIds:string[]=[];
     if(authorized&&this.definition.setup?.kind==="crm_service"){
       bindingIds=await this.installBindings(db,scope,row,policyRevision,input.operationIds);
     }
     await db.query("UPDATE agents_platform.native_provider_connections SET selected_operations=$2,binding_ids=$3,generation=generation+1,status=$4,sharing='private',selected_calendar=CASE WHEN $4='ready' THEN selected_calendar ELSE NULL END WHERE connection_id=$1",[id,input.operationIds,bindingIds,!authorized?"authorization_required":this.definition.setup?.kind==="calendar_service"?"calendar_required":"ready"]);
     return this.dto(await this.row(db,scope,id));
   });
 });}
 private async installBindings(db:PoolClient,scope:ActionScope,row:Row,policyRevision:number,operationIds:string[]):Promise<string[]> {
   const revision=Number((await db.query("SELECT coalesce(max(revision),0)+1 AS next FROM agents_platform.capability_catalogs WHERE connection_id=$1",[row.id])).rows[0].next);
   const catalog=createNativeProviderCatalog(this.definition,{id:randomUUID(),organizationId:scope.organizationId,connectionId:row.id,revision});
   await db.query("INSERT INTO agents_platform.capability_catalogs(id,organization_id,connection_id,account_id,revision,credential_revision,policy_revision,digest,catalog) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[catalog.id,scope.organizationId,row.id,scope.accountId,revision,row.revision,policyRevision,catalog.digest,JSON.stringify(catalog)]);
   const bindings=nativeProviderBindings(catalog,{policyRevision,resource:{kind:"provider.account",id:row.account_subject}}).filter(binding=>operationIds.includes(binding.definition.providerOperation));
   for(const binding of bindings)await db.query("INSERT INTO agents_platform.capability_bindings(id,organization_id,connection_id,catalog_id,account_id,alias,digest,binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[binding.id,scope.organizationId,row.id,catalog.id,scope.accountId,binding.alias,binding.digest,JSON.stringify(binding)]);
   return bindings.map(binding=>binding.id);
 }
 async resolveCredential(db:PoolClient,scope:ActionScope,id:string,policyRevision:number){
   const row=await this.row(db,scope,id);this.assertDefinition(row);
   if(this.definition.setup?.kind!=="crm_service"||row.state!=="active"||row.status!=="ready"||row.policy_revision!==policyRevision||new Date(row.expires_at).getTime()<=Date.now()||new Date(row.token_expires_at).getTime()<=Date.now()+5000||!this.scopes(row).every(scope=>row.granted_scopes.includes(scope)))throw new PlatformError("PROVIDER_AUTHORITY_CHANGED",403,"Provider account authority changed");
   const tokens=await this.tokens(db,scope,row);if(tokens.subject!==row.account_subject||Date.parse(tokens.expiresAt)<=Date.now()+5000||!this.scopes(row).every(scope=>tokens.scopes.includes(scope)))throw new PlatformError("PROVIDER_CREDENTIAL_MISMATCH",403,"Provider credentials no longer match selected authority");
   return {connection:this.connectionDTO(row),authorization:tokens.accessToken};
 }
 async create(scope:ActionScope,raw:unknown){return observeConnectionControl(this.pool,"native_provider","connect",{organizationId:scope.organizationId},async()=>{this.requireProvider();const input=z.strictObject({name:z.string().trim().min(1).max(120),operationId:z.string().min(1).max(128).optional(),operations:z.array(z.string()).min(1).max(8).optional()}).parse(raw);
   const operations=input.operations??this.definition.operations.filter(operation=>operation.effect==="read").map(operation=>operation.id);providerScopes(this.definition,operations);
   return transaction(this.pool,async db=>{await owner(db,scope);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
     const digest=requestDigest({provider:this.definition.id,name:input.name,operations});
     if(input.operationId){const prior=(await db.query("SELECT request_digest,result FROM agents_platform.connection_mutations WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3",[scope.organizationId,scope.accountId,input.operationId])).rows[0];if(prior){if(prior.request_digest!==digest)throw changed();return this.dto(await this.row(db,scope,prior.result.id));}}
     const id=randomUUID();await db.query("INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,profile_id,expires_at,resource_handles) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '90 days','[]')",[id,scope.organizationId,scope.accountId,input.name,`provider:${this.definition.id}`,this.definition.apiBaseUrl,this.definition.profileId]);
     await db.query("INSERT INTO agents_platform.native_provider_connections(connection_id,organization_id,connector_digest,provider_id,selected_operations) VALUES($1,$2,$3,$4,$5)",[id,scope.organizationId,this.definitionDigest(),this.definition.id,operations]);
     const result=this.dto(await this.row(db,scope,id));if(input.operationId)await db.query("INSERT INTO agents_platform.connection_mutations(organization_id,account_id,operation_id,request_digest,connection_id,result) VALUES($1,$2,$3,$4,$5,$6)",[scope.organizationId,scope.accountId,input.operationId,digest,id,result]);return result;});

});}
 async authorize(scope:ActionScope,id:string,raw:unknown={}){const input=z.strictObject({returnTo:z.string().max(2048).refine(value=>{try{const parsed=new URL(value,"https://agents.invalid");return value.startsWith("/app/agents/")&&!/[\\\r\n#]/.test(value)&&parsed.origin==="https://agents.invalid"&&/^\/app\/agents\/[0-9a-f-]{36}(?:\/|$)/.test(parsed.pathname);}catch{return false;}},"Invalid agent return destination").optional()}).parse(raw);return observeConnectionControl(this.pool,"native_provider","authorize",{organizationId:scope.organizationId,connectionId:id},async()=>{const oauth=this.requireProvider(),initial=await this.row(this.pool,scope,id),scopes=this.scopes(initial),attempt=await oauth.begin(scopes);
   return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.generation!==initial.generation)throw changed();const attemptId=randomUUID();
     await db.query("DELETE FROM agents_platform.native_provider_oauth_attempts WHERE expires_at<now()-interval '1 day'");
     await db.query("UPDATE agents_platform.native_provider_oauth_attempts SET consumed_at=now() WHERE connection_id=$1 AND consumed_at IS NULL",[id]);
     await db.query("INSERT INTO agents_platform.native_provider_oauth_attempts(id,connection_id,organization_id,account_id,state_hash,envelope,generation,connector_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[attemptId,id,scope.organizationId,scope.accountId,hash(attempt.state),JSON.stringify(this.vault!.seal(scope.organizationId,attemptId,1,JSON.stringify({state:attempt.state,nonce:attempt.nonce,verifier:attempt.verifier,scopes,returnTo:input.returnTo}))),row.generation,this.definitionDigest()]);
     await db.query("UPDATE agents_platform.native_provider_connections SET current_oauth_attempt_id=$2 WHERE connection_id=$1",[id,attemptId]);return {authorizationUrl:attempt.authorizationUrl};});

});}
 async complete(accountId:string,query:string):Promise<{organizationId:string;connectionId:string;redirectTo:string}>{return observeConnectionControl(this.pool,"native_provider","callback",{},async()=>{
   const oauth=this.requireProvider(),params=new URLSearchParams(query.replace(/^\?/,"")),state=z.string().min(32).max(512).parse(params.get("state"));z.uuid().parse(accountId);
   // Consume before token exchange. The callback must retain the same authenticated browser account.
   const attempt=await transaction(this.pool,async db=>{const candidate=(await db.query("SELECT * FROM agents_platform.native_provider_oauth_attempts WHERE state_hash=$1 AND account_id=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",[hash(state),accountId])).rows[0];if(!candidate)throw new PlatformError("PROVIDER_OAUTH_EXPIRED",400,"Provider authorization expired");this.assertDefinition(candidate);const scope={organizationId:candidate.organization_id,accountId};const row=await this.row(db,scope,candidate.connection_id,true);if(row.generation!==candidate.generation||row.current_oauth_attempt_id!==candidate.id)throw changed();await db.query("UPDATE agents_platform.native_provider_oauth_attempts SET consumed_at=now() WHERE id=$1",[candidate.id]);return candidate;});
   const secret=JSON.parse(this.vault!.open(attempt.organization_id,attempt.id,1,attempt.envelope));const tokens=await oauth.complete(query,secret);parseProviderTokens(tokens);
   await transaction(this.pool,async db=>{const scope={organizationId:attempt.organization_id,accountId},row=await this.row(db,scope,attempt.connection_id,true);if(row.generation!==attempt.generation||row.current_oauth_attempt_id!==attempt.id||!this.scopes(row).every(scope=>tokens.scopes.includes(scope)))throw changed();const revision=row.revision+1;
     await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)",[row.id,revision,JSON.stringify(this.vault!.seal(scope.organizationId,row.id,revision,JSON.stringify(tokens),65536))]);
     // Every new OAuth grant clears service sharing/calendar, even when the same account reconnects.
     const updatedAuthorization=(await db.query("UPDATE agents_platform.connections SET revision=$2,state='active',policy_revision=policy_revision+1,expires_at=now()+interval '90 days' WHERE id=$1 RETURNING id,organization_id,policy_revision",[row.id,revision])).rows[0];
     const settings=(await db.query("UPDATE agents_platform.native_provider_connections SET status=$7,last_verified_at=clock_timestamp(),generation=generation+1,sharing='private',selected_calendar=NULL,binding_ids='{}',current_oauth_attempt_id=NULL,account_subject=$2,account_email=$3,token_expires_at=$4,granted_scopes=$5,refresh_lease=NULL,refresh_started_at=NULL,last_error=NULL,connector_digest=$6 WHERE connection_id=$1 RETURNING generation",[row.id,tokens.subject,tokens.email,tokens.expiresAt,tokens.scopes,this.definitionDigest(),this.definition.setup?.kind==="calendar_service"?"calendar_required":"selection_required"])).rows[0];captureConnectionAuthority({...updatedAuthorization,generation:settings.generation});});
   const redirect=new URL("/app/connections",this.options.appUrl);redirect.searchParams.set("connector",this.definition.id);redirect.searchParams.set("profile",this.definition.profileId);redirect.searchParams.set("setup",attempt.connection_id);redirect.searchParams.set("setupStatus","connected");if(secret.returnTo)redirect.searchParams.set("returnTo",secret.returnTo);return {organizationId:attempt.organization_id,connectionId:attempt.connection_id,redirectTo:redirect.href};

});}
 private async tokens(db:Pool|PoolClient,scope:ActionScope,row:Row):Promise<ProviderOAuthTokens>{this.requireProvider();this.assertDefinition(row);const stored=(await db.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1 AND revision=$2",[row.id,row.revision])).rows[0];if(!stored?.envelope)throw new PlatformError("PROVIDER_RECONNECT_REQUIRED",401,"Reconnect Provider account");return parseProviderTokens(JSON.parse(this.vault!.open(scope.organizationId,row.id,row.revision,stored.envelope)));}
 async ensureCredentialFresh(scope:ActionScope,id:string):Promise<void>{return observeConnectionControl(this.pool,"native_provider","credential_check",{organizationId:scope.organizationId,connectionId:id},async()=>{
   const oauth=this.requireProvider();const acquired=await transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);this.assertDefinition(row);if(row.state!=="active"||!row.account_subject||["disconnected","reconnect_required"].includes(row.status))throw changed();if(new Date(row.expires_at).getTime()<=Date.now())throw changed();
     if(new Date(row.token_expires_at).getTime()>Date.now()+60000)return null;
     if(row.refresh_lease){if(new Date(row.refresh_started_at).getTime()>Date.now()-60000)throw new PlatformError("PROVIDER_REFRESH_IN_PROGRESS",409,"Provider credentials are refreshing");
       await db.query("UPDATE agents_platform.native_provider_connections SET status='reconnect_required',last_error='PROVIDER_REFRESH_UNCERTAIN' WHERE connection_id=$1",[id]);return {uncertain:true as const};}
     const lease=randomUUID(),tokens=await this.tokens(db,scope,row);await db.query("UPDATE agents_platform.native_provider_connections SET refresh_lease=$2,refresh_started_at=now() WHERE connection_id=$1",[id,lease]);return {uncertain:false as const,row,lease,tokens};});
   if(!acquired)return;if(acquired.uncertain)throw new PlatformError("PROVIDER_RECONNECT_REQUIRED",401,"Reconnect Provider account");
   let tokens:ProviderOAuthTokens;try{tokens=parseProviderTokens(await observeConnectionControl(this.pool,"native_provider","refresh",{organizationId:scope.organizationId,connectionId:id,authorizationGeneration:acquired.row.generation,policyRevision:acquired.row.policy_revision},()=>oauth.refresh(acquired.tokens.refreshToken,acquired.tokens)));if(tokens.subject!==acquired.row.account_subject||tokens.email!==acquired.row.account_email||!this.scopes(acquired.row).every(scope=>tokens.scopes.includes(scope)))throw new PlatformError("PROVIDER_ACCOUNT_CHANGED",409,"Reconnect the provider account");}catch(error){await this.pool.query("UPDATE agents_platform.native_provider_connections SET status='reconnect_required',last_error='PROVIDER_REFRESH_FAILED',refresh_lease=NULL,refresh_started_at=NULL WHERE connection_id=$1 AND refresh_lease=$2",[id,acquired.lease]);throw error;}
   await transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);this.assertDefinition(row);if(row.refresh_lease!==acquired.lease||row.revision!==acquired.row.revision||row.policy_revision!==acquired.row.policy_revision||row.state!=="active")throw changed();const revision=row.revision+1;
     if(tokens.subject!==row.account_subject||tokens.email!==row.account_email)throw new PlatformError("PROVIDER_ACCOUNT_CHANGED",409,"Reconnect Provider account to change accounts");
     await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)",[id,revision,JSON.stringify(this.vault!.seal(scope.organizationId,id,revision,JSON.stringify(tokens),65536))]);await db.query("UPDATE agents_platform.connections SET revision=$2 WHERE id=$1",[id,revision]);await db.query("UPDATE agents_platform.native_provider_connections SET token_expires_at=$2,granted_scopes=$3,last_verified_at=clock_timestamp(),refresh_lease=NULL,refresh_started_at=NULL,last_error=NULL WHERE connection_id=$1",[id,tokens.expiresAt,tokens.scopes]);});

});}
 private async client(scope:ActionScope,id:string){await this.ensureCredentialFresh(scope,id);const row=await this.row(this.pool,scope,id),tokens=await this.tokens(this.pool,scope,row);return calendarClient(this.definition.id,tokens.accessToken,{deadlineAt:Date.now()+15000,testBaseUrl:this.options.testApiBaseUrl,beforeAttempt:async()=>{const current=await this.row(this.pool,scope,id);this.assertDefinition(current);if(current.state!=="active"||current.revision!==row.revision||current.policy_revision!==row.policy_revision||current.generation!==row.generation)throw changed();}});}
 async calendars(scope:ActionScope,id:string){return observeConnectionControl(this.pool,"native_provider","discover",{organizationId:scope.organizationId,connectionId:id},async()=>{return (await this.client(scope,id)).listCalendars();
});}
 async selectCalendar(scope:ActionScope,id:string,raw:unknown){return observeConnectionControl(this.pool,"native_provider","select",{organizationId:scope.organizationId,connectionId:id},async()=>{const input=generationInput.extend({calendarId:z.string().min(1).max(1024),timeZone:z.string().min(1).max(128).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}}).optional()}).parse(raw),initial=await this.row(this.pool,scope,id);if(initial.generation!==input.generation)throw changed();const items=await this.calendars(scope,id),selected=items.items.find(item=>item.id===input.calendarId);if(!selected)throw new PlatformError("PROVIDER_CALENDAR_NOT_WRITABLE",400,"Select a writable calendar");if(input.timeZone)selected.timeZone=input.timeZone;
   return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.generation!==input.generation||row.state!=="active"||row.policy_revision!==initial.policy_revision)throw changed();await db.query("UPDATE agents_platform.connections SET policy_revision=policy_revision+1 WHERE id=$1",[id]);await db.query("UPDATE agents_platform.native_provider_connections SET selected_calendar=$2,status='ready',sharing='private',generation=generation+1 WHERE connection_id=$1",[id,JSON.stringify(selected)]);return this.dto(await this.row(db,scope,id));});

});}
 async sharing(scope:ActionScope,id:string,raw:unknown){return observeConnectionControl(this.pool,"native_provider","select",{organizationId:scope.organizationId,connectionId:id},async()=>{
   const input=generationInput.extend({sharing:z.enum(["private","organization_service"])}).parse(raw);this.requireProvider();
   return transaction(this.pool,async db=>{
     const row=await this.row(db,scope,id,true);this.assertDefinition(row);
     const calendar=this.definition.setup?.kind==="calendar_service";
     if((calendar?(!row.selected_operations.some((operation:string)=>["calendar.availability","calendar.book"].includes(operation))||!row.selected_calendar):!row.selected_operations.includes("contacts.create"))||row.generation!==input.generation||row.state!=="active"||row.status!=="ready")throw changed();
     const policyRevision=row.policy_revision+1;
     const bindingIds=calendar?row.binding_ids:await this.installBindings(db,scope,row,policyRevision,row.selected_operations);
     await db.query("UPDATE agents_platform.connections SET policy_revision=$2 WHERE id=$1",[id,policyRevision]);
     await db.query("UPDATE agents_platform.native_provider_connections SET sharing=$2,binding_ids=$3,generation=generation+1 WHERE connection_id=$1",[id,input.sharing,bindingIds]);
     return this.dto(await this.row(db,scope,id));
   });
 });}
 async disconnect(scope:ActionScope,id:string,raw:unknown){return observeConnectionControl(this.pool,"native_provider","disconnect",{organizationId:scope.organizationId,connectionId:id},async()=>{const input=generationInput.parse(raw);return transaction(this.pool,async db=>{const row=await this.row(db,scope,id,true);if(row.generation!==input.generation)throw changed();await db.query("UPDATE agents_platform.connections SET state='revoked',policy_revision=policy_revision+1 WHERE id=$1",[id]);await db.query("UPDATE agents_platform.native_provider_connections SET status='disconnected',sharing='private',generation=generation+1,current_oauth_attempt_id=NULL,refresh_lease=NULL,refresh_started_at=NULL WHERE connection_id=$1",[id]);await db.query("UPDATE agents_platform.native_provider_oauth_attempts SET consumed_at=now() WHERE connection_id=$1 AND consumed_at IS NULL",[id]);return this.dto(await this.row(db,scope,id));});
});}
 async resolveBookingCalendar(db:PoolClient,scope:ActionScope,id:string,policyRevision:number,options:{requireOrganizationService?:boolean;operation?:"calendar.availability"|"calendar.book"}={}):Promise<ResolvedBookingCalendar>{
   const row=await this.row(db,scope,id);this.assertDefinition(row);if(this.definition.setup?.kind!=="calendar_service"||!(row.selected_operations.includes(options.operation??"calendar.book")||options.operation==="calendar.availability"&&row.selected_operations.includes("calendar.book"))||row.state!=="active"||row.policy_revision!==policyRevision||row.status!=="ready"||!row.selected_calendar||new Date(row.expires_at).getTime()<=Date.now()||!this.scopes(row).every(item=>row.granted_scopes.includes(item))||options.requireOrganizationService&&row.sharing!=="organization_service")throw new PlatformError("PROVIDER_AUTHORITY_CHANGED",409,"Provider account authority changed");
   if(new Date(row.token_expires_at).getTime()<=Date.now()+5000)throw new PlatformError("PROVIDER_REFRESH_REQUIRED",401,"Provider credentials need refreshing");const tokens=await this.tokens(db,scope,row);
   if(tokens.subject!==row.account_subject||tokens.email!==row.account_email||Date.parse(tokens.expiresAt)<=Date.now()+5000||!this.scopes(row).every(scope=>tokens.scopes.includes(scope)))throw new PlatformError("PROVIDER_CREDENTIAL_MISMATCH",409,"Provider credentials no longer match selected authority");
   return {providerId:this.definition.id,connectionId:id,ownerAccountId:scope.accountId,organizationId:scope.organizationId,calendarId:row.selected_calendar.id,calendarName:row.selected_calendar.name,timeZone:row.selected_calendar.timeZone,policyRevision:row.policy_revision,generation:row.generation,accessToken:tokens.accessToken};
 }
}
