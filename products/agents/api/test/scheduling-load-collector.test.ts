import {describe,it,expect,vi} from 'vitest';
import {collectorMetadata,observeCollectorEvidence} from './scheduling-load-collector';
describe('bounded actual Collector metadata capture',()=>{
 it('retains metric names before span flood, parses chunk boundaries and flags metadata truncation',()=>{
  const capture=collectorMetadata('fixture-secret',1),task='00000000-0000-0000-0000-000000000001';
  capture.ingest('     -> Name: agents.pool.connections\n');
  const block=(n:number)=>`Span #${n}\n    Trace ID : ${'a'.repeat(32)}\n    ID : ${String(n).padStart(16,'0')}\n    Name : model.completed\n -> agents.observation_id: Str(${'a'.repeat(63)}${n})\n -> agents.event_key: Str(result:model:${n})\n -> agents.taskId: Str(${task})\n -> agents.rootTaskId: Str(${task})\n -> ignored.private: Str(do not retain this raw value)\n`;
  const data=block(1)+block(2);capture.ingest(data.slice(0,80));capture.ingest(data.slice(80));const result=capture.snapshot();
  expect(result.metricNames).toEqual(['agents.pool.connections']);expect(result.spans).toHaveLength(1);expect(result.spans[0]).toMatchObject({name:'model.completed',taskId:task,eventKey:'result:model:1'});expect(result.metadataTruncated).toBe(true);expect(JSON.stringify(result)).not.toContain('do not retain');
 });
 it('detects private canaries split across input chunks without persisting raw output',()=>{
  const capture=collectorMetadata('fixture-secret');capture.ingest('CONTROLLED_PRIVATE_');capture.ingest('CANARY\n');const result=capture.snapshot();expect(result.privateContentLeaked).toBe(true);expect(JSON.stringify(result)).not.toContain('CONTROLLED_PRIVATE_CANARY');
 });
 it('detects split canaries and secrets despite interleaved output streams',()=>{
  for(const value of ['CONTROLLED_PRIVATE_CANARY','fixture-secret'])for(const stream of ['stdout','stderr'] as const){
   const capture=collectorMetadata('fixture-secret'),other=stream==='stdout'?'stderr':'stdout',split=Math.floor(value.length/2);
   capture.ingest(value.slice(0,split),stream);capture.ingest('unrelated output\n',other);capture.ingest(value.slice(split)+'\n',stream);
   const result=capture.snapshot();expect(result.privateContentLeaked).toBe(true);expect(JSON.stringify(result)).not.toContain(value);
  }
 });
});

describe('bounded post-measurement Collector observation',()=>{
 it('waits for the actual periodic batch without changing its interval',async()=>{
  vi.useFakeTimers();try{let metrics=false;setTimeout(()=>{metrics=true;},15000);
   const pending=observeCollectorEvidence(()=>({spans:['actual span metadata'],metricNames:metrics?['agents.tasks']:[]}),()=>false);
   await vi.advanceTimersByTimeAsync(15000);const result=await pending;expect(result.evidenceWaitMs).toBe(15000);expect(result.captured.metricNames).toEqual(['agents.tasks']);
  }finally{vi.useRealTimers();}
 });
 it('keeps missing metrics missing when the finite observation deadline expires',async()=>{
  vi.useFakeTimers();try{const pending=observeCollectorEvidence(()=>({spans:['actual span metadata'],metricNames:[]}),()=>false);
   await vi.advanceTimersByTimeAsync(20000);const result=await pending;expect(result.evidenceWaitMs).toBe(20000);expect(result.captured.metricNames).toEqual([]);
  }finally{vi.useRealTimers();}
 });
 it('stops immediately on capture failure without fabricating telemetry',async()=>{
  const result=await observeCollectorEvidence(()=>({spans:[],metricNames:[]}),()=>true);expect(result.evidenceWaitMs).toBeLessThan(100);expect(result.captured).toEqual({spans:[],metricNames:[]});
 });
});
