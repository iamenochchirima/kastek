import type { AgentConfiguration } from "./contracts";
export interface ToolDescriptor {
  name: AgentConfiguration["tools"][number]; version: "1";
  effect: "read" | "idempotent_memory" | "delegation" | "resource";
  maxDurationMs: number; maxResultBytes: number; retry: "safe_read" | "idempotent_receipt" | "stable_children" | "adapter_reconcile";
  cancel: "stop_admission" | "dependent_children" | "adapter_cleanup";
  requiredProfile?: "python-analysis-v1";
}
const descriptors: readonly ToolDescriptor[] = [
  {name:"knowledge.search",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"knowledge.read",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.search",version:"1",effect:"read",maxDurationMs:30000,maxResultBytes:8192,retry:"safe_read",cancel:"stop_admission"},
  {name:"memory.propose",version:"1",effect:"idempotent_memory",maxDurationMs:30000,maxResultBytes:8192,retry:"idempotent_receipt",cancel:"stop_admission"},
  {name:"agents.delegate",version:"1",effect:"delegation",maxDurationMs:0,maxResultBytes:8192,retry:"stable_children",cancel:"dependent_children"},
  {name:"sandbox.analyze",version:"1",effect:"resource",maxDurationMs:120000,maxResultBytes:8192,retry:"adapter_reconcile",cancel:"adapter_cleanup",requiredProfile:"python-analysis-v1"},
];
export function toolDescriptor(name:string):ToolDescriptor|undefined { return descriptors.find(descriptor=>descriptor.name===name); }
