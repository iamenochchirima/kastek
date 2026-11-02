/** Bounded fixture metadata; a resolved phase is not a successful task or provider outcome. */
import {dispatcherPhases,type DispatcherPhase} from '../src/contracts/execution';
const bounds=[1,5,10,20,50,100,250,500,1000,2500,5000,10000,30000,60000,Infinity];
export function dispatcherPhaseTimings(){
 const rows=new Map(dispatcherPhases.map(phase=>[phase,{phase,count:0,errors:0,totalMs:0,maxMs:0,histogram:bounds.map(()=>0)}]));let invalidSamples=0;
 return{observe(phase:DispatcherPhase,durationMs:number,success:boolean){
  const row=rows.get(phase);if(!row||!Number.isFinite(durationMs)||durationMs<0||typeof success!=='boolean'){invalidSamples++;return;}
  row.count++;row.errors+=success?0:1;row.totalMs+=durationMs;row.maxMs=Math.max(row.maxMs,durationMs);row.histogram[bounds.findIndex(bound=>durationMs<=bound)]++;
 },snapshot(){return{version:'dispatcher-phase-fixture.v1',invalidSamples,phases:[...rows.values()].map(row=>{let seen=0;const p95Index=row.count?row.histogram.findIndex(count=>(seen+=count)>=Math.ceil(row.count*.95)):-1;
  return{phase:row.phase,count:row.count,errors:row.errors,totalMs:Math.round(row.totalMs),maxMs:Math.round(row.maxMs),p95UpperBoundMs:p95Index>=0&&Number.isFinite(bounds[p95Index])?bounds[p95Index]:null};})};}};
}
