import { z } from "zod";
import { PlatformError, taskStateSchema } from "../contracts/contracts";

const nonnegative=z.number().int().nonnegative(),uuid=z.uuid();
const evidence=z.strictObject({evidenceId:uuid,label:z.string().min(1).max(64),citation:z.string().min(1).max(68),text:z.string().max(8192),title:z.string().max(512)});
const snippet=evidence.extend({sourceId:uuid.nullable(),revisionId:uuid.nullable(),page:nonnegative.nullable(),acquiredAt:z.iso.datetime({offset:true}),start:nonnegative,end:nonnegative});
const knowledgeResult=z.strictObject({profile:z.enum(["lexical-v1","hybrid-v1"]),passages:z.array(snippet).max(8),omitted:nonnegative});
export const specialistRequestsSchema=z.strictObject({requests:z.array(z.strictObject({bindingId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),brief:z.string().trim().min(1).max(8192)})).min(1).max(2)});
const artifact=z.strictObject({id:uuid,name:z.string().min(1).max(80),contentType:z.string().min(1).max(128),bytes:nonnegative,contentDigest:z.string().regex(/^[a-f0-9]{64}$/),taskId:uuid,rootTaskId:uuid});
const digest=z.string().regex(/^[a-f0-9]{64}$/),skillEvidence=z.strictObject({packageDigest:digest,path:z.string().min(1).max(256),contentDigest:digest});
const skillResult=z.strictObject({skillId:uuid,revision:z.number().int().positive(),name:z.string().min(1).max(64),content:z.string().max(4096),evidence:skillEvidence});

const bookingSlot=z.strictObject({start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true})});
const growthDraft=z.strictObject({title:z.string().min(1).max(200),content:z.string().min(1).max(20000),
  channels:z.array(z.string().min(1).max(64)).max(7),channelSelections:z.record(z.string(),z.string().min(1).max(256)),
  variants:z.array(z.strictObject({platform:z.string().min(1).max(64),content:z.string().max(20000)})).max(10).optional()});
const contracts={
  "growth.context_read":{input:z.strictObject({}),output:z.strictObject({context:z.unknown(),revision:z.string(),data:z.unknown(),
    sources:z.array(z.strictObject({id:z.string(),title:z.string(),citationLabel:z.string().optional(),url:z.string().optional(),route:z.string().optional(),revision:z.string().optional()})),passages:z.array(evidence).max(1).optional()}),
    authority:["product.read"],resources:["current_product_membership","accepted_product_context"],reconciliation:"not_applicable"},
  "growth.draft_prepare":{input:z.strictObject({draft:growthDraft}),output:z.strictObject({review:z.unknown(),result:z.unknown()}),
    authority:["product.read","product.write"],resources:["exact_growth_review","current_product_membership","single_use_effect_authorization"],reconciliation:"growth_authoritative_draft_receipt"},
  "booking.availability":{input:bookingSlot,output:z.strictObject({slots:z.array(bookingSlot).max(100),timeZone:z.string().max(128)}),authority:["booking.read"],resources:["published_booking_service_policy"],reconciliation:"not_applicable"},
  "booking.reserve":{input:z.strictObject({start:z.iso.datetime({offset:true})}),output:z.strictObject({state:z.enum(["confirmed","conflict","uncertain"]),bookingId:uuid,start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}),receiptDigest:digest.optional()}),authority:["booking.execute"],resources:["published_booking_service_policy","exact_customer_confirmation"],reconciliation:"deterministic_provider_event_lookup"},
  "knowledge.initial":{input:z.strictObject({query:z.string().min(1).max(1024)}),output:knowledgeResult,authority:["knowledge.read"],resources:["approved_source_revisions"],reconciliation:"not_applicable"},
  "knowledge.search":{input:z.strictObject({query:z.string().min(1).max(512)}),output:knowledgeResult,authority:["knowledge.read"],resources:["approved_source_revisions"],reconciliation:"not_applicable"},
  "knowledge.read":{input:z.strictObject({evidenceId:uuid,offset:nonnegative.max(1048576).optional()}),output:z.strictObject({passage:snippet,nextOffset:nonnegative.nullable()}),authority:["knowledge.read"],resources:["issued_evidence_handle"],reconciliation:"not_applicable"},
  "memory.search":{input:z.strictObject({query:z.string().max(512)}),output:z.union([
    z.strictObject({generation:nonnegative,passages:z.array(evidence).max(2)}),
    z.strictObject({generation:nonnegative,memories:z.array(z.strictObject({id:uuid,revision:nonnegative,content:z.string().max(512)})).max(4)}),
  ]),authority:["memory.read"],resources:["reviewed_principal_memory_scope"],reconciliation:"not_applicable"},
  "memory.propose":{input:z.strictObject({content:z.string().min(1).max(2048),kind:z.enum(["semantic","episodic"])}),output:z.strictObject({candidateId:uuid,status:z.literal("pending_review")}),authority:["memory.propose"],resources:["reviewed_principal_memory_scope"],reconciliation:"idempotent_receipt"},
  "skills.activate":{input:z.strictObject({skillId:uuid}),output:skillResult.extend({compatibility:z.string().max(500).nullable(),resources:z.array(z.strictObject({path:z.string().max(256),size:nonnegative,contentDigest:digest})).max(127)}),authority:["skill.read"],resources:["published_reviewed_skill_revision"],reconciliation:"not_applicable"},
  "skills.read":{input:z.strictObject({skillId:uuid,path:z.string().min(1).max(256)}),output:skillResult,authority:["skill.read"],resources:["published_reviewed_skill_revision","activated_skill_package"],reconciliation:"not_applicable"},
  "agents.delegate":{input:specialistRequestsSchema,output:z.strictObject({children:z.array(z.strictObject({taskId:uuid,bindingId:z.string(),state:taskStateSchema,output:z.string().max(2048),outputTruncated:z.boolean(),originalBytes:nonnegative,errorCode:z.string().nullable(),sourceRevisionIds:z.array(uuid).max(20),connectedToolBindingIds:z.array(uuid).max(8),usage:z.strictObject({tokens:nonnegative,modelCalls:nonnegative,toolCalls:nonnegative})})).max(2),partial:z.boolean()}),authority:["delegation.execute"],resources:["published_specialist_bindings","root_allocation"],reconciliation:"stable_children"},
  "sandbox.analyze":{input:z.strictObject({code:z.string().min(1).max(16384),inputArtifactIds:z.array(uuid).max(32).optional()}),output:z.strictObject({allocationId:uuid,commandId:uuid,state:z.enum(["completed","failed","uncertain"]),exitCode:z.number().int().nullable(),stdout:z.string().max(2048),stderr:z.string().max(2048),diagnosticsTruncated:z.boolean(),errorCode:z.string().nullable().optional(),artifacts:z.array(artifact).max(4)}),authority:["sandbox.execute","artifact.read","artifact.write"],resources:["temporary_executor_allocation","authorized_artifact_handles"],reconciliation:"owned_resource_status"},
  "skills.run":{input:z.strictObject({skillId:uuid,path:z.string().min(1).max(256),inputArtifactIds:z.array(uuid).max(32).optional()}),output:z.strictObject({skill:z.strictObject({skillId:uuid,revision:z.number().int().positive(),path:z.string().max(256),packageDigest:digest,contentDigest:digest}),allocationId:uuid,commandId:uuid,state:z.enum(["completed","failed","uncertain"]),exitCode:z.number().int().nullable(),stdout:z.string().max(2048),stderr:z.string().max(2048),diagnosticsTruncated:z.boolean(),errorCode:z.string().nullable().optional(),artifacts:z.array(artifact).max(4)}),authority:["skill.read","sandbox.execute","artifact.read","artifact.write"],resources:["temporary_executor_allocation","authorized_artifact_handles"],reconciliation:"owned_resource_status"},
  "channel.request_handoff":{input:z.strictObject({}),output:z.strictObject({state:z.literal("handoff_pending")}),authority:["channel.handoff"],resources:["current_channel_generation"],reconciliation:"idempotent_receipt"},
  "report.deliver":{input:z.strictObject({actionId:uuid}),output:z.strictObject({id:uuid,state:z.enum(["pending_review","approved","rejected","expired","invalidated","claimed","delivered","failed","uncertain"]),expiresAt:z.iso.datetime({offset:true}),errorCode:z.string().nullable().optional()}),authority:["effect.deliver","artifact.read","artifact.write"],resources:["exact_reviewed_artifact","current_destination","single_use_review"],reconciliation:"provider_receipt_only"},
} as const;

export function builtinContract(name:string){return Object.hasOwn(contracts,name)?contracts[name as keyof typeof contracts]:undefined;}
function immutableJson<T>(value:T):T{
  if(value!==null&&typeof value==="object"){
    for(const child of Object.values(value))immutableJson(child);
    Object.freeze(value);
  }
  return value;
}
function createContractMetadata(contract:NonNullable<ReturnType<typeof builtinContract>>){
  return immutableJson({inputSchema:z.toJSONSchema(contract.input),outputSchema:z.toJSONSchema(contract.output),requiredAuthority:[...contract.authority],
    requiredResources:[...contract.resources],reconciliation:contract.reconciliation});
}
const contractMetadata=new Map<string,ReturnType<typeof createContractMetadata>>();
export function capabilityContractMetadata(name:string){
  const contract=builtinContract(name);
  if(!contract)throw new PlatformError("CAPABILITY_RELEASE_UNAVAILABLE",503,"The built-in capability contract is unavailable");
  let metadata=contractMetadata.get(name);
  if(!metadata){metadata=createContractMetadata(contract);contractMetadata.set(name,metadata);}
  return metadata;
}
export function validateBuiltinArguments(name:string,value:unknown):unknown{
  const contract=builtinContract(name),parsed=contract?.input.safeParse(value);
  if(!parsed?.success)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"The arguments do not match the capability contract");
  return parsed.data;
}
export function validateBuiltinResult(name:string,value:unknown):unknown{
  const contract=builtinContract(name),parsed=contract?.output.safeParse(value);
  if(!parsed?.success)throw new PlatformError("CAPABILITY_RESULT_INVALID",502,"The result does not match the published capability contract");
  return parsed.data;
}
