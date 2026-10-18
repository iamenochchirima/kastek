import {describe,it,expect} from 'vitest';
import {poolPolicyFromEnvironment,databasePoolOptions} from '../src/infrastructure/pool-policy';
describe('replica database budgets',()=>{
 it('bounds trusted acquisition waits without changing SQL deadlines or connection counts',()=>{
  const environment={AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify({acquireTimeoutMs:60000})};
  expect(databasePoolOptions('worker',environment)).toMatchObject({max:10,connectionTimeoutMillis:60000,statement_timeout:15000,query_timeout:20000});
  expect(databasePoolOptions('worker',{}).connectionTimeoutMillis).toBe(5000);
  for(const acquireTimeoutMs of [0,99,120001,Infinity])expect(()=>poolPolicyFromEnvironment({AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify({acquireTimeoutMs})})).toThrow();
 });
 it('accounts every declared process and rejects oversubscription',()=>{
  expect(databasePoolOptions('api',{}).max).toBe(10);
  expect(()=>poolPolicyFromEnvironment({AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify({api:{replicas:10,max:10}})})).toThrowError();
  expect(()=>databasePoolOptions('dispatcher',{})).toThrowError();
  const configured={total:60,api:{replicas:2,max:8},worker:{replicas:2,max:8}};
  expect(poolPolicyFromEnvironment({AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify(configured)}).worker.replicas).toBe(2);
 });
});
