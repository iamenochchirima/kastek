import {describe,it,expect} from 'vitest';
import {loadResourceProfile} from './scheduling-load-resources';
import {databasePoolOptions,poolPolicySchema} from '../src/infrastructure/pool-policy';
describe('finite controlled fixture resource profiles',()=>{
 it('preserves the existing four-replica baseline and exact actual connection accounting',()=>{
  const profile=loadResourceProfile(undefined,10000,4);expect(profile.profile).toBe('baseline');expect(profile).not.toHaveProperty('localProviderActive');
  expect(profile.poolPolicy).toMatchObject({total:60,reserve:5,acquireTimeoutMs:60000,api:{replicas:4,max:3},worker:{replicas:4,max:8}});
  expect(profile.connections).toEqual({apiMax:12,workerMax:32,fixtureDriverAndSnapshotMax:8,fixtureAdminMax:1,physicalMax:53,reserve:5,physicalWithReserve:58,managedAllocation:58,conservativeManagedPlusSeparateFixture:67,total:60,evaluationProcesses:0,migrationProcesses:0,snapshotUsesDriverPool:true});
 });
 it('uses an explicit local64 bound with actual65 plusreserve5 and conservative79 within80',()=>{
  const profile=loadResourceProfile('bounded-local',10000,4);expect(profile.localProviderActive).toBe(64);expect(profile.apiPool).toBe(6);expect(profile.workerPool).toBe(8);expect(profile.connections).toMatchObject({physicalMax:65,physicalWithReserve:70,managedAllocation:70,conservativeManagedPlusSeparateFixture:79,total:80});
  const env={AGENTS_DATABASE_POOL_POLICY_JSON:JSON.stringify(profile.poolPolicy)};expect(databasePoolOptions('api',env).max).toBe(6);expect(databasePoolOptions('worker',env).max).toBe(8);expect(databasePoolOptions('api',env).connectionTimeoutMillis).toBe(60000);
 });
 it('keeps the two-replica1k API and worker pools unchanged and counts the shared snapshot only once',()=>{
  const baseline=loadResourceProfile('baseline',1000,2),bounded=loadResourceProfile('bounded-local',1000,2);expect(baseline.apiPool).toBe(8);expect(bounded.apiPool).toBe(8);expect(bounded.workerPool).toBe(8);expect(bounded.poolPolicy.acquireTimeoutMs).toBe(5000);
  expect(bounded.connections).toMatchObject({physicalMax:41,physicalWithReserve:46,managedAllocation:46,conservativeManagedPlusSeparateFixture:55,total:80,fixtureDriverAndSnapshotMax:8});
 });
 it('rejects unknown profiles and unapproved dimensions before provisioning any service',()=>{
  for(const value of ['','BOUNDED-LOCAL','unlimited','PRIVATE'])expect(()=>loadResourceProfile(value,10000,4)).toThrow('Unknown controlled load resource profile');
  for(const [roots,replicas]of [[1,4],[10000,16],[NaN,4],[1000,0]])expect(()=>loadResourceProfile('bounded-local',roots,replicas)).toThrow('Invalid staged fixture resource dimensions');
 });
 it('validates every finite supported combination and refuses an overcommitted operator pool policy',()=>{
  for(const name of ['baseline','bounded-local'])for(const roots of [100,1000,10000])for(const replicas of [1,2,4,8]){const profile=loadResourceProfile(name,roots,replicas);expect(profile.connections.physicalWithReserve).toBeLessThanOrEqual(profile.poolPolicy.total);expect(poolPolicySchema.safeParse(profile.poolPolicy).success).toBe(true);}
  const profile=loadResourceProfile('bounded-local',10000,4);expect(poolPolicySchema.safeParse({...profile.poolPolicy,total:69}).success).toBe(false);
 });
});
