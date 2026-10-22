import type { PoolClient } from "pg";
import { z } from "zod";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { canonicalJson, isCustomerPrincipal, PlatformError, requestDigest } from "../../contracts/contracts";
import { textDigest } from "../../contracts/source-contracts";
import { connectorConfiguration, connectorExecutionDigest, type NativeConnectorConfiguration } from "../../adapters/providers/connector-registry";
import { createNativeProviderCatalog } from "../../capabilities/connected-tools/native-provider-tools";
import { assertCustomerNativeBindings } from "../../capabilities/connected-tools/customer-native-policy";
import { loadExecution } from "../../execution/lifecycle/state";
import type { PrivateObjectStore } from "../../infrastructure/object-store";
import { loadBookingPolicy } from "../../workflows/booking/policy";
import { withheldDependency, type EffectExport, type ExportRoot } from "./history-policy";

export interface ProviderEffectExportOptions { objects?: Pick<PrivateObjectStore,"get"> }
const denied = () => new PlatformError("EXPORT_DEPENDENCY_UNAVAILABLE",403,"Provider receipt is unavailable");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(2048);
const date = (value:unknown) => value == null ? null : new Date(value as string).toISOString();
const bookingReceipt = z.discriminatedUnion("state",[
  z.object({state:z.literal("confirmed"),eventId:id,start:z.iso.datetime(),end:z.iso.datetime(),receiptDigest:digest}),
  z.object({state:z.literal("uncertain"),eventId:id,reason:z.string().max(256),receiptDigest:digest.optional()}),
]);
const contactReceipt = z.discriminatedUnion("state",[
  z.strictObject({state:z.literal("confirmed"),contactId:z.string().regex(/^\d+$/).max(128),created:z.boolean(),receiptDigest:digest}),
  z.strictObject({state:z.literal("uncertain"),reason:z.string().max(256),receiptDigest:digest.optional()}),
]);
const contactList=z.array(z.strictObject({id:z.string().regex(/^\d+$/).max(128),email:z.email().max(254),firstName:z.string().max(256).optional(),lastName:z.string().max(256).optional()})).max(2);
const attemptReceipt=z.object({status:z.number().int().min(100).max(599).nullable(),requestBytes:z.number().int().nonnegative(),responseBytes:z.number().int().nonnegative(),elapsedMs:z.number().nonnegative(),outcome:z.string().max(128)});
function bounded(rows:unknown[],max=1024) { if(rows.length>max)throw new PlatformError("EXPORT_LIMIT",413,"Execution history exceeds the export limit"); }
function omission(result:EffectExport,error:unknown,reason:string) {
  if(!withheldDependency(error)&&!(error instanceof z.ZodError)&&!(error instanceof SyntaxError))throw error;
  result.omissions.push(reason);
}
async function attempts(db:PoolClient,table:"booking_attempts"|"connected_attempts",column:"booking_id"|"operation_id",value:string) {
  const rows=(await db.query(`SELECT ordinal,phase,state,receipt FROM agents_platform.${table} WHERE ${column}=$1 ORDER BY ordinal LIMIT 129`,[value])).rows;
  bounded(rows,128);
  return rows.map(row=>({ordinal:row.ordinal,phase:row.phase,state:row.state,receipt:row.receipt==null?null:attemptReceipt.parse(row.receipt)}));
}

/** Native state and sanitized receipts stay distinct from independent provider acceptance. */
export async function exportProviderEffects(db:PoolClient,root:ExportRoot,visibleTasks:ReadonlySet<string>,options:ProviderEffectExportOptions={}):Promise<EffectExport> {
  const result:EffectExport={records:[],omissions:[]};
  const bookings=(await db.query(`SELECT i.* FROM agents_platform.booking_intents i JOIN agents_platform.tasks t ON t.id=i.task_id
    WHERE t.root_task_id=$1 AND i.organization_id=$2 ORDER BY i.created_at,i.id LIMIT 1025`,[root.id,root.organization_id])).rows;
  bounded(bookings);
  for(const row of bookings)try {
    if(!visibleTasks.has(row.task_id))throw denied();
    const execution=await loadExecution(db,row.task_id),reference=execution.configuration.capabilities.businessActions;
    if(!reference.enabled||reference.policyId!==row.policy_id||requestDigest(row.principal)!==requestDigest(execution.task.principal))throw denied();
    const policy=await loadBookingPolicy(db,root.organization_id,execution.agentId,reference);
    const start=date(row.starts_at)!,end=date(row.ends_at)!;
    if(requestDigest({policy:reference,principal:execution.task.principal,start,end})!==row.request_digest)throw denied();
    const receipt=row.provider_result==null?null:bookingReceipt.parse(row.provider_result);
    const approved=["approved","claimed","confirmed","uncertain"].includes(row.state);
    if(approved&&(!row.approved_at||new Date(row.approved_at)>=new Date(row.expires_at)))throw denied();
    if(row.state==="confirmed"&&(!row.claimed_at||receipt?.state!=="confirmed"||receipt.start!==start||receipt.end!==end||row.result?.receiptDigest!==receipt.receiptDigest))throw denied();
    if(receipt?.state==="confirmed"&&row.state!=="confirmed")throw denied();
    result.records.push({schemaVersion:"calendar-booking-receipt.v1",bookingId:row.id,taskId:row.task_id,rootTaskId:root.id,operationId:row.operation_id,
      providerId:policy.providerId,policyDigest:reference.policyDigest,requestDigest:row.request_digest,start,end,timeZone:policy.timeZone,state:row.state,
      approvedAt:date(row.approved_at),claimedAt:date(row.claimed_at),expiresAt:date(row.expires_at),receipt,
      attempts:await attempts(db,"booking_attempts","booking_id",row.id)});
  }catch(error){omission(result,error,"Calendar booking receipt withheld because its task, confirmation or current policy is unavailable");}

  const reviews=(await db.query(`SELECT r.*,b.binding FROM agents_platform.tool_invocation_reviews r
    JOIN agents_platform.capability_bindings b ON b.id=r.binding_id WHERE r.root_task_id=$1 AND r.organization_id=$2 ORDER BY r.created_at,r.id LIMIT 1025`,[root.id,root.organization_id])).rows;
  const reads=(await db.query(`SELECT r.*,b.binding FROM agents_platform.connected_reads r
    JOIN agents_platform.capability_bindings b ON b.id=r.binding_id WHERE r.root_task_id=$1 AND r.organization_id=$2 ORDER BY r.created_at,r.operation_id LIMIT 1025`,[root.id,root.organization_id])).rows;
  bounded(reviews);bounded(reads);
  for(const row of reviews)if(row.binding?.policy?.effect==="reviewed_write"&&row.binding?.connection?.profileId!=="hubspot-contacts-v1")
    result.omissions.push("Reviewed MCP/API effect receipts are not exported by this provider receipt contract");
  const managed=new Map<string,{review?:Record<string,any>;read?:Record<string,any>}>();
  for(const review of reviews)if(review.binding?.connection?.profileId==="hubspot-contacts-v1")managed.set(review.operation_id,{review});
  for(const read of reads)if(read.binding?.connection?.profileId==="hubspot-contacts-v1")managed.set(read.operation_id,{...managed.get(read.operation_id),read});
  for(const [operationId,entry]of managed)try {
    const row=entry.read??entry.review!;
    if(!visibleTasks.has(row.task_id))throw denied();
    const execution=await loadExecution(db,row.task_id),binding=execution.connectedBindings.find(binding=>binding.id===row.binding_id);
    if(!binding||!execution.configuration.connectedToolBindingIds.includes(binding.id))throw denied();
    capabilityBindingSchema.parse(binding);
    if(capabilityBindingSchema.parse(row.binding).digest!==binding.digest)throw denied();
    const definition=connectorConfiguration(binding.definition.managed?.providerId??"") as NativeConnectorConfiguration;
    if(definition.profileId!=="hubspot-contacts-v1"||binding.connection?.profileId!==definition.profileId||binding.definition.managed?.connectorDigest!==connectorExecutionDigest(definition))throw denied();
    const catalog=createNativeProviderCatalog(definition,{id:binding.catalog.id,organizationId:root.organization_id,connectionId:binding.connection.id,revision:binding.catalog.revision});
    if(catalog.digest!==binding.catalog.digest||canonicalJson(catalog.adapter)!==canonicalJson(binding.adapter)||canonicalJson(catalog.tools.find(tool=>tool.providerOperation===binding.definition.providerOperation))!==canonicalJson(binding.definition))throw denied();
    const connection=(await db.query(`SELECT c.account_id FROM agents_platform.connections c
      JOIN agents_platform.native_provider_connections p ON p.connection_id=c.id AND p.organization_id=c.organization_id
      JOIN agents_platform.memberships m ON m.organization_id=c.organization_id AND m.account_id=c.account_id AND m.role='owner' AND m.revoked_at IS NULL
      WHERE c.id=$1 AND c.organization_id=$2 AND c.profile_id='hubspot-contacts-v1' AND c.state='active' AND c.expires_at>now()
      AND c.policy_revision=$3 AND p.status='ready' AND $4=ANY(p.binding_ids) AND $5=ANY(p.selected_operations)
      AND p.account_subject=$6 AND c.resource_handles @> $7::jsonb AND $8::text[] <@ p.granted_scopes AND p.provider_id=$9 FOR SHARE OF c,p,m`,
      [binding.connection.id,root.organization_id,binding.connection.policyRevision,binding.id,binding.definition.providerOperation,binding.resources[0]?.id,JSON.stringify(binding.resources),[...definition.auth.scopes,...definition.operations.find(operation=>operation.id===binding.definition.providerOperation)!.scopes],definition.id])).rows[0];
    if(!connection)throw denied();
    if(isCustomerPrincipal(execution.task.principal))await assertCustomerNativeBindings(db,root.organization_id,[binding.id]);
    else {
      const principal=execution.task.principal;
      if(principal.kind!=="human"||!(await db.query("SELECT 1 FROM agents_platform.accounts WHERE id=$1 AND issuer=$2 AND subject=$3",[connection.account_id,principal.issuer,principal.subject])).rowCount)throw denied();
    }
    const review=entry.review,read=entry.read;
    if(read&&review&&(read.task_id!==review.task_id||read.binding_id!==review.binding_id||read.connection_id!==review.connection_id
      ||read.request_digest!==requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args:review.arguments})))throw denied();
    if(review&&(review.binding_digest!==binding.digest||review.connection_policy_revision!==binding.connection.policyRevision||review.reviewer_account_id!==connection.account_id
      ||review.request_digest!==requestDigest({bindingDigest:binding.digest,arguments:review.arguments})))throw denied();
    if(binding.policy.effect==="reviewed_write"&&!review)throw denied();
    if(review&&["approved","claimed","completed","uncertain"].includes(review.state)&&(!review.approved_at||new Date(review.approved_at)>=new Date(review.expires_at)))throw denied();
    if(read?.state==="completed"&&!digest.safeParse(read.result?.observation?.digest).success)throw denied();
    let providerReceipt:unknown=null;
    if(read?.body_key){
      if(!options.objects||!digest.safeParse(read.body_digest).success||read.body_key!==`connected/${root.organization_id}/${root.id}/${textDigest(operationId)}/${read.body_digest}`)throw denied();
      let bytes:Uint8Array;
      try {bytes=await options.objects.get(read.body_key);}
      catch {throw new PlatformError("EXPORT_PROVIDER_BODY_UNAVAILABLE",503,"Private provider receipt is unavailable");}
      if(bytes.byteLength>65536||textDigest(bytes)!==read.body_digest)throw denied();
      const body=JSON.parse(Buffer.from(bytes).toString("utf8"));
      if(read.result?.observation?.digest&&read.result.observation.digest!==requestDigest(body))throw denied();
      if(binding.definition.providerOperation==="contacts.create")providerReceipt=contactReceipt.parse(body);
      else if(binding.definition.providerOperation==="contacts.search"){
        const contacts=contactList.parse(body);providerReceipt={matchedCount:contacts.length,contactIds:contacts.map(contact=>contact.id),resultDigest:requestDigest(body)};
      }else throw denied();
    }else if(read?.state==="completed")throw denied();
    if(read?.state==="completed"&&binding.policy.effect==="reviewed_write"&&(!review?.claimed_at||review.state!=="completed"||(providerReceipt as {state?:string})?.state!=="confirmed"))throw denied();
    result.records.push({schemaVersion:"native-provider-operation-receipt.v1",taskId:row.task_id,rootTaskId:root.id,operationId,providerId:definition.id,
      providerOperation:binding.definition.providerOperation,bindingId:binding.id,bindingDigest:binding.digest,effect:binding.policy.effect,
      state:read?.state??"not_invoked",requestDigest:read?.request_digest??null,bodyDigest:read?.body_digest??null,
      review:review?{id:review.id,state:review.state,requestDigest:review.request_digest,argumentsDigest:requestDigest(review.arguments),approvedAt:date(review.approved_at),claimedAt:date(review.claimed_at),expiresAt:date(review.expires_at)}:null,
      receipt:providerReceipt,errorCode:read?.error_code??null,attempts:read?await attempts(db,"connected_attempts","operation_id",operationId):[]});
  }catch(error){omission(result,error,"Native provider receipt withheld because its task, review, private body or current account policy is unavailable");}
  return result;
}
