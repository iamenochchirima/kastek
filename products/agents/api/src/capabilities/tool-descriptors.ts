import type { AgentConfiguration } from "../contracts/contracts";
import { capabilityContractMetadata } from "./tool-contracts";
export interface ToolDescriptor {
  name: AgentConfiguration["tools"][number] | "report.deliver" | "knowledge.initial" | "skills.activate" | "skills.read" | "skills.run" | "booking.availability" | "booking.reserve"; version: "1";
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
  {name:"tasks.inspect",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:4096,retry:"safe_read",cancel:"stop_admission"},
  {name:"tasks.cancel",version:"1",effect:"channel_control",maxDurationMs:30000,maxResultBytes:1024,retry:"idempotent_receipt",cancel:"stop_admission"},
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
  {name:"memory.search",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.propose",version:"1",effect:"idempotent_memory",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"skills.activate",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:6144,retry:"safe_read",cancel:"stop_admission"},
  {name:"skills.read",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:6144,retry:"safe_read",cancel:"stop_admission"},
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
export function toolDescriptor(name:string):ToolDescriptor|undefined {
  const descriptor=descriptors.find(descriptor=>descriptor.name===name);
  return descriptor?{...descriptor,...capabilityContractMetadata(name)}:undefined;
}
