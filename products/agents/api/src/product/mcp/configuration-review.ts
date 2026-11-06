import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { agentConfigurationSchema,PlatformError,requestDigest,type AgentConfiguration } from "../../contracts/contracts";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { capabilityBindingPresentation } from "../../capabilities/tool-presentation";
import { readableToolTitle } from "../../capabilities/tool-discovery";
import { transaction } from "../../infrastructure/database";
import { applyCustomerSetup,customerSetupSchema } from "../offerings/customer-setup";
import { PlatformStore } from "../agents/store";

type Scope={accountId:string;organizationId:string};
type Review={id:string;request_id:string;organization_id:string;account_id:string;connection_id:string;agent_id:string;expected_revision:number;request_digest:string;configuration:AgentConfiguration;setup:unknown;setup_step:string|null;changes:unknown;state:string;resulting_revision:number|null;expired:boolean;agent_name:string};
const inputSchema=z.strictObject({agentId:z.uuid(),requestId:z.uuid(),expectedRevision:z.number().int().positive(),configuration:agentConfigurationSchema,
 setup:customerSetupSchema.optional(),setupStep:z.enum(["Business","Responsibilities","Knowledge","Channels","Preferences","Bookings","Review","complete"]).optional()});

/** A review pins the complete proposed configuration and its visible diff to the current revision. */
export class ConfigurationReview {
 private readonly store:PlatformStore;
 constructor(private readonly pool:Pool,private readonly publicUrl:string,private readonly assertBindings:(configuration:AgentConfiguration)=>Promise<void>){this.store=new PlatformStore(pool);}
 private async membership(db:Pool|PoolClient,scope:Scope){if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"Access denied");}
 private async row(db:Pool|PoolClient,accountId:string,id:string,lock=false):Promise<Review>{
  const row=(await db.query<Review>(`SELECT r.*,a.name agent_name,r.expires_at<=now() expired FROM agents_platform.mcp_configuration_reviews r
   JOIN agents_platform.agents a ON a.id=r.agent_id AND a.organization_id=r.organization_id WHERE r.id=$1 AND r.account_id=$2 AND a.deleted_at IS NULL ${lock?"FOR UPDATE OF r":""}`,[z.uuid().parse(id),accountId])).rows[0];
  if(!row)throw new PlatformError("NOT_FOUND",404,"Review unavailable");await this.membership(db,{accountId,organizationId:row.organization_id});return row;
 }
 private dto(row:Review){return {id:row.id,agentName:row.agent_name,state:row.state==="pending"&&row.expired?"expired":row.state,changes:row.changes,resultingRevision:row.resulting_revision,reviewUrl:new URL(`/app/mcp/config-review?request=${row.id}`,this.publicUrl).toString()};}
 private async diff(db:PoolClient,organizationId:string,before:AgentConfiguration,after:AgentConfiguration,oldSetup:unknown,newSetup:unknown){
  const referenceLabels=new Map<string,string>();
  const sources=(await db.query(`SELECT r.id::text,r.revision,s.title FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id WHERE r.organization_id=$1`,[organizationId])).rows;
  for(const row of sources)referenceLabels.set(row.id,`Knowledge: ${row.title} (revision ${row.revision})`);
  for(const row of (await db.query("SELECT id::text,name,revision FROM agents_platform.skill_revisions WHERE organization_id=$1",[organizationId])).rows)referenceLabels.set(row.id,`Skill: ${row.name} (revision ${row.revision})`);
  for(const row of (await db.query("SELECT id::text,name FROM agents_platform.connections WHERE organization_id=$1",[organizationId])).rows)referenceLabels.set(row.id,`Connection: ${row.name}`);
  for(const row of (await db.query("SELECT id::text,name FROM agents_platform.model_provider_connections WHERE organization_id=$1",[organizationId])).rows)referenceLabels.set(row.id,`Model connection: ${row.name}`);
  for(const row of (await db.query(`SELECT b.id::text,b.binding,c.name connection_name FROM agents_platform.capability_bindings b
    JOIN agents_platform.connections c ON c.id=b.connection_id AND c.organization_id=b.organization_id WHERE b.organization_id=$1`,[organizationId])).rows){const parsed=capabilityBindingSchema.safeParse(row.binding);if(parsed.success){const p=capabilityBindingPresentation(parsed.data);referenceLabels.set(row.id,`Tool: ${p.title} (${row.connection_name}; ${p.effect})`);}}
  const shown=new Map<string,string>();
  const clean=(v:unknown,key=""):unknown=>{
   if(typeof v==="string"){
    if(z.uuid().safeParse(v).success){
     const label=referenceLabels.get(v);
     if(!label)throw new PlatformError("REVIEW_REFERENCE_UNAVAILABLE",409,"A selected resource cannot be described for review");
     const previous=shown.get(label);
     if(previous&&previous!==v)throw new PlatformError("REVIEW_REFERENCE_AMBIGUOUS",409,"Selected resources cannot be distinguished for review");
     shown.set(label,v);return label;
    }
    return key==="tools"?readableToolTitle(v):v;
   }
   if(Array.isArray(v))return v.map(item=>clean(item,key));
   if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v as Record<string,unknown>).map(([k,value])=>[k,clean(value,k)]));
   return v??null;
  };
  const changes:{field:string;before:string;after:string}[]=[];
  const visit=(a:unknown,b:unknown,path:string)=>{
   if(requestDigest(a??null)===requestDigest(b??null))return;
   if(a&&b&&!Array.isArray(a)&&!Array.isArray(b)&&typeof a==="object"&&typeof b==="object"){
    for(const k of new Set([...Object.keys(a as object),...Object.keys(b as object)]))visit((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k],path?`${path}.${k}`:k);
    return;
   }
   changes.push({field:path,before:JSON.stringify(clean(a,path.split(".").at(-1))),after:JSON.stringify(clean(b,path.split(".").at(-1)))});
  };
  visit(before,after,"");if(newSetup!==undefined)visit(oldSetup,newSetup,"setup");return changes;
 }
 async propose(scope:Scope & {connectionId:string},raw:unknown){
  const input=inputSchema.parse(raw);await this.assertBindings(input.configuration);
  return transaction(this.pool,async db=>{
   await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await this.membership(db,scope);
   const digest=requestDigest({agentId:input.agentId,expectedRevision:input.expectedRevision,configuration:input.configuration,setup:input.setup??null,setupStep:input.setupStep??null,connectionId:scope.connectionId});
   const prior=(await db.query<Review>(`SELECT r.*,a.name agent_name,r.expires_at<=now() expired FROM agents_platform.mcp_configuration_reviews r JOIN agents_platform.agents a ON a.id=r.agent_id
     WHERE r.organization_id=$1 AND r.account_id=$2 AND r.request_id=$3`,[scope.organizationId,scope.accountId,input.requestId])).rows[0];
   if(prior){if(prior.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request identifier was used for another change");return this.dto(prior);}
   if(!(await db.query("SELECT 1 FROM agents_platform.mcp_oauth_connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND revoked_at IS NULL AND 'agents:manage'=ANY(scopes) FOR SHARE",[scope.connectionId,scope.organizationId,scope.accountId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"Connection access is unavailable");
   const agent=(await db.query("SELECT * FROM agents_platform.agents WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE",[input.agentId,scope.organizationId])).rows[0];
   if(!agent)throw new PlatformError("NOT_FOUND",404,"Agent not found");if(agent.draft_revision!==input.expectedRevision)throw new PlatformError("DRAFT_CONFLICT",409,"Agent settings changed. Refresh and try again.");
   const before=agentConfigurationSchema.parse(agent.draft);
   const allowed=new Set(input.setup?[]:["tools","connectedToolBindingIds","skillIds","sourceRevisionIds","instructions","model"]);
   for(const key of Object.keys(before) as (keyof AgentConfiguration)[])if(!allowed.has(key)&&requestDigest(before[key]??null)!==requestDigest(input.configuration[key]??null))
     throw new PlatformError("REVIEW_CHANGE_UNSUPPORTED",400,input.setup?"Request setup changes in a separate review from model, tools, knowledge, and instruction changes.":"This settings change is not available through this review");
   const after=input.setup?applyCustomerSetup(input.configuration,input.setup,agent.setup??undefined):input.configuration;
   const changes=await this.diff(db,scope.organizationId,before,agentConfigurationSchema.parse(after),agent.setup,input.setup);
   if(input.setupStep!==undefined&&input.setupStep!==agent.setup_step)changes.push({field:"setupStep",before:JSON.stringify(agent.setup_step??null),after:JSON.stringify(input.setupStep)});
   const id=randomUUID();await db.query(`INSERT INTO agents_platform.mcp_configuration_reviews(id,request_id,organization_id,account_id,connection_id,agent_id,expected_revision,request_digest,configuration,setup,setup_step,changes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,input.requestId,scope.organizationId,scope.accountId,scope.connectionId,input.agentId,input.expectedRevision,digest,JSON.stringify(input.configuration),input.setup?JSON.stringify(input.setup):null,input.setupStep??null,JSON.stringify(changes)]);
   return this.dto(await this.row(db,scope.accountId,id));
  });
 }
 async get(accountId:string,id:string){return this.dto(await this.row(this.pool,accountId,id));}
 async getForScope(scope:Scope & {connectionId:string},id:string){const row=await this.row(this.pool,scope.accountId,id);if(row.organization_id!==scope.organizationId||row.connection_id!==scope.connectionId)throw new PlatformError("NOT_FOUND",404,"Review unavailable");return this.dto(row);}
 async decide(accountId:string,id:string,approved:boolean){
  const saved=await this.row(this.pool,accountId,id);if(approved&&saved.state==="pending")await this.assertBindings(agentConfigurationSchema.parse(saved.configuration));
  return transaction(this.pool,async db=>{
   const row=await this.row(db,accountId,id,true);if(row.state!=="pending")return this.dto(row);if(row.expired)throw new PlatformError("REVIEW_EXPIRED",409,"Review expired");
   if(!approved){await db.query("UPDATE agents_platform.mcp_configuration_reviews SET state='cancelled' WHERE id=$1",[row.id]);return this.dto({...row,state:"cancelled"});}
   await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[row.organization_id]);
   if(!(await db.query("SELECT 1 FROM agents_platform.mcp_oauth_connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND revoked_at IS NULL AND 'agents:manage'=ANY(scopes) FOR SHARE",[row.connection_id,row.organization_id,accountId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"Connection access is unavailable");
   const result=await this.store.saveConfigurationInTransaction(db,{accountId,organizationId:row.organization_id,agentId:row.agent_id,configuration:agentConfigurationSchema.parse(row.configuration),expectedRevision:row.expected_revision,confirmImpact:true,...(row.setup?{setup:customerSetupSchema.parse(row.setup)}:{}),...(row.setup_step?{setupStep:row.setup_step}:{})});
   await db.query("UPDATE agents_platform.mcp_configuration_reviews SET state='approved',resulting_revision=$2 WHERE id=$1",[row.id,result.agent.draft_revision]);
   return this.dto({...row,state:"approved",resulting_revision:result.agent.draft_revision});
  });
 }
}
