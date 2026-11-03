import { orchestrationContracts, specialistFollowupV2Contract, specialistFollowupV3Contract, specialistFollowupV4Contract, specialistStartV2Contract, specialistStartV3Contract, specialistStartV4Contract } from "../contracts/orchestration";
import { z } from "zod";
import { PlatformError, taskStateSchema } from "../contracts/contracts";
import { recordFieldsSchema } from "../contracts/customer-records";
import { handoffBriefSchema } from "../contracts/channel";
import { toolDiscoveryContracts, toolDiscoveryV3Contracts, toolDiscoveryV1OutputSchema, toolLoadV1InputSchema } from "./tool-discovery";
import { historyContracts, historyReadV1Contract, historySearchV1Contract } from "../contracts/history";
import { memoryAssertionSchema } from "../contracts/memory";

const nonnegative=z.number().int().nonnegative(),uuid=z.uuid();
const evidence=z.strictObject({evidenceId:uuid,label:z.string().min(1).max(64),citation:z.string().min(1).max(68),text:z.string().max(8192),title:z.string().max(512)});
const memoryMetadata = z.strictObject({ id: uuid, revision: z.number().int().positive(), content: z.string().max(8192),
  origin: z.enum(["user_supplied", "model_candidate"]), verified: z.literal(false), updatedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable(), assertion: memoryAssertionSchema, evidence: evidence.pick({ evidenceId: true, label: true, citation: true }).optional() });
const snippet=evidence.extend({sourceId:uuid.nullable(),revisionId:uuid.nullable(),page:nonnegative.nullable(),acquiredAt:z.iso.datetime({offset:true}),start:nonnegative,end:nonnegative});
const knowledgeResult=z.strictObject({profile:z.enum(["lexical-v1","hybrid-v1"]),passages:z.array(snippet).max(8),omitted:nonnegative});
export const specialistRequestsSchema=z.strictObject({requests:z.array(z.strictObject({bindingId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),brief:z.string().trim().min(1).max(8192)})).min(1).max(2)});
export const legacyDelegationResultSchema=z.strictObject({children:z.array(z.strictObject({taskId:uuid,bindingId:z.string(),state:taskStateSchema,output:z.string().max(2048),outputTruncated:z.boolean(),originalBytes:nonnegative,errorCode:z.string().nullable(),sourceRevisionIds:z.array(uuid).max(20),connectedToolBindingIds:z.array(uuid).max(8),usage:z.strictObject({tokens:nonnegative,modelCalls:nonnegative,toolCalls:nonnegative})})).max(2),partial:z.boolean()});
const artifact=z.strictObject({id:uuid,name:z.string().min(1).max(80),contentType:z.string().min(1).max(128),bytes:nonnegative,contentDigest:z.string().regex(/^[a-f0-9]{64}$/),taskId:uuid,rootTaskId:uuid});
const digest=z.string().regex(/^[a-f0-9]{64}$/),skillEvidence=z.strictObject({packageDigest:digest,path:z.string().min(1).max(256),contentDigest:digest});
const skillRange=z.strictObject({start:nonnegative,end:nonnegative,totalBytes:nonnegative,nextOffset:nonnegative.nullable(),complete:z.boolean()});
const skillResultV1=z.strictObject({skillId:uuid,revision:z.number().int().positive(),name:z.string().min(1).max(64),content:z.string().max(4096),evidence:skillEvidence});
const skillResult=z.strictObject({skillId:uuid,revision:z.number().int().positive(),name:z.string().min(1).max(64),content:z.string().max(524288),evidence:skillEvidence,range:skillRange.optional()});

const bookingSlot=z.strictObject({start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true})});
export const enquiryFieldsSchema=z.strictObject({name:z.string().trim().min(1).max(200).optional(),email:z.email().max(320).optional(),phone:z.string().trim().min(1).max(80).optional(),service:z.string().trim().min(1).max(200).optional(),message:z.string().trim().min(1).max(4000).optional()});
const recordResult=z.strictObject({enquiryId:uuid,fields:recordFieldsSchema,status:z.string().max(32),revision:z.string().regex(/^[1-9][0-9]*$/),dueAt:z.iso.datetime({offset:true}).nullable()});
const adaptiveContracts=Object.fromEntries(Object.entries(orchestrationContracts).map(([name,contract])=>[name,{...contract,authority:["delegation.execute"],resources:["published_specialist_bindings","root_allocation"],reconciliation:name==="agents.start"||name==="agents.followup"?"stable_children":"idempotent_receipt"}]));
const contracts={
  ...adaptiveContracts,
  ...toolDiscoveryContracts,
  ...historyContracts,
  "artifact.create":{input:z.strictObject({name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),contentType:z.enum(["text/plain","text/markdown","application/json"]),content:z.string().max(1048576)}),
    output:z.strictObject({id:uuid,taskId:uuid,rootTaskId:uuid,name:z.string().min(1).max(120),contentType:z.enum(["text/plain","text/markdown","application/json"]),bytes:nonnegative,contentDigest:digest}),
    authority:["artifact.write"],resources:["authorized_task_artifact_store"],reconciliation:"idempotent_receipt"},
  "tasks.inspect":{input:z.strictObject({taskId:uuid.optional(),limit:z.number().int().min(1).max(10).optional()}),output:z.strictObject({tasks:z.array(z.strictObject({id:uuid,state:taskStateSchema,createdAt:z.iso.datetime({offset:true}),updatedAt:z.iso.datetime({offset:true})})).max(10)}),authority:["tasks.read"],resources:["current_human_membership","same_agent_prior_root"],reconciliation:"not_applicable"},
  "tasks.cancel":{input:z.strictObject({taskId:uuid}),output:z.strictObject({taskId:uuid,state:z.enum(["cancel_requested","already_terminal"]),taskState:taskStateSchema}),authority:["tasks.cancel"],resources:["current_human_membership","same_agent_prior_root"],reconciliation:"idempotent_tree_cancellation"},
  "enquiry.read":{input:z.strictObject({}),output:z.strictObject({enquiries:z.array(z.strictObject({enquiryId:uuid,fields:enquiryFieldsSchema,amendsEnquiryId:uuid.nullable()})).max(10)}),authority:["enquiry.read"],resources:["trusted_conversation_participant"],reconciliation:"not_applicable"},
  "enquiry.amend":{input:z.strictObject({enquiryId:uuid,fields:enquiryFieldsSchema}),output:z.strictObject({state:z.literal("submitted"),enquiryId:uuid,receiptDigest:digest}),authority:["enquiry.amend"],resources:["trusted_conversation_participant","exact_principal_confirmation"],reconciliation:"idempotent_receipt"},
  "records.search":{input:z.strictObject({search:z.string().trim().max(200).optional(),limit:z.number().int().min(1).max(10).optional()}),output:z.strictObject({records:z.array(recordResult).max(10)}),authority:["records.read"],resources:["current_staff_membership"],reconciliation:"not_applicable"},
  "records.update":{input:z.strictObject({enquiryId:uuid,expectedRevision:z.string().regex(/^[1-9][0-9]*$/),action:z.enum(["set-status","reopen","set-due"]),status:z.enum(["new","in_progress","waiting_on_customer","closed"]).optional(),dueAt:z.iso.datetime({offset:true}).nullable().optional()}),output:z.strictObject({enquiryId:uuid,status:z.string().max(32),revision:z.string().regex(/^[1-9][0-9]*$/),dueAt:z.iso.datetime({offset:true}).nullable(),receiptDigest:digest}),authority:["records.write"],resources:["current_staff_membership","enquiry_revision"],reconciliation:"idempotent_receipt"},
  "enquiry.submit":{input:z.strictObject({fields:z.strictObject({name:z.string().trim().min(1).max(200).optional(),email:z.email().max(320).optional(),phone:z.string().trim().min(1).max(80).optional(),service:z.string().trim().min(1).max(200).optional(),message:z.string().trim().min(1).max(4000).optional()})}),output:z.strictObject({state:z.literal("submitted"),enquiryId:uuid,receiptDigest:digest}),authority:["enquiry.submit"],resources:["published_enquiry_fields","exact_principal_confirmation"],reconciliation:"idempotent_receipt"},
  "booking.availability":{input:bookingSlot,output:z.strictObject({slots:z.array(bookingSlot).max(100),timeZone:z.string().max(128)}),authority:["booking.read"],resources:["published_booking_service_policy"],reconciliation:"not_applicable"},
  "booking.reserve":{input:z.strictObject({start:z.iso.datetime({offset:true})}),output:z.strictObject({state:z.enum(["confirmed","conflict","uncertain"]),bookingId:uuid,start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}),receiptDigest:digest.optional()}),authority:["booking.execute"],resources:["published_booking_service_policy","exact_customer_confirmation"],reconciliation:"deterministic_provider_event_lookup"},
  "knowledge.initial":{input:z.strictObject({query:z.string().min(1).max(1024)}),output:knowledgeResult,authority:["knowledge.read"],resources:["approved_source_revisions"],reconciliation:"not_applicable"},
  "knowledge.search":{input:z.strictObject({query:z.string().min(1).max(512)}),output:knowledgeResult,authority:["knowledge.read"],resources:["approved_source_revisions"],reconciliation:"not_applicable"},
  "knowledge.read":{input:z.strictObject({evidenceId:uuid,offset:nonnegative.max(1048576).optional()}),output:z.strictObject({passage:snippet,nextOffset:nonnegative.nullable()}),authority:["knowledge.read"],resources:["issued_evidence_handle"],reconciliation:"not_applicable"},
  "memory.search":{input:z.strictObject({query:z.string().max(512),offset:nonnegative.optional()}),output:z.union([
    z.strictObject({generation:nonnegative,memories:z.array(memoryMetadata.extend({content:z.string().max(512),excerpt:z.boolean(),totalBytes:nonnegative})).max(4),nextOffset:nonnegative.nullable()}),
    z.strictObject({generation:nonnegative,passages:z.array(evidence).max(2)}),
    z.strictObject({generation:nonnegative,memories:z.array(z.strictObject({id:uuid,revision:nonnegative,content:z.string().max(512)})).max(4)}),
  ]),authority:["memory.read"],resources:["reviewed_principal_memory_scope"],reconciliation:"not_applicable"},
  "memory.read":{input:z.strictObject({memoryId:uuid}),output:z.strictObject({generation:nonnegative,memory:memoryMetadata}),authority:["memory.read"],resources:["reviewed_principal_memory_scope","exact_memory_handle"],reconciliation:"not_applicable"},
  "memory.propose":{input:z.strictObject({content:z.string().min(1).max(2048),kind:z.enum(["semantic","episodic"]),assertion:memoryAssertionSchema.optional()}),output:z.strictObject({candidateId:uuid,status:z.literal("pending_review")}),authority:["memory.propose"],resources:["reviewed_principal_memory_scope"],reconciliation:"idempotent_receipt"},
  "skills.activate":{input:z.strictObject({skillId:uuid}),output:skillResult.extend({compatibility:z.string().max(500).nullable(),resources:z.array(z.strictObject({path:z.string().max(256),size:nonnegative,contentDigest:digest})).max(127)}),authority:["skill.read"],resources:["published_reviewed_skill_revision"],reconciliation:"not_applicable"},
  "skills.read":{input:z.strictObject({skillId:uuid,path:z.string().min(1).max(256),offset:nonnegative.max(524288).optional(),maxBytes:z.number().int().min(4).max(524288).optional()}),output:skillResult,authority:["skill.read"],resources:["published_reviewed_skill_revision","activated_skill_package"],reconciliation:"not_applicable"},
  "agents.delegate":{input:specialistRequestsSchema,output:legacyDelegationResultSchema,authority:["delegation.execute"],resources:["published_specialist_bindings","root_allocation"],reconciliation:"stable_children"},
  "sandbox.analyze":{input:z.strictObject({code:z.string().min(1).max(16384),inputArtifactIds:z.array(uuid).max(32).optional()}),output:z.strictObject({allocationId:uuid,commandId:uuid,state:z.enum(["completed","failed","uncertain"]),exitCode:z.number().int().nullable(),stdout:z.string().max(2048),stderr:z.string().max(2048),diagnosticsTruncated:z.boolean(),errorCode:z.string().nullable().optional(),artifacts:z.array(artifact).max(4)}),authority:["sandbox.execute","artifact.read","artifact.write"],resources:["temporary_executor_allocation","authorized_artifact_handles"],reconciliation:"owned_resource_status"},
  "skills.run":{input:z.strictObject({skillId:uuid,path:z.string().min(1).max(256),inputArtifactIds:z.array(uuid).max(32).optional()}),output:z.strictObject({skill:z.strictObject({skillId:uuid,revision:z.number().int().positive(),path:z.string().max(256),packageDigest:digest,contentDigest:digest}),allocationId:uuid,commandId:uuid,state:z.enum(["completed","failed","uncertain"]),exitCode:z.number().int().nullable(),stdout:z.string().max(2048),stderr:z.string().max(2048),diagnosticsTruncated:z.boolean(),errorCode:z.string().nullable().optional(),artifacts:z.array(artifact).max(4)}),authority:["skill.read","sandbox.execute","artifact.read","artifact.write"],resources:["temporary_executor_allocation","authorized_artifact_handles"],reconciliation:"owned_resource_status"},
  "channel.request_handoff":{input:z.strictObject({}),output:z.strictObject({state:z.literal("handoff_pending")}),authority:["channel.handoff"],resources:["current_channel_generation"],reconciliation:"idempotent_receipt"},
  "support.request_handoff":{input:handoffBriefSchema,output:z.strictObject({state:z.literal("handoff_pending")}),authority:["channel.handoff"],resources:["current_channel_generation"],reconciliation:"idempotent_receipt"},
  "support.request_handoff_v2":{input:handoffBriefSchema,output:z.strictObject({state:z.literal("handoff_pending")}),authority:["channel.handoff"],resources:["current_channel_generation","pending_handoff_receipt_v1"],reconciliation:"idempotent_receipt"},
  "support.get_status_v2":{input:z.strictObject({}),output:z.strictObject({hours:z.union([z.strictObject({state:z.literal("unknown")}),z.strictObject({state:z.enum(["open","closed"]),timeZone:z.string().max(128),intervals:z.array(z.strictObject({day:z.number().int().min(0).max(6),start:z.string(),end:z.string()})).max(28)})]),nextOpening:z.iso.datetime().nullable(),staffAvailability:z.enum(["available","away","unknown"]),responseTime:z.literal("unknown")}),authority:["channel.handoff"],resources:["published_support_hours","current_channel_generation","current_staff_presence"],reconciliation:"not_applicable"},
  "support.get_status":{input:z.strictObject({}),output:z.strictObject({hours:z.union([z.strictObject({state:z.literal("unknown")}),z.strictObject({state:z.enum(["open","closed"]),timeZone:z.string().max(128),intervals:z.array(z.strictObject({day:z.number().int().min(0).max(6),start:z.string(),end:z.string()})).max(28)})]),staffAvailability:z.literal("unknown"),responseTime:z.literal("unknown")}),authority:["channel.handoff"],resources:["published_support_hours","current_channel_generation"],reconciliation:"not_applicable"},
  "report.deliver":{input:z.strictObject({actionId:uuid}),output:z.strictObject({id:uuid,state:z.enum(["pending_review","approved","rejected","expired","invalidated","claimed","delivered","failed","uncertain"]),expiresAt:z.iso.datetime({offset:true}),errorCode:z.string().nullable().optional()}),authority:["effect.deliver","artifact.read","artifact.write"],resources:["exact_reviewed_artifact","current_destination","single_use_review"],reconciliation:"provider_receipt_only"},
} as const;

export function builtinContract(name:string,version?:string){
  const contract=Object.hasOwn(contracts,name)?contracts[name as keyof typeof contracts]:undefined;
  if(!contract)return undefined;
  if(name==="agents.start"&&version!=="1")return{...contract,...(version==="2"?specialistStartV2Contract:version==="3"?specialistStartV3Contract:specialistStartV4Contract)};
  if(name==="agents.followup"&&version!=="1")return{...contract,...(version==="2"?specialistFollowupV2Contract:version==="3"?specialistFollowupV3Contract:specialistFollowupV4Contract)};
  if((name==="tools.discover"||name==="tools.load")&&version==="3")return{...contract,...toolDiscoveryV3Contracts[name]};
  if(name==="tools.discover"&&version==="1")return{...contract,output:toolDiscoveryV1OutputSchema};
  if(name==="tools.load"&&version==="1")return{...contract,input:toolLoadV1InputSchema};
  if(name==="history.read"&&version==="1")return historyReadV1Contract;
  if(name==="history.search"&&version==="1")return historySearchV1Contract;
  if(name==="skills.activate"&&version==="1")return{...contract,output:skillResultV1.extend({compatibility:z.string().max(500).nullable(),resources:z.array(z.strictObject({path:z.string().max(256),size:nonnegative,contentDigest:digest})).max(127)})};
  if(name==="skills.read"&&version==="1")return{...contract,input:contracts["skills.read"].input.omit({offset:true,maxBytes:true}),output:skillResultV1};
  if(name==="agents.result"&&version!==undefined&&version!=="3")return{...contract,
    input:orchestrationContracts["agents.result"].input.omit({sourceOffset:true,effectOffset:true,artifactOffset:true}).extend({offset:nonnegative.max(1048576).optional()}),
    output:orchestrationContracts["agents.result"].output.omit({metadata:true})};
  if(name==="memory.propose"&&version==="1")return{...contract,input:contracts["memory.propose"].input.omit({assertion:true})};
  if(name==="memory.read"&&version==="1")return{...contract,output:contracts["memory.read"].output.extend({memory:memoryMetadata.omit({assertion:true})})};
  if(name==="memory.search"&&version==="2")return{...contract,output:z.union([
    z.strictObject({generation:nonnegative,memories:z.array(memoryMetadata.omit({assertion:true}).extend({content:z.string().max(512),excerpt:z.boolean(),totalBytes:nonnegative})).max(4),nextOffset:nonnegative.nullable()}),
    contracts["memory.search"].output.options[1]!,contracts["memory.search"].output.options[2]!,
  ])};
  if(name==="memory.search"&&version==="1")return{...contract,input:contracts["memory.search"].input.omit({offset:true}),output:z.union([
    contracts["memory.search"].output.options[1]!,contracts["memory.search"].output.options[2]!,
  ])};
  return contract;
}
function immutableJson<T>(value:T):T{
  if(value!==null&&typeof value==="object"){
    for(const child of Object.values(value))immutableJson(child);
    Object.freeze(value);
  }
  return value;
}
function createContractMetadata(contract:{input:z.ZodType;output:z.ZodType;authority:readonly string[];resources:readonly string[];reconciliation:string}){
  return immutableJson({inputSchema:z.toJSONSchema(contract.input),outputSchema:z.toJSONSchema(contract.output),requiredAuthority:[...contract.authority],
    requiredResources:[...contract.resources],reconciliation:contract.reconciliation});
}
const contractMetadata=new Map<string,ReturnType<typeof createContractMetadata>>();
export function capabilityContractMetadata(name:string,legacyAdaptive=false,version?:string){
  if(legacyAdaptive&&name==="agents.result")return createContractMetadata(builtinContract(name,"1")!);
  if(legacyAdaptive&&name==="agents.status")return createContractMetadata({...builtinContract(name)!,input:orchestrationContracts["agents.status"].input.omit({offset:true}),output:orchestrationContracts["agents.status"].output.omit({nextOffset:true})});
  if(legacyAdaptive&&name==="work.inspect")return createContractMetadata({...builtinContract(name)!,input:orchestrationContracts["work.inspect"].input.omit({instructionSequence:true,instructionOffset:true}),output:orchestrationContracts["work.inspect"].output.omit({instructionPage:true})});
  const contract=builtinContract(name,version);
  if(!contract)throw new PlatformError("CAPABILITY_RELEASE_UNAVAILABLE",503,"The built-in capability contract is unavailable");
  const key=`${name}:${version??"current"}`;
  let metadata=contractMetadata.get(key);
  if(!metadata){metadata=createContractMetadata(contract);contractMetadata.set(key,metadata);}
  return metadata;
}
export function validateBuiltinArguments(name:string,value:unknown,version?:string):unknown{
  const contract=builtinContract(name,version),parsed=contract?.input.safeParse(value);
  if(!parsed?.success)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"The arguments do not match the capability contract");
  return parsed.data;
}
export function validateBuiltinResult(name:string,value:unknown,version?:string):unknown{
  const contract=builtinContract(name,version),parsed=contract?.output.safeParse(value);
  if(!parsed?.success)throw new PlatformError("CAPABILITY_RESULT_INVALID",502,"The result does not match the published capability contract");
  return parsed.data;
}
