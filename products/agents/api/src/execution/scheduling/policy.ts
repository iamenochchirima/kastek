import {z} from "zod";
import {createHash} from "node:crypto";
import type {Execution,OperationRequest} from "../../contracts/execution";
import type {CapacityRequest} from "./capacity";
const limit=z.number().int().min(1).max(100000);
export const schedulingPolicySchema=z.strictObject({
 productActive:limit.default(128),tenantActive:limit.default(8),modelActive:limit.default(2),toolActive:limit.default(4),providerActive:limit.default(128),localProviderActive:limit.optional(),
 interactiveActive:limit.default(4),backgroundActive:limit.default(2),ingestionActive:limit.default(2),sandboxActive:limit.default(2),evaluationActive:limit.default(2),
 maxConcurrentRoots:limit.default(2),maxQueued:limit.default(1000),maxWaitMs:z.number().int().min(1000).max(900000).default(120000),
 dailyTokenAllowance:z.number().int().min(1).max(2000000000).default(100000),
});
export type SchedulingPolicy=z.infer<typeof schedulingPolicySchema>;
export function schedulingPolicyFromEnvironment(environment:NodeJS.ProcessEnv=process.env):SchedulingPolicy{
 let value:unknown={};if(environment.AGENTS_SCHEDULING_POLICY_JSON){try{value=JSON.parse(environment.AGENTS_SCHEDULING_POLICY_JSON);}catch{throw Error("Invalid scheduling policy");}}
 return schedulingPolicySchema.parse(value);
}
const short=(value:string)=>createHash("sha256").update(value).digest("hex").slice(0,40);
export function operationCapacity(execution:Execution,input:OperationRequest,environment:NodeJS.ProcessEnv=process.env):{request:CapacityRequest;policy:SchedulingPolicy}{
 const policy=schedulingPolicyFromEnvironment(environment),task=execution.task;
 const workload:CapacityRequest['workload']=task.evaluation_trial_id?'evaluation':input.kind==='compaction'&&input.workload==='background'?'background':input.name.includes('sandbox')?'sandbox':input.name.startsWith('source.')||input.name.startsWith('document.')?'ingestion':task.principal.kind==='automation'?'background':'interactive';
 const model=['model','compaction'].includes(input.kind),tenant=`${task.product}:${task.organization_id}`;
 const binding=execution.connectedBindings.find(binding=>binding.alias===input.name||binding.id===input.name);
 let account=model?`${task.organization_id}:${execution.models[input.kind==='compaction'?'compaction':'primary'].binding.connectionId}`:binding?.connection?.id??'local';
 if(binding?.connection&&environment.AGENTS_PROVIDER_ACCOUNT_MAP_JSON){
  const mapping=z.record(z.string(),z.string().min(1).max(128)).parse(JSON.parse(environment.AGENTS_PROVIDER_ACCOUNT_MAP_JSON));account=mapping[binding.connection.id]??binding.connection.id;
 }
 return {policy,request:{id:input.id,taskId:task.id,workload,buckets:[
  {key:`product:${task.product}`,limit:policy.productActive},
  {key:`tenant:${tenant}`,limit:policy.tenantActive},
  {key:`class:${tenant}:${model?'model':'tool'}`,limit:model?policy.modelActive:policy.toolActive},
  {key:`workload:${tenant}:${workload}`,limit:policy[`${workload}Active`]},
  {key:`provider:${model?'model':binding?'connected':'local'}:${short(account)}`,limit:!model&&!binding?(policy.localProviderActive??policy.providerActive):policy.providerActive},
 ]}};
}
