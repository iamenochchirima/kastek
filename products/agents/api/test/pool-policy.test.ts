import {describe,it,expect} from 'vitest';
import {poolPolicyFromEnvironment,databasePoolOptions} from '../src/infrastructure/pool-policy';
describe('replica database budgets',()=>{
 it('accounts every declared process and rejects oversubscription',()=>{
  expect(databasePoolOptions('api',{}).max).toBe(10);
  expect(()=>poolPolicyFromEnvironment({AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify({api:{replicas:10,max:10}})})).toThrowError();
  expect(()=>databasePoolOptions('dispatcher',{})).toThrowError();
  const configured={total:60,api:{replicas:2,max:8},worker:{replicas:2,max:8}};
  expect(poolPolicyFromEnvironment({AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify(configured)}).worker.replicas).toBe(2);
 });
});
