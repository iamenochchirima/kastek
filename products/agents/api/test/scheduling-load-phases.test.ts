import {describe,it,expect} from 'vitest';
import {dispatcherPhases} from '../src/contracts/execution';
import {dispatcherPhaseTimings} from './scheduling-load-phases';
import {sqlFamily} from './scheduling-load-profile';
import {claimDispatchBatch} from '../src/execution/scheduling/dispatch-claims';
describe('bounded dispatcher fixture phase metadata',()=>{
 it('retains all five finite phase names with bounded duration bins and separate phase errors',()=>{
  const stats=dispatcherPhaseTimings();for(let n=1;n<=100;n++)stats.observe('capacity',n,n!==100);
  stats.observe('dispatch',55000,false);const snapshot=stats.snapshot();expect(snapshot.phases.map(row=>row.phase)).toEqual([...dispatcherPhases]);
  expect(snapshot.phases.find(row=>row.phase==='capacity')).toEqual({phase:'capacity',count:100,errors:1,totalMs:5050,maxMs:100,p95UpperBoundMs:100});
  expect(snapshot.phases.find(row=>row.phase==='dispatch')).toMatchObject({count:1,errors:1,maxMs:55000,p95UpperBoundMs:60000});expect(snapshot.phases.find(row=>row.phase==='controls')).toMatchObject({count:0,p95UpperBoundMs:null});
 });
 it('rejects arbitrary phase labels and invalid measurements without storing input',()=>{
  const stats=dispatcherPhaseTimings();for(const value of [NaN,Infinity,-1])stats.observe('capacity',value,true);stats.observe('PRIVATE_PROMPT' as any,1,true);stats.observe('dispatch',1,'bad' as any);
  expect(stats.snapshot().invalidSamples).toBe(5);expect(stats.snapshot().phases.every(row=>row.count===0)).toBe(true);expect(JSON.stringify(stats.snapshot())).not.toMatch(/PRIVATE_PROMPT|bad/);
  stats.observe('reconciliation',70000,true);expect(stats.snapshot().phases.find(row=>row.phase==='reconciliation')).toMatchObject({count:1,p95UpperBoundMs:null});
 });
 it('snapshots are cumulative bounded summaries and cannot mutate future statistics',()=>{
  const stats=dispatcherPhaseTimings();stats.observe('controls',2,true);const before=stats.snapshot();before.phases[0].count=999;
  for(let n=0;n<10000;n++)stats.observe('controls',2,true);const after=stats.snapshot();expect(after.phases[0].count).toBe(0);expect(after.phases.find(row=>row.phase==='controls')?.count).toBe(10001);expect(JSON.stringify(after).length).toBeLessThan(1200);
 });
 it('classifies the actual fair dispatch SQL independently from terminal cleanup',async()=>{
  const queries:string[]=[];const pool={query:async(sql:string)=>{queries.push(sql);return{rows:[]};}};
  await claimDispatchBatch(pool as any);expect(sqlFamily(queries[0])).toBe('dispatch-fair-claim');
  expect(sqlFamily(`WITH terminal AS (SELECT o.task_id FROM agents_platform.task_outbox o)
   UPDATE agents_platform.task_outbox o SET dispatched_at=now(),lease_owner=NULL FROM terminal t WHERE t.task_id=o.task_id`)).toBe('dispatch-terminal-cleanup');
 });
});
