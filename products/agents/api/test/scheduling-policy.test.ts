import {describe,it,expect} from "vitest";
import {operationCapacity,schedulingPolicyFromEnvironment} from "../src/execution/scheduling/policy";
import type {Execution} from "../src/contracts/execution";
describe('trusted scheduling policy',()=>{
 it('rejects unbounded, unknown and malformed operator limits',()=>{
  for(const value of [{maxConcurrentRoots:100001},{modelActive:0},{maxWaitMs:Infinity},{unknown:1}])expect(()=>schedulingPolicyFromEnvironment({AGENTS_SCHEDULING_POLICY_JSON:JSON.stringify(value)})).toThrowError();
  expect(schedulingPolicyFromEnvironment({AGENTS_SCHEDULING_POLICY_JSON:JSON.stringify({maxConcurrentRoots:10000,dailyTokenAllowance:1000000000})}).maxConcurrentRoots).toBe(10000);
 });
 it('uses accepted trial/principal and pinned connections rather than request-supplied workload/account',()=>{
  const execution={task:{id:'task',product:'agents',organization_id:'tenant',evaluation_trial_id:'trial',principal:{kind:'human'}},connectedBindings:[{id:'binding',alias:'tool',connection:{id:'connection'}}]} as unknown as Execution;
  const input={id:'op',kind:'tool' as const,name:'tool',request:{workload:'interactive',account:'attacker'},reservedTokens:0,reservedMs:1000};
  const {request}=operationCapacity(execution,input,{AGENTS_PROVIDER_ACCOUNT_MAP_JSON:JSON.stringify({connection:'verified-account'})});
  expect(request.workload).toBe('evaluation');expect(request.buckets.some(bucket=>bucket.key.includes('attacker'))).toBe(false);
  expect(()=>operationCapacity(execution,{...input,kind:'model'},{NODE_ENV:'production'})).toThrowError();
 });
});
