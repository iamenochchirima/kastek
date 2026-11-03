import { procedureToolNames } from "../contracts/procedures";
import { orchestrationTools } from "../contracts/orchestration";
import { historyResultBytes } from "../contracts/history";
import type { AgentConfiguration } from "../contracts/contracts";
import { capabilityContractMetadata } from "./tool-contracts";
export interface ToolDescriptor {
  name: typeof procedureToolNames[number] | AgentConfiguration["tools"][number] | "report.deliver" | "knowledge.initial" | "skills.activate" | "skills.read" | "skills.run" | "booking.availability" | "booking.reserve" | "tools.discover" | "tools.load" | "history.search" | "history.read"; version: "1" | "2" | "3" | "4";
  effect: "read" | "idempotent_memory" | "delegation" | "resource" | "external_effect" | "channel_control";
  maxDurationMs: number; maxResultBytes: number; retry: "safe_read" | "idempotent_receipt" | "stable_children" | "adapter_reconcile" | "status_only";
  cancel: "stop_admission" | "dependent_children" | "adapter_cleanup" | "reconcile_claimed";
  requiredProfile?: "python-analysis-v1";
  connection?: "scoped_report_destination"; review?: "exact_single_use"; adapter?: "report-delivery-http-v1";
  inputSchema: Record<string,unknown>; outputSchema: Record<string,unknown>;
  requiredAuthority: readonly string[]; requiredResources: readonly string[]; reconciliation: string;
}
export const BOOKING_WORKFLOW_BINDING=Object.freeze({profileId:"calendar-booking-v1",version:"1",adapter:"calendar-provider-v1",stages:["prepare_exact_intent","customer_confirmation","reserve_slot","validate_provider_availability","claim_once","provider_commit","reconcile","confirm_receipt"]});
const descriptors: readonly Omit<ToolDescriptor,"inputSchema"|"outputSchema"|"requiredAuthority"|"requiredResources"|"reconciliation">[] = [
  ...procedureToolNames.map(name=>({name,version:"1" as const,effect:(["procedures.discover","procedures.load","procedures.inspect"].includes(name)?"read":"channel_control") as ToolDescriptor["effect"],maxDurationMs:30000,maxResultBytes:16384,retry:"idempotent_receipt" as const,cancel:"stop_admission" as const})),
  {name:"tools.discover",version:"3",effect:"read",maxDurationMs:30000,maxResultBytes:65536,retry:"safe_read",cancel:"stop_admission"},
  {name:"tools.load",version:"3",effect:"read",maxDurationMs:30000,maxResultBytes:524288,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"history.search",version:"2",effect:"read",maxDurationMs:30000,maxResultBytes:historyResultBytes["history.search"],retry:"safe_read",cancel:"stop_admission"},
  {name:"history.read",version:"2",effect:"read",maxDurationMs:30000,maxResultBytes:historyResultBytes["history.read"],retry:"safe_read",cancel:"stop_admission"},
  {name:"tasks.inspect",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:4096,retry:"safe_read",cancel:"stop_admission"},
  {name:"tasks.cancel",version:"1",effect:"channel_control",maxDurationMs:30000,maxResultBytes:1024,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"artifact.create",version:"1",effect:"resource",maxDurationMs:30000,maxResultBytes:2048,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"enquiry.read",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:100000,retry:"safe_read",cancel:"stop_admission"},
  {name:"enquiry.amend",version:"1",effect:"external_effect",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"records.search",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:100000,retry:"safe_read",cancel:"stop_admission"},
  {name:"records.update",version:"1",effect:"external_effect",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"enquiry.submit",version:"1",effect:"external_effect",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"booking.availability",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"booking.reserve",version:"1",effect:"external_effect",maxDurationMs:60000,maxResultBytes:8192,retry:"status_only",cancel:"reconcile_claimed"},
  {name:"channel.request_handoff",version:"1",effect:"channel_control",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"support.request_handoff",version:"1",effect:"channel_control",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"support.request_handoff_v2",version:"1",effect:"channel_control",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"support.get_status_v2",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"support.get_status",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"knowledge.initial",version:"1",effect:"read",maxDurationMs:90000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"knowledge.search",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"knowledge.read",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.search",version:"3",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.read",version:"2",effect:"read",maxDurationMs:30000,maxResultBytes:65536,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.propose",version:"2",effect:"idempotent_memory",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"skills.activate",version:"2",effect:"read",maxDurationMs:30000,maxResultBytes:524288,retry:"safe_read",cancel:"stop_admission"},
  {name:"skills.read",version:"2",effect:"read",maxDurationMs:30000,maxResultBytes:524288,retry:"safe_read",cancel:"stop_admission"},
  ...orchestrationTools.map(name=>({name,version:"1" as const,effect:(name==="agents.start"||name==="agents.followup"?"delegation":name==="agents.cancel"||name==="work.update"?"channel_control":"read") as ToolDescriptor["effect"],maxDurationMs:30000,maxResultBytes:16384,retry:"idempotent_receipt" as const,cancel:"dependent_children" as const})),
  {name:"agents.delegate",version:"1",effect:"delegation",maxDurationMs:0,maxResultBytes:8192,retry:"stable_children",cancel:"dependent_children"},
  {name:"skills.run",version:"1",effect:"resource",maxDurationMs:240000,maxResultBytes:8192,retry:"adapter_reconcile",cancel:"adapter_cleanup",requiredProfile:"python-analysis-v1"},
  {name:"sandbox.analyze",version:"1",effect:"resource",maxDurationMs:240000,maxResultBytes:8192,retry:"adapter_reconcile",cancel:"adapter_cleanup",requiredProfile:"python-analysis-v1"},
  {name:"report.deliver",version:"1",effect:"external_effect",maxDurationMs:60000,maxResultBytes:8192,retry:"status_only",cancel:"reconcile_claimed",
    connection:"scoped_report_destination",review:"exact_single_use",adapter:"report-delivery-http-v1"},
];
function immutableJson<T>(value:T):T {
  if(value!==null&&typeof value==="object"){for(const child of Object.values(value))immutableJson(child);Object.freeze(value);}
  return value;
}
export const REPORT_WORKFLOW_BINDING=immutableJson({profileId:"report-delivery-v1",version:"1",adapter:"report-delivery-http-v1",
  stages:["generate","validate_artifact","prepare","review","claim","deliver","reconcile"],
  inputSchema:{type:"object",properties:{connectionId:{type:"string",format:"uuid"},artifactId:{type:"string",format:"uuid"},title:{type:"string",maxLength:120}},required:["connectionId","artifactId","title"],additionalProperties:false}});
export function toolDescriptor(name:string,legacyAdaptive=false,acceptedVersion?:string):ToolDescriptor|undefined {
  const descriptor=descriptors.find(descriptor=>descriptor.name===name);
  if(!descriptor)return undefined;
  const currentVersion=!legacyAdaptive&&["agents.start","agents.followup"].includes(name)?"4":name==="agents.result"&&!legacyAdaptive?"3":!legacyAdaptive&&["agents.status","work.inspect"].includes(name)?"2":descriptor.version;
  const version=acceptedVersion??currentVersion;
  const supported=version===currentVersion||["tools.discover","tools.load"].includes(name)&&version==="2"||name==="agents.result"&&version==="2"||["agents.start","agents.followup"].includes(name)&&["1","2","3"].includes(version)||
    ["tools.discover","tools.load","history.read","history.search","skills.activate","skills.read"].includes(name)&&version==="1"||
    name==="memory.search"&&["1","2"].includes(version)||["memory.read","memory.propose"].includes(name)&&version==="1";
  if(!supported)return undefined;
  return{...descriptor,version:version as ToolDescriptor["version"],...(!legacyAdaptive&&name==="agents.result"&&version==="3"?{maxResultBytes:65536}:{}),
    ...(["skills.activate","skills.read"].includes(name)&&version==="1"?{maxResultBytes:6144}:{}),...capabilityContractMetadata(name,legacyAdaptive,version)};
}

/** Presentation hints are separate from accepted descriptor digests and never grant authority. */
const nativePresentation:Record<string,{title:string;category:string;schemaLoading:"eager"|"auto"|"deferred"}>=Object.fromEntries([
  ["tools.discover","Find tools","Capabilities","eager"],["tools.load","Load tools","Capabilities","eager"],
  ["history.search","Find earlier work","History","eager"],["history.read","Read earlier work","History","eager"],
  ["knowledge.search","Search knowledge","Knowledge","eager"],["knowledge.read","Read knowledge","Knowledge","eager"],
  ["skills.activate","Use skill","Skills","eager"],["skills.read","Read skill resource","Skills","auto"],["skills.run","Run skill script","Skills","auto"],
  ["memory.search","Find memory","Memory","eager"],["memory.read","Read memory","Memory","auto"],["memory.propose","Propose memory","Memory","auto"],
  ["agents.discover","Find specialists","Specialists","eager"],["agents.start","Start specialist","Specialists","eager"],
  ["agents.status","Check specialists","Specialists","auto"],["agents.result","Read specialist result","Specialists","auto"],
  ["agents.wait","Wait for specialists","Specialists","auto"],["agents.followup","Follow up specialist","Specialists","auto"],
  ["agents.cancel","Stop specialist","Specialists","auto"],["agents.delegate","Delegate work","Specialists","auto"],
  ["work.update","Update plan","Work","auto"],["work.inspect","Read plan","Work","auto"],
  ["artifact.create","Create file","Files","auto"],["sandbox.analyze","Analyze data","Analysis","auto"],
  ["tasks.inspect","Read task","Tasks","auto"],["tasks.cancel","Stop task","Tasks","auto"],
  ["channel.request_handoff","Request human support","Support","eager"],["support.request_handoff","Request human support","Support","eager"],
  ["support.request_handoff_v2","Request human support","Support","eager"],["support.get_status","Check support status","Support","eager"],
  ["support.get_status_v2","Check support status","Support","eager"],
  ["booking.availability","Find appointment times","Bookings","auto"],["booking.reserve","Request booking","Bookings","auto"],
  ["enquiry.submit","Submit enquiry","Enquiries","auto"],["enquiry.read","Read enquiry","Enquiries","auto"],["enquiry.amend","Update enquiry","Enquiries","auto"],
  ["records.search","Find records","Records","auto"],["records.update","Update record","Records","auto"],
  ["report.deliver","Deliver report","Reports","auto"],
  ...procedureToolNames.map(name=>[name,name.replaceAll("."," ").replaceAll("_"," "),"Workflows","eager"]),
].map(([name,title,category,schemaLoading])=>[name,{title,category,schemaLoading:schemaLoading as "eager"|"auto"|"deferred"}]));
export function toolDescriptorPresentation(name:string) {
  const hint=nativePresentation[name],descriptor=descriptors.find(value=>value.name===name);
  return hint&&descriptor?{...hint,effect:descriptor.effect,source:"runtime" as const,readiness:"available" as const}:undefined;
}
