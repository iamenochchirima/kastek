import {poolPolicySchema} from '../src/infrastructure/pool-policy';
/** Finite fixture allocations. Evaluation/migration are budget slots, not extra fixture processes. */
export function loadResourceProfile(name:string|undefined,roots:number,replicas:number){
 const profile=name??'baseline';if(!['baseline','bounded-local'].includes(profile))throw Error('Unknown controlled load resource profile');
 if(![100,1000,10000].includes(roots)||![1,2,4,8].includes(replicas))throw Error('Invalid staged fixture resource dimensions');
 const bounded=profile==='bounded-local',large=roots===10000;
 const apiPool=replicas===8?1:replicas===4?(bounded?6:3):large?4:8,workerPool=replicas===8?4:replicas===4?8:large?16:8;
 const poolPolicy=poolPolicySchema.parse({total:bounded?80:60,acquireTimeoutMs:large?60000:5000,api:{replicas,max:apiPool},worker:{replicas,max:workerPool},cleanup:{replicas:0,max:2},evaluation:{replicas:1,max:8},migration:{replicas:1,max:1}});
 const fixtureDriverAndSnapshotMax=8,fixtureAdminMax=1,apiMax=replicas*apiPool,workerMax=replicas*workerPool;
 const physicalMax=apiMax+workerMax+fixtureDriverAndSnapshotMax+fixtureAdminMax,physicalWithReserve=physicalMax+poolPolicy.reserve;
 const managedAllocation=apiMax+workerMax+poolPolicy.evaluation.max+poolPolicy.migration.max+poolPolicy.reserve;
 const conservativeManagedPlusSeparateFixture=managedAllocation+fixtureDriverAndSnapshotMax+fixtureAdminMax;
 if(physicalWithReserve>poolPolicy.total||managedAllocation>poolPolicy.total||bounded&&conservativeManagedPlusSeparateFixture>poolPolicy.total)throw Error('Controlled fixture database budget exceeded');
 return{profile,apiPool,workerPool,poolPolicy,...bounded?{localProviderActive:64}:{},connections:{apiMax,workerMax,fixtureDriverAndSnapshotMax,fixtureAdminMax,physicalMax,reserve:poolPolicy.reserve,physicalWithReserve,managedAllocation,conservativeManagedPlusSeparateFixture,total:poolPolicy.total,evaluationProcesses:0,migrationProcesses:0,snapshotUsesDriverPool:true}};
}
