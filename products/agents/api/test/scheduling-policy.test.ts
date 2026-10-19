import {describe,it,expect} from "vitest";
import {operationCapacity,schedulingPolicyFromEnvironment} from "../src/execution/scheduling/policy";
import type {Execution} from "../src/contracts/execution";
describe('trusted scheduling policy',()=>{
 it('rejects unbounded, unknown and malformed operator limits',()=>{
  for(const value of [{maxConcurrentRoots:100001},{modelActive:0},{localProviderActive:0},{localProviderActive:100001},{localProviderActive:1.5},{localProviderActive:"32"},{localProviderActive:null},{maxWaitMs:Infinity},{unknown:1}])expect(()=>schedulingPolicyFromEnvironment({AGENTS_SCHEDULING_POLICY_JSON:JSON.stringify(value)})).toThrowError();
  expect(schedulingPolicyFromEnvironment({AGENTS_SCHEDULING_POLICY_JSON:JSON.stringify({maxConcurrentRoots:10000,dailyTokenAllowance:1000000000})}).maxConcurrentRoots).toBe(10000);
 });
 it('uses accepted trial/principal and pinned connections rather than request-supplied workload/account',()=>{
  const execution={task:{id:'task',product:'agents',organization_id:'tenant',evaluation_trial_id:'trial',principal:{kind:'human'}},connectedBindings:[{id:'binding',alias:'tool',connection:{id:'connection'}}]} as unknown as Execution;
  const input={id:'op',kind:'tool' as const,name:'tool',request:{workload:'interactive',account:'attacker'},reservedTokens:0,reservedMs:1000};
  const {request}=operationCapacity(execution,input,{AGENTS_PROVIDER_ACCOUNT_MAP_JSON:JSON.stringify({connection:'verified-account'})});
  expect(request.workload).toBe('evaluation');expect(request.buckets.some(bucket=>bucket.key.includes('attacker'))).toBe(false);
  expect(()=>operationCapacity(execution,{...input,kind:'model'},{NODE_ENV:'production'})).toThrowError();
 });
 it('applies the optional local bound only to local operations, retaining provider fallback',()=>{
  const execution={task:{id:'task',product:'agents',organization_id:'tenant',principal:{kind:'human'}},connectedBindings:[{id:'binding',alias:'tool',connection:{id:'connection'}}]} as unknown as Execution;
  const input={id:'op',kind:'tool' as const,name:'report.prepare',request:{localProviderActive:99999},reservedTokens:0,reservedMs:60000};
  const environment={AGENTS_SCHEDULING_POLICY_JSON:JSON.stringify({providerActive:10000,localProviderActive:1}),AGENTS_MODEL_ACCOUNT_ID:'model-account',AGENTS_PROVIDER_ACCOUNT_MAP_JSON:JSON.stringify({connection:'verified-account'})};
  const provider=(name:string,kind:'tool'|'model'|'compaction'|'delegation'|'resource'='tool')=>operationCapacity(execution,{...input,name,kind},environment).request.buckets.find(bucket=>bucket.key.startsWith('provider:'))!;
  for(const [name,kind] of [['report.prepare','tool'],['report.deliver','tool'],['knowledge.initial','tool'],['memory.search','tool'],['agents.delegate','delegation'],['sandbox.analyze','resource']] as const){expect(provider(name,kind)).toMatchObject({limit:1});expect(provider(name,kind).key.startsWith('provider:local:')).toBe(true);}
  expect(provider('model.generate','model').limit).toBe(10000);expect(provider('context.compact','compaction').limit).toBe(10000);expect(provider('tool').limit).toBe(10000);
  const connected=provider('tool');expect(connected.key.startsWith('provider:connected:')).toBe(true);
  expect(operationCapacity(execution,{...input,name:'tool'},{...environment,AGENTS_PROVIDER_ACCOUNT_MAP_JSON:'{"connection":"another-account"}'}).request.buckets.find(bucket=>bucket.key.startsWith('provider:'))!.key).not.toBe(connected.key);
  const fallback=operationCapacity(execution,input,{AGENTS_SCHEDULING_POLICY_JSON:'{"providerActive":7}'}).request.buckets.find(bucket=>bucket.key.startsWith('provider:'))!;
  expect(fallback.limit).toBe(7);expect(schedulingPolicyFromEnvironment({}).providerActive).toBe(128);expect(schedulingPolicyFromEnvironment({}).localProviderActive).toBeUndefined();
  expect(schedulingPolicyFromEnvironment({AGENTS_SCHEDULING_POLICY_JSON:'{"localProviderActive":100000}'}).localProviderActive).toBe(100000);
 });
});
