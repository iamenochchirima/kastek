import type { AgentConfiguration } from "../contracts/contracts";
import { capabilityContractMetadata } from "./tool-contracts";
export interface ToolDescriptor {
  name: AgentConfiguration["tools"][number] | "report.deliver" | "knowledge.initial"; version: "1";
  effect: "read" | "idempotent_memory" | "delegation" | "resource" | "external_effect" | "channel_control";
  maxDurationMs: number; maxResultBytes: number; retry: "safe_read" | "idempotent_receipt" | "stable_children" | "adapter_reconcile" | "status_only";
  cancel: "stop_admission" | "dependent_children" | "adapter_cleanup" | "reconcile_claimed";
  requiredProfile?: "python-analysis-v1";
  connection?: "scoped_report_destination"; review?: "exact_single_use"; adapter?: "report-delivery-http-v1";
  inputSchema: Record<string,unknown>; outputSchema: Record<string,unknown>;
  requiredAuthority: readonly string[]; requiredResources: readonly string[]; reconciliation: string;
}
const descriptors: readonly Omit<ToolDescriptor,"inputSchema"|"outputSchema"|"requiredAuthority"|"requiredResources"|"reconciliation">[] = [
  {name:"channel.request_handoff",version:"1",effect:"channel_control",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"knowledge.initial",version:"1",effect:"read",maxDurationMs:90000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"knowledge.search",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"knowledge.read",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.search",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.propose",version:"1",effect:"idempotent_memory",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"agents.delegate",version:"1",effect:"delegation",maxDurationMs:0,maxResultBytes:8192,retry:"stable_children",cancel:"dependent_children"},
  {name:"sandbox.analyze",version:"1",effect:"resource",maxDurationMs:240000,maxResultBytes:8192,retry:"adapter_reconcile",cancel:"adapter_cleanup",requiredProfile:"python-analysis-v1"},
  {name:"report.deliver",version:"1",effect:"external_effect",maxDurationMs:60000,maxResultBytes:8192,retry:"status_only",cancel:"reconcile_claimed",
    connection:"scoped_report_destination",review:"exact_single_use",adapter:"report-delivery-http-v1"},
];
export const REPORT_WORKFLOW_BINDING=Object.freeze({profileId:"report-delivery-v1",version:"1",adapter:"report-delivery-http-v1",
  stages:["generate","validate_artifact","prepare","review","claim","deliver","reconcile"],
  inputSchema:{type:"object",properties:{connectionId:{type:"string",format:"uuid"},artifactId:{type:"string",format:"uuid"},title:{type:"string",maxLength:120}},required:["connectionId","artifactId","title"],additionalProperties:false}});
export function toolDescriptor(name:string):ToolDescriptor|undefined {
  const descriptor=descriptors.find(descriptor=>descriptor.name===name);
  return descriptor?{...descriptor,...capabilityContractMetadata(name)}:undefined;
}
